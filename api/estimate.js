// api/estimate.js — Vercel serverless function (Node 18+)
// INPUT  (JSON): { description, zip, images:[dataURL... <=10], service_mode?, dimensions?, materials?, access?, distance_miles? }
// OUTPUT (JSON): { one_liner, lowTotal, highTotal, currency:"USD", recommendedDuration, zip }

export default async function handler(req, res) {
  // --- CORS (allow Squarespace to call this endpoint) ---
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers',
    req.headers['access-control-request-headers'] || 'Content-Type, Authorization'
  );
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'Missing OPENAI_API_KEY on server' });
  }

  try {
    // --- Read & normalize body ---
    let body = req.body;
    if (!body || typeof body === 'string') {
      try { body = JSON.parse(body || '{}'); } catch { body = {}; }
    }
    const {
      description = '',
      zip = '',
      images = [],
      service_mode = null,     // "curbside" or "full-service" (optional)
      dimensions = null,       // { length_ft, width_ft, height_ft } or similar (optional)
      materials = null,        // e.g. ["household","wood"] (optional)
      access = null,           // e.g. { stairs:true, long_carry:true, extra_minutes:0 } (optional)
      distance_miles = null    // one-way miles from base (optional)
    } = body;

    const imgList = Array.isArray(images) ? images.slice(0, 10) : [];

    // --- YOUR PROMPT (exactly as provided) ---
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
2) If heavy material threshold met, use heavy per-yd³ pricing; else compute household price via per-yd rate, then snap up to the nearest bracket.
3) Estimate weight by material type (light household ~200–300 lb/yd³; C&D much heavier). Apply overage if above included.
4) Add distance and access adjustments. If only one bulky item, compare item flat vs volume and choose lower.
5) Output a SINGLE short customer-facing line summarizing service mode and what’s included, ENDING with an estimated RANGE about $75–$125 wide centered on your computed price.

Output format example (don’t add anything else): 
“Full-service removal, driveway to basement carry included and up to X lb disposal—Estimated range: $___–$___.”
    `.trim();

    // --- Build a structured "user" payload + photos for the model ---
    const userPayload = {
      base_zip: "06226",
      description,
      zip,
      service_mode,
      dimensions,
      materials,
      access,
      distance_miles,
      // You can add more fields later without changing the front end
    };

    const content = [
      { type: 'text', text: "INPUTS (JSON):\n" + JSON.stringify(userPayload, null, 2) }
    ];
    for (const dataUrl of imgList) {
      content.push({ type: 'input_image', image_url: dataUrl });
    }

    // --- Call OpenAI (Responses API) ---
    const aiRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',    // vision-capable & fast
        input: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content }
        ],
        // We want a single sentence, so plain text output is fine
      })
    });

    if (!aiRes.ok) {
      const t = await aiRes.text();
      throw new Error(`OpenAI error: ${t}`);
    }

    const aiJson = await aiRes.json();
    const one_liner =
      aiJson.output_text?.trim?.() ||
      aiJson.choices?.[0]?.message?.content?.trim?.() ||
      ""; // best-effort extraction across SDK shapes

    if (!one_liner) {
      return res.status(502).json({ error: 'AI returned empty response' });
    }

    // --- Parse the two dollar amounts from the sentence for UI range ---
    const { low, high } = extractDollarRange(one_liner);
    // Fallback (rare): create a +/- $50 window around any single number we found
    let lowTotal = low, highTotal = high;
    if (lowTotal == null && highTotal == null) {
      const mid = extractSingleAmount(one_liner);
      if (mid != null) { lowTotal = Math.max(99, mid - 50); highTotal = mid + 50; }
    }
    // Final fallback if nothing parsable:
    if (lowTotal == null || highTotal == null) {
      lowTotal = 149; highTotal = 229; // safe placeholder if parsing fails
    }
    // Clean ordering
    if (lowTotal > highTotal) [lowTotal, highTotal] = [highTotal, lowTotal];

    // --- Optional: rough duration guess to open the right booking length ---
    const recommendedDuration =
      highTotal <= 200 ? '60m' :
      highTotal <= 350 ? '90m' :
      highTotal <= 500 ? '120m' : '180m';

    // --- Return JSON for your page ---
    return res.status(200).json({
      one_liner,
      lowTotal: Math.round(lowTotal),
      highTotal: Math.round(highTotal),
      currency: 'USD',
      recommendedDuration,
      zip
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Estimator error' });
  }
}

/* ---------------- helpers ---------------- */
function extractDollarRange(text) {
  // Grab $ amounts like $95, $1,295, 1295 (with/without $ and commas)
  const re = /\$?\s*\d{2,5}(?:,\d{3})?(?:\.\d{2})?/g;
  const matches = (text.match(re) || []).map(cleanMoney).filter(n => n != null);
  if (matches.length >= 2) {
    const sorted = matches.sort((a,b)=>a-b);
    return { low: sorted[0], high: sorted[sorted.length-1] };
  }
  return { low: null, high: null };
}
function extractSingleAmount(text) {
  const re = /\$?\s*\d{2,5}(?:,\d{3})?(?:\.\d{2})?/;
  const m = text.match(re);
  return m ? cleanMoney(m[0]) : null;
}
function cleanMoney(s) {
  if (!s) return null;
  const n = Number(String(s).replace(/[^0-9.]/g,''));
  return Number.isFinite(n) ? Math.round(n) : null;
}
