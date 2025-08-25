// api/estimate.js — Vercel Serverless Function (Node 18+ / 20+)
// INPUT (JSON): { description, zip, images:[dataURL... <=10], service_mode?, dimensions?, materials?, access?, distance_miles? }
// OUTPUT (JSON): { one_liner, lowTotal, highTotal, currency:"USD", recommendedDuration, zip, debug? }

const DEBUG = process.env.DEBUG === '1';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

export default async function handler(req, res) {
  // ---- CORS ----
  const origin = req.headers.origin || '';
  const allow =
    ALLOWED_ORIGINS.length === 0
      ? origin || '*'                          // allow caller when unset (dev-friendly)
      : ALLOWED_ORIGINS.includes(origin)
        ? origin
        : ALLOWED_ORIGINS[0];                  // fall back to first allowed origin

  res.setHeader('Access-Control-Allow-Origin', allow || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    // simple health check
    return res.status(200).json({ ok: true, msg: 'estimator up' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    // ---- Parse body ----
    let body = req.body;
    if (!body || typeof body === 'string') {
      try { body = JSON.parse(body || '{}'); } catch { body = {}; }
    }
    if (body.ping) return res.status(200).json({ ok: true, msg: 'pong' });

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: 'Missing OPENAI_API_KEY on server' });
    }

    const {
      description = '',
      zip = '',
      images = [],
      service_mode = null,   // "curbside" | "full-service" (optional)
      dimensions = null,     // { length_ft, width_ft, height_ft } (optional)
      materials = null,      // e.g., ["household","wood"] (optional)
      access = null,         // { stairs:true, long_carry:true, extra_minutes:0 } (optional)
      distance_miles = null  // one-way miles (optional)
    } = body;

    const imgList = Array.isArray(images) ? images.slice(0, 6) : []; // keep payload small

    // ---- Pricing/logic prompt ----
    const SYSTEM_PROMPT = `
You are an Eastern-CT junk-removal quoting assistant for a 5×8×3 ft trailer (≈4.5 yd³; each 1 ft of trailer length ≈0.56 yd³). Use the customer inputs (photos/notes, pile length×width×height in feet, materials, access, distance, items) to estimate yards³ and weight, then price using the schedule below. Be concise; output only one sentence ending with an estimated price RANGE about $75–$125 wide.

VOLUME PRICING (household/light junk; choose curbside or full-service):
- Curbside (driveway/garage edge): full 4.5 yd³ $425; 3.3 yd³ $335; 2.2 yd³ $225; 1.1 yd³ $115; min 0.7 yd³ $99.
- Full-service (we lift from anywhere): full 4.5 yd³ $495; 3.3 yd³ $385; 2.2 yd³ $265; 1.1 yd³ $135; min 0.7 yd³ $129.
- Shortcut rates if between brackets: ~ $95/yd³ curbside, $110/yd³ full-service; then snap to the nearest bracket above.

INCLUDED WEIGHT & Overage:
- Included: up to 0.5 ton (1,000 lb) per full trailer, scaled by fill (included_lb = 1000 × yards/4.5).
- If estimated weight > included, add $60 per extra 250 lb (0.125 ton).

HEAVY MATERIAL RATES (use these when materials are ≥50% of load or obviously dense):
- Mixed C&D: $125/yd³ (3 yd³ min).
- Asphalt shingles: $140/yd³.
- Soil/rock/concrete/brick: $175/yd³ (limit 1–2 yd³ per trip unless payload allows).

COMMON ITEM FLATS (use item price if it’s a single/small pickup and cheaper than volume):
- Mattress/box: $95 curbside / $115 full.
- Fridge/AC (freon): $65–$85.
- Sofa: $110–$145.
- Treadmill/safe/piano (awkward/heavy): $200–$350 (+stairs/carry if applicable).

SURCHARGES / DISCOUNTS:
- Access/time: +$20–$40 for stairs; +$20 for >50 ft carry; +$25 per extra 15 min beyond 20 min on-site.
- Distance: first 20 road miles included from base; then +$2.25 per one-way mile.
- Choose curbside pricing if customer stages at curb; otherwise full-service.

ESTIMATION LOGIC:
1) Estimate yards³ from photos/notes: if “feet of trailer filled” given, yards ≈ feet×0.56; else use L×W×H/27. Cap at 4.5 yd³ per trip.
2) If heavy material threshold met, use heavy per-yd³ pricing; else compute household price via per-yd rate, then snap to the nearest bracket.
3) Estimate weight by material type (light household ~200–300 lb/yd³; C&D much heavier). Apply overage if above included.
4) Add distance and access adjustments. If only one bulky item, compare item flat vs volume and choose lower.
5) Output a SINGLE short customer-facing line summarizing service mode and what’s included, ENDING with an estimated RANGE about $75–$125 wide centered on your computed price.

Output format example (don’t add anything else):
"Full-service removal, driveway to basement carry included and up to X lb disposal—Estimated range: $***–$***."
`.trim();

    // ---- Build user content (text + images) ----
    const userPayload = {
      base_zip: '06226',
      description, zip, service_mode, dimensions, materials, access, distance_miles
    };

    const userContent = [
      { type: 'text', text: "INPUTS (JSON):\n" + JSON.stringify(userPayload, null, 2) }
    ];
    for (const dataUrl of imgList) {
      if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) {
        // Chat Completions multimodal supports: { type:'image_url', image_url:{ url } }
        userContent.push({ type: 'image_url', image_url: { url: dataUrl } });
      }
    }

    // ---- Call OpenAI Chat Completions (multimodal) ----
    const aiRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: userContent }
        ],
        temperature: 0.2,
        max_tokens: 180
      })
    });

    if (!aiRes.ok) {
      const t = await aiRes.text();
      if (DEBUG) return res.status(aiRes.status || 502).json({ error: 'OpenAI error', details: t });
      throw new Error(`OpenAI ${aiRes.status}: ${t}`);
    }

    const aiJson = await aiRes.json();
    const one_liner = aiJson?.choices?.[0]?.message?.content?.trim?.() || '';
    if (!one_liner) {
      if (DEBUG) return res.status(502).json({ error: 'Empty model response', details: aiJson });
      throw new Error('Empty model response');
    }

    // ---- Extract $low–$high for UI (require the $ sign; prefer the final two amounts) ----
    const { low, high } = extractDollarRange(one_liner);
    let lowTotal = low, highTotal = high;

    if (lowTotal == null && highTotal == null) {
      const mid = extractSingleAmount(one_liner);
      if (mid != null) { lowTotal = Math.max(99, mid - 50); highTotal = mid + 50; }
    }
    if (lowTotal == null || highTotal == null) { lowTotal = 149; highTotal = 229; }
    if (lowTotal > highTotal) [lowTotal, highTotal] = [highTotal, lowTotal];

    const recommendedDuration =
      highTotal <= 200 ? '60m' :
      highTotal <= 350 ? '90m' :
      highTotal <= 500 ? '120m' : '180m';

    const payload = {
      one_liner,
      lowTotal: Math.round(lowTotal),
      highTotal: Math.round(highTotal),
      currency: 'USD',
      recommendedDuration,
      zip
    };
    if (DEBUG) payload.debug = { userPayload, tokenUsage: aiJson?.usage };

    return res.status(200).json(payload);

  } catch (err) {
    console.error(err);
    if (DEBUG) return res.status(500).json({ error: 'Estimator error', details: String(err?.message || err) });
    return res.status(500).json({ error: 'Estimator error' });
  }
}

/* -------- helpers (require $ sign; prefer the last two $ amounts) -------- */
const MONEY_RE = /\$\s*\d{1,3}(?:,\d{3})*(?:\.\d{2})?/g;

function extractDollarRange(text) {
  const amounts = (text.match(MONEY_RE) || []).map(cleanMoney).filter(n => n != null);
  if (amounts.length >= 2) {
    const pair = amounts.slice(-2);
    return { low: Math.min(pair[0], pair[1]), high: Math.max(pair[0], pair[1]) };
  }
  return { low: null, high: null };
}
function extractSingleAmount(text) {
  const m = text.match(MONEY_RE);
  return m && m[0] ? cleanMoney(m[0]) : null;
}
function cleanMoney(s) {
  const n = Number(String(s).replace(/[^0-9.]/g,''));
  return Number.isFinite(n) ? Math.round(n) : null;
}
