// api/estimate.mjs
export const config = { runtime: "nodejs18.x" };

const OPENAI_ENDPOINT = "https://api.openai.com/v1/responses";
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini"; // text+vision capable; cost-effective

// ---- EDIT YOUR PRICING HERE ----
const PRICING = {
  currency: "USD",
  minimum_fee: 85,                // minimum to roll a truck
  base_per_cubic_yard: 60,        // general junk per cubic yard
  trailer: {                       // your 5x8x3 ft trailer ≈ 4.44 CY
    length_ft: 8, width_ft: 5, wall_ft: 3, capacity_cy: 4.44
  },
  heavy_materials: {              // per CY adders (weight/transfer fees)
    concrete: 100, brick: 80, dirt: 70, shingles: 90
  },
  item_flat_fees: {               // add per item (examples—edit freely)
    mattress: 80, box_spring: 60, refrigerator: 140, chest_freezer: 150,
    couch_small: 90, couch_large: 130, dresser: 60, tv_tube: 65, piano: 350
  },
  surcharges: {
    stairs_per_flight: 15,        // handling upstairs/downstairs
    long_carry_per_50ft: 10,      // from curb/drive
    disassembly_simple: 25,       // e.g., small furniture
    disassembly_heavy: 60,        // e.g., sheds/hot tubs (not demolition)
  },
  distance_zones: [               // OPTIONAL: quick ZIP zoning
    { name: "Zone 1", zip_prefixes: ["062", "063"], add: 0 },
    { name: "Zone 2", zip_prefixes: ["060", "064"], add: 25 },
    { name: "Zone 3", zip_prefixes: ["065", "066", "067"], add: 50 }
  ],
  taxes_pct: 0,                   // set if you tax service
  desired_range_width: 75         // aim to keep quotes within ~this spread
};
// ---- END PRICING ----

function corsHeaders(origin) {
  const allowList = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  const allowed = allowList.length === 0 ? "*" : (allowList.includes(origin) ? origin : allowList[0]);
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin"
  };
}

function json(res, status, body, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) }
  });
}

export default async function handler(req) {
  const origin = req.headers.get("origin") || "";

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return json(null, 405, { error: "Method not allowed" }, origin);
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return json(null, 400, { error: "Invalid JSON" }, origin);
  }

  const { zipcode, description, images } = payload || {};
  if (!zipcode || !/^\d{5}$/.test(String(zipcode))) {
    return json(null, 400, { error: "A valid 5-digit zipcode is required." }, origin);
  }
  if (!description || typeof description !== "string") {
    return json(null, 400, { error: "A description is required." }, origin);
  }
  if (!Array.isArray(images) || images.length === 0) {
    return json(null, 400, { error: "At least one photo is required." }, origin);
  }
  if (images.length > 6) {
    return json(null, 400, { error: "Please upload up to 6 photos." }, origin);
  }

  // Build a compact but strict system prompt and attach your pricing as JSON.
  const systemPrompt = `
You price junk removal jobs for a small business in New England. Use the PRICING JSON to estimate cubic yards from the description and photos, add fair surcharges, then output a SINGLE clean quote range customers can understand.

Rules:
- Prioritize cubic yard estimate from photos; cross-check with description.
- Add flat fees for listed items, and heavy material adders if present.
- Apply distance zone by zipcode prefix (best match).
- Respect minimum fee.
- Keep the range tight (about +/- ${(PRICING.desired_range_width/2)|0} around midpoint). If uncertainty is high, you may widen, but explain briefly in notes.
- NEVER show internal math to the customer; return structured JSON ONLY.

PRICING_JSON:
${JSON.stringify(PRICING)}
`.trim();

  // Compose Responses API input parts correctly (no 'text' type—use input_text/input_image).
  const input = [
    {
      role: "system",
      content: [{ type: "input_text", text: systemPrompt }]
    },
    {
      role: "user",
      content: [
        { type: "input_text", text: `ZIP: ${zipcode}\nDESCRIPTION:\n${description}` },
        // images are data URLs already (or external https URLs). The Responses API accepts full URLs.
        ...images.map(url => ({ type: "input_image", image_url: url }))
      ]
    }
  ];

  // Structured Outputs: force a predictable JSON schema.
  const responseFormat = {
    type: "json_schema",
    json_schema: {
      name: "junk_quote",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          low: { type: "integer", minimum: 0 },
          high: { type: "integer", minimum: 0 },
          midpoint: { type: "integer", minimum: 0 },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          yard_estimate: { type: "number", minimum: 0 },
          distance_zone: { type: "string" },
          line_items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                label: { type: "string" },
                qty: { type: "number" },
                unit: { type: "string" },
                subtotal: { type: "integer", minimum: 0 }
              },
              required: ["label", "subtotal"]
            }
          },
          notes: { type: "string" }
        },
        required: ["low", "high", "midpoint", "confidence", "yard_estimate", "line_items", "notes"]
      }
    }
  };

  try {
    const aiRes = await fetch(OPENAI_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        input,
        response_format: responseFormat,
        temperature: 0.2
      })
    });

    if (!aiRes.ok) {
      const err = await aiRes.text();
      return json(null, 502, { error: "OpenAI error", detail: err }, origin);
    }

    const data = await aiRes.json();

    // The Responses API returns either output_text or structured content.
    const raw =
      data.output_text ??
      data.output?.[0]?.content?.[0]?.text ??
      JSON.stringify(data);

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Fallback: try to extract JSON if wrapped in text.
      const m = raw.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : null;
    }
    if (!parsed) return json(null, 502, { error: "Failed to parse model output." }, origin);

    // Guarantee a single authoritative number up top on your site (we send the full object).
    return json(null, 200, { ok: true, quote: parsed }, origin);
  } catch (e) {
    return json(null, 500, { error: "Server error", detail: String(e) }, origin);
  }
}
