// /api/estimate.js
import OpenAI from "openai";
import { put } from "@vercel/blob";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SERVICEABLE_ZIPS = (process.env.ALLOWED_ZIPS || "06268,06269,06250,06238,06084,06279,06278,06226,06235,06280,06237,06232,06076,06029,06066,06043,06266,06256,06264")
  .split(",").map(z => z.trim());
const SURCHARGED_ZIPS = (process.env.SURCHARGED_ZIPS || "06084,06266,06043,06232,06066,06238")
  .split(",").map(z => z.trim());

const SYSTEM_PROMPT = `<<PASTE YOUR FULL PROMPT HERE EXACTLY AS PROVIDED>>`; // keep identical

function isServiceable(zip){ return SERVICEABLE_ZIPS.includes(zip); }

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const { zip, description = "", image_urls = [] } = req.body || {};
    if (!zip || !/^\d{5}$/.test(zip)) return res.status(400).json({ error: "Invalid zip" });
    if (!Array.isArray(image_urls) || image_urls.length === 0) {
      return res.status(400).json({ error: "No images provided" });
    }

    if (!isServiceable(zip)) {
      return res
        .status(422)
        .send("Thank you for your interest, but we are not currently servicing your area at this time.");
    }

    const userParts = [{ type: "text", text: `zip: ${zip}\ndescription: ${description || "(none)"}` }];
    for (const url of image_urls) userParts.push({ type: "image_url", image_url: { url } });

    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userParts }
      ]
    });

    const raw = response.choices?.[0]?.message?.content || "";

    if (/^Thank you for your interest, but we are not currently servicing your area at this time\./.test(raw.trim())) {
      return res
        .status(422)
        .send("Thank you for your interest, but we are not currently servicing your area at this time.");
    }

    const lines = raw.split(/\r?\n/).filter(Boolean);
    const firstLine = lines[0] || "";
    const jsonTextIndex = raw.indexOf("{");
    const jsonText = jsonTextIndex >= 0 ? raw.slice(jsonTextIndex).trim() : "";
    let parsed = null;
    try { parsed = JSON.parse(jsonText); } catch {}

    const htmlLine = firstLine.replace(/^\*\*(.+)\*\*$/, "<strong>$1</strong>");

    // ===== Save result JSON to Blob =====
    const now = new Date();
    const dateStamp = now.toISOString().slice(0,10);
    const ts = now.toISOString().replace(/[:.]/g, "-");
    const safeZip = String(zip);
    const resultKey = `results/${dateStamp}/${safeZip}-${ts}.json`;

    const record = {
      created_at: now.toISOString(),
      zip: safeZip,
      image_count: Array.isArray(image_urls) ? image_urls.length : 0,
      quote_line: htmlLine.replace(/<[^>]+>/g,""),
      result: parsed ?? null
    };

    let stored = null;
    try {
      stored = await put(resultKey, JSON.stringify(record, null, 2), {
        access: "public",
        contentType: "application/json",
        token: process.env.BLOB_READ_WRITE_TOKEN
      });
    } catch (e) {
      console.warn("Blob save failed", e);
    }

    return res.status(200).json({
      line: htmlLine,
      json: parsed ?? { parse_error: true, raw },
      stored_url: stored?.url || null,
      key: stored?.pathname || resultKey
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Estimator failed" });
  }
}
