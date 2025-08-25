import type { IncomingMessage, ServerResponse } from "http";
import OpenAI from "openai";
import { z } from "zod";
import { estimatorSystemPrompt } from "../lib/estimatorPrompt.js";
import { v4 as uuidv4 } from "uuid";
import dayjs from "dayjs";
import LRUCache from "lru-cache";
import { put } from "@vercel/blob";

/** ---------- Config ---------- */
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const FALLBACK_LINE =
  process.env.FALLBACK_CUSTOMER_LINE ||
  "Sorry—we couldn't generate a quote right now. Please text 860-207-5259 with your message and photos for a fast manual quote.";

const MAX_FILES = Number(process.env.MAX_FILES || 12);
const RATE_MAX = 5;
const RATE_WINDOW_MS = 10 * 60 * 1000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/** ---------- Validation ---------- */
const BodySchema = z.object({
  zip: z.string().trim().min(5).max(10),
  description: z.string().trim().min(3).max(5000),
  image_urls: z.array(z.string().url()).max(MAX_FILES),
});

type RequestBody = z.infer<typeof BodySchema>;

/** ---------- Helpers ---------- */
function setCors(res: ServerResponse, origin?: string) {
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );
}

function getIP(req: IncomingMessage) {
  const xf = (req.headers["x-forwarded-for"] as string) || "";
  return (xf.split(",")[0] || req.socket.remoteAddress || "unknown").trim();
}

const rateCache = new LRUCache<string, number[]>({ max: 5000 });
function rateLimit(ip: string) {
  const now = Date.now();
  const arr = (rateCache.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) return false;
  arr.push(now);
  rateCache.set(ip, arr);
  return true;
}

async function readJson(req: IncomingMessage) {
  return await new Promise<any>((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function extractJsonLoose(text: string): any | null {
  // Try ```json``` fences first
  const fence = /```json([\s\S]*?)```/i.exec(text);
  const candidate = fence ? fence[1] : null;

  const raw =
    candidate ??
    (() => {
      const first = text.indexOf("{");
      const last = text.lastIndexOf("}");
      if (first !== -1 && last !== -1 && last > first) {
        return text.slice(first, last + 1);
      }
      return null;
    })();

  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // attempt to fix trailing commas
    try {
      return JSON.parse(raw.replace(/,\s*}/g, "}").replace(/,\s*]/g, "]"));
    } catch {
      return null;
    }
  }
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
  if (!origin || !allowedOrigins.includes(origin)) {
    res.statusCode = 403;
    return res.end("Forbidden");
  }

  const ip = getIP(req);
  if (!rateLimit(ip)) {
    res.statusCode = 429;
    return res.end(
      JSON.stringify({
        customer_line:
          "We couldn’t process your request right now. Please try again in a few minutes.",
      })
    );
  }

  try {
    const body = (await readJson(req)) as RequestBody;
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      res.statusCode = 400;
      return res.end(
        JSON.stringify({
          customer_line:
            "We couldn’t process your request right now. Please try again in a few minutes.",
          error: parsed.error.issues,
        })
      );
    }
    const { zip, description, image_urls } = parsed.data;

    // Build Responses API input
    const userParts: any[] = [
      { type: "input_text", text: `ZIP: ${zip}\n\nDescription:\n${description}` },
      ...image_urls.map((u) => ({ type: "input_image", image_url: { url: u } })),
    ];

    const aiStart = Date.now();
    const resp = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        { role: "system", content: estimatorSystemPrompt },
        { role: "user", content: userParts }
      ]
    });
    const aiMs = Date.now() - aiStart;

    // Extract text
    const text = (resp as any).output_text?.toString?.().trim?.() ?? "";
    let customer_line = (text.split("\n")[0] || FALLBACK_LINE).trim();

    // Parse JSON if present
    const parsedJson = extractJsonLoose(text);
    let serviceable =
      typeof parsedJson?.serviceable === "boolean"
        ? parsedJson.serviceable
        : !/outside/i.test(customer_line);

    // Compose record to store
    const id = uuidv4();
    const now = dayjs();
    const ym = now.format("YYYY-MM");
    const record = {
      id,
      ts: now.toISOString(),
      ip,
      zip,
      image_count: image_urls.length,
      serviceable,
      customer_line,
      model_text: text,
      data: parsedJson ?? {},
      request: { description, image_urls },
      timings: { ai_ms: aiMs }
    };

    // Store JSON
    const path = `estimates/${ym}/${id}.json`;
    const putRes = await put(path, JSON.stringify(record, null, 2), {
      access: "public",
      token: process.env.BLOB_READ_WRITE_TOKEN
    });

    // Minimal metadata log
    console.log(
      JSON.stringify({
        at: new Date().toISOString(),
        evt: "estimate.created",
        zip,
        image_count: image_urls.length,
        response_size: text.length,
        path: putRes.pathname
      })
    );

    // Friendly fallback if blank line
    if (!customer_line) customer_line = FALLBACK_LINE;

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.statusCode = 200;
    res.end(
      JSON.stringify({
        serviceable,
        customer_line,
        data: parsedJson ?? {},
      })
    );
  } catch (err: any) {
    console.error("estimate error", err);
    res.statusCode = 200;
    res.end(
      JSON.stringify({
        serviceable: true,
        customer_line: FALLBACK_LINE,
        data: {},
      })
    );
  }
}
