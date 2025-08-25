// Lightweight embed for Squarespace. Handles HEIC->JPEG (best effort), compression, Blob uploads, and /api/estimate call.
// No external bundler needed.

// ----- Config discovery (derive API base from this script's URL) -----
(function () {
  const cur = document.currentScript || (function() {
    const scripts = document.getElementsByTagName('script');
    return scripts[scripts.length - 1];
  })();
  const SCRIPT_ORIGIN = new URL(cur.src).origin;
  const API_SIGN_URL = `${SCRIPT_ORIGIN}/api/blob/sign`;
  const API_EST_URL = `${SCRIPT_ORIGIN}/api/estimate`;

  // ----- Helpers -----
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function ensureHeicLib() {
    if (window.heic2any) return true;
    try {
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = "https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js";
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
      return true;
    } catch {
      return false;
    }
  }

  function fileIsHeic(f) {
    return (
      f.type === "image/heic" ||
      f.type === "image/heif" ||
      /\.heic$/i.test(f.name) ||
      /\.heif$/i.test(f.name)
    );
  }

  async function convertHeicToJpeg(file) {
    const ok = await ensureHeicLib();
    if (!ok) throw new Error("HEIC conversion library failed to load");
    const blob = await window.heic2any({ blob: file, toType: "image/jpeg", quality: 0.9 });
    return new File([blob], file.name.replace(/\.(heic|heif)$/i, ".jpg"), { type: "image/jpeg" });
  }

  async function compressImage(file, maxW = 2000, quality = 0.82) {
    // Draw into canvas and export JPEG
    const img = await loadImage(URL.createObjectURL(file));
    const { width, height } = scaleDown(img.width, img.height, maxW);
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
    return new File([blob], file.name.replace(/\.[^.]+$/, ".jpg"), { type: "image/jpeg" });
  }

  function scaleDown(w, h, maxW) {
    if (w <= maxW) return { width: w, height: h };
    const r = maxW / w;
    return { width: Math.round(w * r), height: Math.round(h * r) };
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  async function uploadViaVercelBlobClient(file, batchId, batchTotal) {
    // Import ESM build of @vercel/blob/client at runtime (works on Squarespace)
    const mod = await import("https://esm.sh/@vercel/blob@0.24.1/client");
    const { upload } = mod;

    // The client library will call our /api/blob/sign route (handleUpload) to mint a token,
    // then PUT directly to Blob from the browser.
    const putRes = await upload(file.name, file, {
      access: "public",
      handleUploadUrl: API_SIGN_URL,
      clientPayload: JSON.stringify({
        size: file.size,
        batchTotal,
        type: file.type,
        batchId
      })
    });

    return putRes.url;
  }

  function bytesToMB(n) { return n / (1024 * 1024); }

  // ----- UI wiring -----
  document.addEventListener("DOMContentLoaded", () => {
    const form = document.getElementById("jrq-form");
    const msg = document.getElementById("jrq-msg");
    const lineEl = document.getElementById("jrq-line");
    const jsonEl = document.getElementById("jrq-json");
    const result = document.getElementById("jrq-result");

    form?.addEventListener("submit", async (e) => {
      e.preventDefault();
      msg.textContent = "Uploading photos and generating estimate…";
      result.style.display = "none";
      lineEl.textContent = "";
      jsonEl.textContent = "";

      const zip = document.getElementById("jrq-zip").value.trim();
      const description = document.getElementById("jrq-desc").value.trim();
      const files = Array.from(document.getElementById("jrq-files").files || []);

      try {
        if (!zip || !description) throw new Error("Please fill ZIP and description.");

        // Preprocess files: convert HEIC, then compress
        const MAX_FILES = Number(document.querySelector("meta[data-maxfiles]")?.content || 12);
        const MAX_FILE_MB = Number(document.querySelector("meta[data-maxfilemb]")?.content || 12);
        const MAX_TOTAL_MB = Number(document.querySelector("meta[data-maxtotalmb]")?.content || 60);

        if (files.length > MAX_FILES) throw new Error(`Please select up to ${MAX_FILES} photos.`);

        const processed = [];
        for (const f of files) {
          let cur = f;
          if (fileIsHeic(cur)) {
            try { cur = await convertHeicToJpeg(cur); }
            catch { throw new Error("HEIC photo detected—please upload JPG/PNG instead."); }
          }
          // Compress and normalize to JPEG
          cur = await compressImage(cur, 2000, 0.82);
          if (bytesToMB(cur.size) > MAX_FILE_MB) {
            throw new Error(`One file exceeds ${MAX_FILE_MB} MB after compression.`);
          }
          processed.push(cur);
        }

        const totalBytes = processed.reduce((a, f) => a + f.size, 0);
        if (bytesToMB(totalBytes) > MAX_TOTAL_MB) {
          throw new Error(`Total photos exceed ${MAX_TOTAL_MB} MB after compression.`);
        }

        // Upload files to Blob
        const batchId = String(Date.now());
        const urls = [];
        for (const p of processed) {
          const url = await uploadViaVercelBlobClient(p, batchId, totalBytes);
          urls.push(url);
        }

        // Call estimate API
        const r = await fetch(API_EST_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ zip, description, image_urls: urls })
        });

        const data = await r.json();
        lineEl.textContent = data.customer_line || "Estimate is ready.";
        jsonEl.textContent = JSON.stringify(data, null, 2);
        result.style.display = "block";
        msg.textContent = "";
      } catch (err) {
        console.error(err);
        msg.textContent =
          "Sorry—we couldn't generate a quote right now. Please text 860-207-5259 with your message and photos for a fast manual quote.";
      }
    });
  });
})();

