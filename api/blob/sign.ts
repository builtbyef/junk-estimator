import type { IncomingMessage, ServerResponse } from "http";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import LRUCache from "lru-cache";

/** ---------- Config ---------- */
// Allowed origins for CORS. When ALLOWED_ORIGINS is unset, requests from any
// origin are permitted. In production, specify a comma-separated list to lock
// this down.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const MAX_FILES = Number(process.env.MAX_FILES || 12);
// Server enforces a hard limit on how many files can be uploaded per batch.
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 12);
const MAX_TOTAL_MB = Number(process.env.MAX_TOTAL_MB || 60);

const RATE_MAX = 5; // requests
const RATE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

/** ---------- Helpers ---------- */
function getIP(req: IncomingMessage) {
  const xf = (req.headers["x-forwarded-for"] as string) || "";
  return (xf.split(",")[0] || req.socket.remoteAddress || "unknown").trim();
}

function setCors(res: ServerResponse, origin?: string) {
  if (allowedOrigins.length === 0) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  } else if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );
}

const rateCache = new LRUCache<string, number[]>({ max: 5000 });
// Track how many files have been uploaded for each client-provided batch ID
const batchCounts = new LRUCache<string, number>({ max: 5000, ttl: RATE_WINDOW_MS });

function rateLimit(ip: string) {
  const now = Date.now();
  const arr = (rateCache.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) return false;
  arr.push(now);
  rateCache.set(ip, arr);
  return true;
}

/** ---------- Handler ---------- */
export default async function handler(req: any, res: any) {
  const origin = req.headers.origin as string | undefined;
  setCors(res, origin);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end("Method Not Allowed");
  }

  if (
    allowedOrigins.length > 0 && (!origin || !allowedOrigins.includes(origin))
  ) {
    res.statusCode = 403;
    return res.end("Forbidden");
  }

  const ip = getIP(req);
  if (!rateLimit(ip)) {
    res.statusCode = 429;
    return res.end(
      "We couldn’t process your request right now. Please try again in a few minutes."
    );
  }

  try {
    const body = (await readJson(req)) as HandleUploadBody;

    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname: string, clientPayload: string | null) => {
        // Client passes size/type/aggregate via clientPayload. Server now enforces
        // per-batch file counts in addition to size limits.
        let meta: { size?: number; batchTotal?: number; type?: string; batchId?: string } = {};
        try {
          if (clientPayload) meta = JSON.parse(clientPayload);
        } catch {}
        const sizeMB = meta.size ? meta.size / (1024 * 1024) : 0;
        const totalMB = meta.batchTotal ? meta.batchTotal / (1024 * 1024) : 0;

        if (sizeMB > MAX_FILE_MB) throw new Error(`File exceeds ${MAX_FILE_MB} MB`);
        if (totalMB > MAX_TOTAL_MB) throw new Error(`Batch exceeds ${MAX_TOTAL_MB} MB`);

        const batchId = meta.batchId || "";
        if (batchId) {
          const count = (batchCounts.get(batchId) || 0) + 1;
          batchCounts.set(batchId, count);
          if (count > MAX_FILES) throw new Error(`Batch exceeds ${MAX_FILES} files`);
        }

        // Allow only common image types
        const allowedContentTypes = ["image/jpeg", "image/png", "image/webp"];

        // Normalize path to uploads/yyyy-mm/
        const now = new Date();
        const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
        const safeName = pathname.split("/").pop() || `upload-${Date.now()}.jpg`;
        const finalPathname = `uploads/${ym}/${safeName}`;

        return {
          allowedContentTypes,
          addRandomSuffix: true,
          pathname: finalPathname,
          tokenPayload: JSON.stringify({
            ip,
            ua: req.headers["user-agent"] || "",
            batchId: batchId,
          }),
        };
      },
      // Light audit log only
      onUploadCompleted: async ({ blob }) => {
        console.log(
          JSON.stringify({
            at: new Date().toISOString(),
            evt: "blob.upload.completed",
            path: blob.pathname,
            size: blob.size,
            type: blob.contentType,
          })
        );
      },
    });

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.statusCode = 200;
    res.end(JSON.stringify(jsonResponse));
  } catch (err: any) {
    console.error("sign error", err);
    res.statusCode = 400;
    const message =
      err instanceof Error && /exceeds/i.test(err.message)
        ? err.message
        : "We couldn’t process your request right now. Please try again in a few minutes.";
    res.end(
      JSON.stringify({
        error: "UPLOAD_SIGN_FAILED",
        message,
      })
    );
  }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

