import type { ServerResponse } from "http";

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
    const url = new URL(req.url, `http://${req.headers.host}`);
    const blobUrl = url.searchParams.get("url");
    if (!blobUrl) {
      res.statusCode = 400;
      return res.end("Missing url");
    }
    const r = await fetch(blobUrl);
    const txt = await r.text();
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.statusCode = 200;
    res.end(txt);
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: "GET_FAILED" }));
  }
}

