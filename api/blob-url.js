// /api/blob-url.js
import { createUploadUrl } from "@vercel/blob";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  try {
    const { filename = `upload-${Date.now()}`, contentType = "application/octet-stream" } = req.body || {};

    const { url: uploadUrl, id, downloadUrl } = await createUploadUrl({
      contentType,
      token: process.env.BLOB_READ_WRITE_TOKEN,
      access: "public",
      additionalHeaders: { "x-vercel-filename": filename }
    });

    return res.status(200).json({ uploadUrl, id, downloadUrl });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Failed to create upload URL" });
  }
}
