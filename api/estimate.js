// api/estimate.js — Vercel serverless function (Node 18+)
// RECEIVES: { description, images: [dataURL...], zip, stairs?, longCarry? }
// RETURNS:  { lowTotal, highTotal, estCubicYards, items[], notes, recommendedDuration }

export default async function handler(req, res) {
  // ---------- CORS (allow Squarespace to call this) ----------
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    req.headers['access-control-request-headers'] || 'Content-Type, Authorization'
  );
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  // ---------- Safety: make sure the OpenAI key exists ----------
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: 'Missing OPENAI_API_KEY on server' });
  }

  try {
    // ---------- Read and normalize the JSON body ----------
    let body = req.body;
    if (!body || typeof body === 'string') {
      try { body = JSON.parse(body || '{}'); } catch { body = {}; }
    }

    const description = (body.description || '').toString();
    const images = Array.isArray(body.images) ? body.images.slice(0, 10) : []; // up to 10 images
    const zip = (body.zip || '').toString();
    const stairs = Number(body.stairs || 0);         // 0,1,2...
    const longCarry = !!body.longCarry;              // true/false

    // ---------- PRICING RULES (edit these to match your pricing) ----------
    const ITEM_PRICE = {
      mattress: 95, box_spring: 65, sofa: 120, loveseat: 90, recliner: 85,
      dresser: 70, tv_flat: 60, tv_crt: 95, fridge: 135, freezer: 145,
      washer: 120, dryer: 110, treadmill: 130, elliptical: 140, rug_large: 65, bike: 50
    };
    const PER_CU_YD = { low: 85, high: 120 };  // target revenue per cubic yard
    const STAIRS_ADDER = 50;                   // per flight
    const LONG_CARRY_ADDER = 75;               // if >150 ft

    // ---------- 1) Ask OpenAI to identify items + estimate cubic yards ----------
    const systemPrompt = `
You are an estimator for a New England junk removal company.
From the user's description and photos:
1) Identify items with quantities (use keys: mattress, box_spring, sofa, loveseat, recliner, dresser, tv_flat, tv_crt, fridge, freezer, washer, dryer, treadmill, elliptical, rug_large, bike, other).
2) Estimate total volume in cubic yards (single number).
3) Add notes if fee items (mattresses, appliances/CRTs) appear.
Return ONLY valid JSON like:
{"items":[{"category":"sofa","qty":1},{"category":"mattress","qty":2}], "estCubicYards":7, "notes":""}
`.trim();

    // Build content for vision (text + images as data URLs)
    const content = [{ type: 'text', text: description || 'No description.' }];
    for (const dataUrl of images) {
      content.push({ type: 'input_image', image_url: dataUrl });
    }

    const oaRes = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',          // Vision-capable, low latency
        input: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content }
        ],
        response_format: { type: 'json_object' } // force JSON back
      })
    });

    if (!oaRes.ok) {
      const txt = await oaRes.text();
      throw new Error(`OpenAI error: ${txt}`);
    }

    const oaJson = await oaRes.json();
    const raw = oaJson.output_text || '';  // Responses API convenience field
    let parsed = { items: [], estCubicYards: 0, notes: '' };
    try { parsed = JSON.parse(raw); } catch { /* keep defaults */ }

    // ---------- 2) Price it: itemized + volume cross-check ----------
    let base = 0;
    for (const it of (parsed.items || [])) {
      const key = String(it.category || '').toLowerCase().replace(/\s+/g, '_');
      base += (ITEM_PRICE[key] || 0) * (Number(it.qty) || 1);
    }

    const yards = Math.max(0, Number(parsed.estCubicYards || 0));
    if (yards > 0) {
      const mid = (PER_CU_YD.low + PER_CU_YD.high) / 2;
      base = Math.max(base, Math.round(yards * mid));
    }

    let adders = 0;
    if (stairs > 0) adders += STAIRS_ADDER * stairs;
    if (longCarry)  adders += LONG_CARRY_ADDER;

    const subtotal = base + adders;
    const lowTotal  = Math.max(99, Math.round(subtotal * 0.88));
    const highTotal = Math.round(subtotal * 1.12);

    // ---------- 3) Simple time estimate → duration bucket ----------
    let onsiteMin = yards ? Math.round(yards * 14) : 60; // tune later
    onsiteMin += (stairs ? 10 : 0) + (longCarry ? 10 : 0);
    const recommendedDuration =
      onsiteMin <= 60 ? '60m' :
      onsiteMin <= 90 ? '90m' :
      onsiteMin <= 120 ? '120m' : '180m';

    // ---------- 4) Respond to your website ----------
    return res.status(200).json({
      items: parsed.items || [],
      notes: parsed.notes || '',
      estCubicYards: yards,
      lowTotal,
      highTotal,
      recommendedDuration,
      zip
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Estimator error' });
  }
}
