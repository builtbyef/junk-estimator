// /api/admin.js
export default async function handler(req, res){
  if (req.method !== "GET") return res.status(405).send("Method not allowed");

  // Token can be in ?token=... (the page will carry it in API calls)
  const token = (req.query?.token || "").toString();

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Estimator Admin</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    body{font-family: ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Arial,Helvetica,sans-serif;padding:20px;background:#f8fafc;color:#0f172a}
    .wrap{max-width:1100px;margin:0 auto}
    h1{font-size:22px;margin:0 0 10px}
    .controls{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}
    input,button,select{padding:8px 10px;border:1px solid #cbd5e1;border-radius:10px;background:#fff}
    button{cursor:pointer;background:#111;color:#fff;border-color:#111}
    button[disabled]{opacity:.5;cursor:not-allowed}
    table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden}
    th,td{padding:10px;border-bottom:1px solid #e2e8f0;font-size:14px;text-align:left}
    tr:hover{background:#f1f5f9}
    .grid{display:grid;grid-template-columns:1.1fr 0.9fr;gap:16px;margin-top:16px}
    pre{background:#0b1220;color:#e5e7eb;padding:12px;border-radius:10px;white-space:pre-wrap;word-break:break-word;font-size:12px}
    .muted{color:#64748b}
    .link{color:#0ea5e9;text-decoration:none}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Estimator Admin</h1>
    <div class="controls">
      <label>Date <input type="date" id="f-date" /></label>
      <label>ZIP <input type="text" id="f-zip" placeholder="06268" pattern="\\d{5}" maxlength="5" /></label>
      <button id="btn-load">Load</button>
      <button id="btn-next" disabled>Next Page</button>
      <button id="btn-csv">Download CSV</button>
      <span class="muted" id="status"></span>
    </div>

    <div class="grid">
      <div>
        <table id="tbl">
          <thead>
            <tr>
              <th>Date</th>
              <th>ZIP</th>
              <th>Uploaded</th>
              <th>Size</th>
              <th>Link</th>
            </tr>
          </thead>
          <tbody></tbody>
        </table>
      </div>
      <div>
        <h3>Preview</h3>
        <pre id="preview">(select a row)</pre>
      </div>
    </div>
  </div>

<script>
(function(){
  const token = ${JSON.stringify(token)};
  const state = { cursor: null, rows: [] };
  const qs = (s)=>document.querySelector(s);
  const tbody = qs("#tbl tbody");
  const status = qs("#status");
  const btnLoad = qs("#btn-load");
  const btnNext = qs("#btn-next");
  const btnCSV = qs("#btn-csv");
  const fDate = qs("#f-date");
  const fZip = qs("#f-zip");
  const preview = qs("#preview");

  function setStatus(t=""){ status.textContent = t; }
  function fmtSz(n){ if(n<1024) return n+" B"; if(n<1024*1024) return (n/1024).toFixed(1)+" KB"; return (n/1024/1024).toFixed(1)+" MB"; }
  function fmtDT(s){ try{ return new Date(s).toLocaleString(); }catch(e){ return s; } }

  function buildURL(cursor){
    const u = new URL(location.origin + "/api/admin-list");
    if(token) u.searchParams.set("token", token);
    const d = fDate.value.trim();
    const z = fZip.value.trim();
    if(d) u.searchParams.set("date", d);
    if(z) u.searchParams.set("zip", z);
    u.searchParams.set("limit","50");
    if(cursor) u.searchParams.set("cursor", cursor);
    return u.toString();
  }

  async function load(cursor=null){
    setStatus("Loading…");
    btnLoad.disabled = true; btnNext.disabled = true;
    try{
      const url = buildURL(cursor);
      const res = await fetch(url, { headers: token ? { "Authorization": "Bearer "+token } : {} });
      if(!res.ok){ throw new Error("Auth failed or server error"); }
      const data = await res.json();
      state.cursor = data.next_cursor || null;
      if(!cursor) state.rows = [];
      state.rows = state.rows.concat(data.items || []);
      render();
      btnNext.disabled = !state.cursor;
      setStatus("Loaded " + state.rows.length + " items" + (state.cursor ? " (more available)" : ""));
    }catch(e){
      console.error(e); setStatus("Failed to load");
    }finally{
      btnLoad.disabled = false;
    }
  }

  function render(){
    tbody.innerHTML = state.rows.map((r,i)=>\`
      <tr data-i="\${i}">
        <td>\${r.date || ""}</td>
        <td>\${r.zip || ""}</td>
        <td>\${fmtDT(r.uploadedAt)}</td>
        <td>\${fmtSz(r.size||0)}</td>
        <td><a class="link" href="\${r.url}" target="_blank">JSON</a></td>
      </tr>\`).join("");
    tbody.querySelectorAll("tr").forEach(tr=>{
      tr.addEventListener("click", async ()=>{
        const idx = parseInt(tr.getAttribute("data-i"),10);
        const row = state.rows[idx];
        preview.textContent = "Loading JSON…";
        try{
          const res = await fetch(row.url);
          const txt = await res.text();
          preview.textContent = txt;
        }catch(e){
          preview.textContent = "Failed to fetch JSON";
        }
      });
    });
  }

  function toCSV(rows){
    const cols = ["date","zip","uploadedAt","size","url"];
    const esc = (v)=>(\`\${v ?? ""}\`).replace(/"/g,'""');
    const header = cols.map(c=>\`"\${c}"\`).join(",");
    const body = rows.map(r=>cols.map(c=>\`"\${esc(r[c])}"\`).join(",")).join("\\n");
    return header + "\\n" + body + "\\n";
  }

  btnLoad.addEventListener("click", ()=>load(null));
  btnNext.addEventListener("click", ()=> state.cursor ? load(state.cursor) : null);
  btnCSV.addEventListener("click", ()=>{
    const csv = toCSV(state.rows);
    const blob = new Blob([csv], {type:"text/csv"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "estimates.csv";
    document.body.appendChild(a); a.click(); a.remove();
  });

  // auto-load on first visit
  load(null);
})();
</script>
</body>
</html>`;

  res.setHeader("Content-Type","text/html; charset=utf-8");
  return res.status(200).send(html);
}
