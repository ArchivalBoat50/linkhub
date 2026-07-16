// Admin surface — edit the live page config without a redeploy.
//
// Self-contained HTML+JS string, same framework-light approach as dashboard.ts.
// Gated client-side by a token that is validated server-side on every
// /api/admin/* call (ADMIN_TOKEN secret). Cloudflare Access can be layered in
// front of /admin* at the network layer later without touching this code.
//
// This page DOES show real destination URLs — that's intentional and safe: it
// only renders them for a request that carries a valid ADMIN_TOKEN (the owner).
// The invariant that matters (URLs never reach an *unauthenticated* client or a
// crawler) is unaffected; see ARCHITECTURE.md §14.0.

export function renderAdminShell(pageId: string, modelName: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(modelName)} — Admin</title>
<style>
  :root {
    --bg:#14100F; --card:#1E1815; --card2:#241D19; --text:#F1EAE0; --dim:#9A8E82;
    --line:rgba(255,255,255,0.10); --accent:#C9A15A; --good:#7FB88F; --bad:#C97A7A;
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family: system-ui, -apple-system, sans-serif; padding: 24px; max-width: 760px; margin: 0 auto; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .sub { color: var(--dim); font-size: 12px; margin: 0 0 20px; }
  a { color: var(--accent); }
  label { display:block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; color: var(--dim); margin: 0 0 5px; }
  input[type=text], input[type=url], textarea, select {
    width: 100%; font-family: inherit; font-size: 14px; background: var(--card2); color: var(--text);
    border: 1px solid var(--line); border-radius: 8px; padding: 9px 11px;
  }
  textarea { resize: vertical; min-height: 54px; }
  .field { margin-bottom: 14px; }
  .panel { background: var(--card); border-radius: 10px; padding: 16px 18px; margin-bottom: 14px; }
  .panel h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--dim); margin: 0 0 14px; }
  button { font-family: inherit; font-size: 14px; background: var(--card2); color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 9px 14px; cursor: pointer; }
  button.primary { background: var(--accent); color: #201200; border-color: var(--accent); font-weight: 700; }
  button.mini { padding: 5px 9px; font-size: 12px; }
  button.danger { color: var(--bad); }
  .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .grid2 { display:grid; grid-template-columns: 1fr 1fr; gap:12px; }
  @media (max-width: 560px) { .grid2 { grid-template-columns: 1fr; } }
  .link-item { border: 1px solid var(--line); border-radius: 10px; padding: 14px; margin-bottom: 12px; background: var(--card2); }
  .link-item .head { display:flex; justify-content:space-between; align-items:center; margin-bottom: 10px; }
  .link-item .head strong { font-size: 13px; }
  .checkbox { display:flex; align-items:center; gap:8px; font-size:13px; color:var(--text); text-transform:none; letter-spacing:0; }
  .checkbox input { width:auto; }
  .media-row { display:flex; gap:8px; align-items:center; }
  .media-row input { flex:1; }
  .bar { position: sticky; bottom: 0; background: linear-gradient(180deg, transparent, var(--bg) 40%); padding: 16px 0 4px; display:flex; gap:10px; align-items:center; }
  #status { font-size: 13px; }
  #status.ok { color: var(--good); }
  #status.err { color: var(--bad); }
  #gate { max-width: 320px; margin: 80px auto; text-align: center; }
  #gate input { width: 100%; margin-bottom: 10px; }
  #gate button { width: 100%; }
  #app { display:none; }
  .hint { text-transform:none; letter-spacing:0; font-weight:400; color:var(--dim); font-size:11px; margin-top:4px; }
</style>
</head>
<body>
  <div id="gate">
    <h1>${escapeHtml(modelName)} — Admin</h1>
    <p class="sub">Enter admin token</p>
    <input type="password" id="token" placeholder="Token" />
    <button class="primary" id="unlock">Unlock</button>
    <p class="sub" id="gateErr" style="color:var(--bad)"></p>
  </div>

  <div id="app">
    <h1>${escapeHtml(modelName)} — Admin</h1>
    <p class="sub">Editing page <code>${escapeHtml(pageId)}</code> · <a href="/" target="_blank">view page</a> · <a href="/dashboard" target="_blank">analytics</a></p>

    <div class="panel">
      <h2>Profile</h2>
      <div class="field"><label>Display name</label><input type="text" id="modelName" /></div>
      <div class="grid2">
        <div class="field"><label>Handle</label><input type="text" id="handle" placeholder="@yourhandle" /></div>
        <div class="field"><label>Avatar initials (fallback)</label><input type="text" id="avatarInitials" maxlength="3" /></div>
      </div>
      <div class="field"><label>Tagline</label><input type="text" id="tagline" /></div>
      <div class="field">
        <label>Avatar image URL</label>
        <div class="media-row"><input type="text" id="avatarUrl" placeholder="https://… or upload" /><button class="mini" type="button" data-upload="avatarUrl">Upload</button></div>
        <p class="hint">Shown on the human page only. Keep it clean/SFW — bots never see it.</p>
      </div>
      <div class="field">
        <label>Background image URL (optional)</label>
        <div class="media-row"><input type="text" id="backgroundUrl" placeholder="https://… or upload" /><button class="mini" type="button" data-upload="backgroundUrl">Upload</button></div>
      </div>
      <div class="field"><label>OG description (shown in link previews — keep generic)</label><textarea id="ogDescription"></textarea></div>
    </div>

    <div class="panel">
      <h2>Links</h2>
      <div id="links"></div>
      <button class="mini" type="button" id="addLink">+ Add link</button>
    </div>

    <div class="bar">
      <button class="primary" id="save">Save changes</button>
      <button id="reload" type="button">Discard &amp; reload</button>
      <span id="status"></span>
    </div>
  </div>

<input type="file" id="fileInput" accept="image/*" style="display:none" />

<script>
var ICONS = ['', 'vip', 'instagram', 'x', 'telegram', 'tiktok', 'youtube', 'generic'];
var token = sessionStorage.getItem('lh_admin_token') || '';
var uploadTarget = null; // element id currently awaiting an uploaded URL

function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]; }); }
function h(id) { return document.getElementById(id); }
function setStatus(msg, kind) { var s = h('status'); s.textContent = msg || ''; s.className = kind || ''; }

