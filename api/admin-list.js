// /api/admin-list.js
import { list } from "@vercel/blob";

function authOk(req){
  const qToken = req.query?.token;
  const h = req.headers?.authorization || "";
  const bearer = h.startsWith("Bearer ") ? h.slice(7) : null;
  const tok = qToken || bearer;
  return tok && tok === process.env.ADMIN_TOKEN;
}

function parseKey(key){
  // results/YYYY-MM-DD/ZIP-2025-08-24T12-34-56-789Z.json
  const m = key.match(/^results\/(\d{4}-\d{2}-\d{2})\/(\d{5})-(.+)\.json$/);
  if(!m) return { date: null, zip: null, ts: null };
  return { date: m[1], zip: m[2], ts: m[3] };
}

export default async function handler(req, res){
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!authOk(req)) return res.status(401).json({ error: "Unauthorized" });

  try{
    const { limit = "50", cursor, date, zip } = req.query;
    const lim = Math.max(1, Math.min(200, parseInt(String(limit), 10) || 50));
    const prefix = "results/"; // we store all under results/

    const out = [];
    let next = cursor || undefined;
    // We’ll fetch pages until we gather <= limit matching items (or run out)
    while(out.length < lim){
      const resp = await list({ prefix, cursor: next, token: process.env.BLOB_READ_WRITE_TOKEN });
      for(const b of resp.blobs){
        const { pathname, url, uploadedAt, size } = b;
        const meta = parseKey(pathname);
        if(date && meta.date !== date) continue;
        if(zip && meta.zip !== zip) continue;
        out.push({ key: pathname, url, uploadedAt, size, date: meta.date, zip: meta.zip });
        if(out.length >= lim) { next = resp.cursor || null; break; }
      }
      if(!resp.cursor || out.length >= lim){ next = resp.cursor || null; break; }
      next = resp.cursor;
    }

    // newest first
    out.sort((a,b)=> new Date(b.uploadedAt) - new Date(a.uploadedAt));

    return res.status(200).json({ items: out, next_cursor: next || null });
  }catch(e){
    console.error(e);
    return res.status(500).json({ error: "Failed to list results" });
  }
}
