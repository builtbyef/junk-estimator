import type { IncomingMessage, ServerResponse } from "http";
import { list } from "@vercel/blob";
import dayjs from "dayjs";

/** Bearer token auth */
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

function unauthorized(res: ServerResponse) {
  res.statusCode = 401;
  res.setHeader("WWW-Authenticate", "Bearer");
  res.end("Unauthorized");
}

export default async function handler(req: any, res: any) {
  const auth = (req.headers.authorization as string) || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
    return unauthorized(res);
  }

  try {
    // Pull blobs for last 6 months, newest first
    const months = Array.from({ length: 6 }).map((_, i) =>
      dayjs().subtract(i, "month").format("YYYY-MM")
    );

    const blobs = (
      await Promise.all(
        months.map((m) => list({ prefix: `estimates/${m}/`, limit: 1000 }))
      )
    ).flatMap((r) => r.blobs);

    // Take newest ~200 by uploadedAt
    const sorted = blobs
      .filter((b) => b.pathname.endsWith(".json"))
      .sort(
        (a: any, b: any) =>
          new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime()
      )
      .slice(0, 200);

    // Fetch a small subset of fields from each JSON
    const out = await Promise.all(
      sorted.map(async (b) => {
        try {
          const r = await fetch(b.url);
          const j: any = await r.json();
          const finalRange =
            j?.data?.final_range ??
            j?.data?.price_range ??
            (j?.customer_line?.match(/\$[^\s]*/)?.[0] ?? "");
          return {
            path: b.pathname,
            url: b.url,
            uploadedAt: b.uploadedAt,
            zip: j?.zip ?? j?.request?.zip ?? "",
            loads_estimated: j?.data?.loads_estimated ?? null,
            detected_items_count:
              (Array.isArray(j?.data?.detected_items) && j.data.detected_items.length) || 0,
            final_range: finalRange || "",
            serviceable: Boolean(j?.serviceable),
          };
        } catch {
          return {
            path: b.pathname,
            url: b.url,
            uploadedAt: b.uploadedAt,
            zip: "",
            loads_estimated: null,
            detected_items_count: 0,
            final_range: "",
            serviceable: false,
          };
        }
      })
    );

    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.statusCode = 200;
    res.end(JSON.stringify(out));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "LIST_FAILED" }));
  }
}