function headers(json) {
  var o = { Authorization: 'Bearer ' + token };
  if (json) o['content-type'] = 'application/json';
  return o;
}

function unlock() {
  token = h('token').value.trim();
  if (!token) return;
  load();
}

function load() {
  fetch('/api/admin/config', { headers: headers(false) })
    .then(function (r) {
      if (r.status === 401) { throw new Error('unauthorized'); }
      if (!r.ok) { throw new Error('load failed'); }
      return r.json();
    })
    .then(function (cfg) {
      sessionStorage.setItem('lh_admin_token', token);
      h('gate').style.display = 'none';
      h('app').style.display = 'block';
      fill(cfg);
      setStatus('Loaded.', 'ok');
    })
    .catch(function (e) {
      if (e.message === 'unauthorized') { h('gateErr').textContent = 'Invalid token.'; }
      else { h('gateErr').textContent = 'Could not load config.'; }
    });
}

function fill(cfg) {
  h('modelName').value = cfg.modelName || '';
  h('handle').value = cfg.handle || '';
  h('avatarInitials').value = cfg.avatarInitials || '';
  h('tagline').value = cfg.tagline || '';
  h('avatarUrl').value = cfg.avatarUrl || '';
  h('backgroundUrl').value = cfg.backgroundUrl || '';
  h('ogDescription').value = cfg.ogDescription || '';
  h('links').innerHTML = '';
  (cfg.links || []).forEach(addLinkRow);
}

function addLinkRow(link) {
  link = link || {};
  var wrap = document.createElement('div');
  wrap.className = 'link-item';
  var iconOpts = ICONS.map(function (ic) {
    var sel = (link.icon || '') === ic ? ' selected' : '';
    return '<option value="' + ic + '"' + sel + '>' + (ic === '' ? '(none)' : ic) + '</option>';
  }).join('');
  var favChecked = link.faviconFallback === false ? '' : ' checked';
  wrap.innerHTML =
    '<div class="head"><strong>Link</strong><button class="mini danger" type="button" data-remove>Remove</button></div>' +
    '<div class="grid2">' +
      '<div class="field"><label>ID (stable, analytics key)</label><input type="text" class="l-id" value="' + esc(link.id) + '" placeholder="vip"></div>' +
      '<div class="field"><label>Label</label><input type="text" class="l-label" value="' + esc(link.label) + '" placeholder="VIP Access"></div>' +
    '</div>' +
    '<div class="field"><label>Destination URL (never shown on the page)</label><input type="text" class="l-url" value="' + esc(link.url) + '" placeholder="https://…"></div>' +
    '<div class="grid2">' +
      '<div class="field"><label>Icon glyph</label><select class="l-icon">' + iconOpts + '</select></div>' +
      '<div class="field"><label>Logo image URL (optional, overrides glyph)</label><div class="media-row"><input type="text" class="l-logo" value="' + esc(link.logoUrl) + '" placeholder="https://… or upload"><button class="mini" type="button" data-upload-logo>Upload</button></div></div>' +
    '</div>' +
    '<label class="checkbox"><input type="checkbox" class="l-fav"' + favChecked + '> Use destination favicon when no logo/icon set</label>';
  wrap.querySelector('[data-remove]').addEventListener('click', function () { wrap.remove(); });
  wrap.querySelector('[data-upload-logo]').addEventListener('click', function () {
    uploadTarget = wrap.querySelector('.l-logo');
    h('fileInput').click();
  });
  h('links').appendChild(wrap);
}

function collect() {
  var links = [].map.call(document.querySelectorAll('.link-item'), function (w) {
    return {
      id: w.querySelector('.l-id').value.trim(),
      label: w.querySelector('.l-label').value.trim(),
      url: w.querySelector('.l-url').value.trim(),
      icon: w.querySelector('.l-icon').value || undefined,
      logoUrl: w.querySelector('.l-logo').value.trim() || undefined,
      faviconFallback: w.querySelector('.l-fav').checked
    };
  });
  return {
    modelName: h('modelName').value.trim(),
    handle: h('handle').value.trim(),
    avatarInitials: h('avatarInitials').value.trim(),
    tagline: h('tagline').value.trim(),
    avatarUrl: h('avatarUrl').value.trim(),
    backgroundUrl: h('backgroundUrl').value.trim(),
    ogDescription: h('ogDescription').value.trim(),
    links: links
  };
}

function save() {
  setStatus('Saving…', '');
  fetch('/api/admin/config', { method: 'PUT', headers: headers(true), body: JSON.stringify(collect()) })
    .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
    .then(function (res) {
      if (!res.ok) { setStatus(res.body && res.body.error ? res.body.error : 'Save failed.', 'err'); return; }
      fill(res.body);
      setStatus('Saved. Live now (cache refreshes within ~60s across edges).', 'ok');
    })
    .catch(function () { setStatus('Network error.', 'err'); });
}

// ---- image upload (R2) ----
h('fileInput').addEventListener('change', function () {
  var file = this.files && this.files[0];
  this.value = '';
  if (!file || !uploadTarget) return;
  setStatus('Uploading…', '');
  fetch('/api/admin/upload?filename=' + encodeURIComponent(file.name), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'content-type': file.type || 'application/octet-stream' },
    body: file
  })
    .then(function (r) { return r.json().then(function (b) { return { ok: r.ok, body: b }; }); })
    .then(function (res) {
      if (!res.ok) { setStatus(res.body && res.body.error ? res.body.error : 'Upload failed.', 'err'); return; }
      uploadTarget.value = res.body.url;
      uploadTarget = null;
      setStatus('Uploaded. Remember to Save.', 'ok');
    })
    .catch(function () { setStatus('Upload error.', 'err'); });
});

[].forEach.call(document.querySelectorAll('[data-upload]'), function (btn) {
  btn.addEventListener('click', function () { uploadTarget = h(btn.getAttribute('data-upload')); h('fileInput').click(); });
});

h('unlock').addEventListener('click', unlock);
h('token').addEventListener('keydown', function (e) { if (e.key === 'Enter') unlock(); });
h('addLink').addEventListener('click', function () { addLinkRow({ faviconFallback: true }); });
h('save').addEventListener('click', save);
h('reload').addEventListener('click', load);

if (token) { load(); }
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
