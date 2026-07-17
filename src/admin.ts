// Admin surface — edit the live page config in place, without a redeploy.
//
// Self-contained HTML+JS string (framework-light, same as dashboard.ts). The
// editor renders a live preview that mirrors the real page and overlays edit
// affordances: change-icons on the avatar and background/banner, inline
// (contenteditable) name/handle/tagline/labels, and per-card edit/delete plus
// an "add link" control.
//
// Gated client-side by a token validated server-side on every /api/admin/*
// call (ADMIN_TOKEN). Cloudflare Access can be layered in front of /admin*
// later without touching this code.
//
// This page DOES show real destination URLs — intentional and safe: only for a
// request carrying a valid ADMIN_TOKEN (the owner). The invariant that matters
// (URLs never reach an *unauthenticated* client or a crawler) is unaffected;
// see ARCHITECTURE.md §14.0. Nothing here weakens the cloaking: the background
// video/photo and avatar are still rendered by render.ts on the HUMAN page
// only — the bot page never emits them.

export function renderAdminShell(pageId: string, modelName: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(modelName)} — Admin</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@500;600&family=Manrope:wght@500;600;700&display=swap" rel="stylesheet">
<style>
  :root {
    --bg:#14100F; --panel:#1E1815; --panel2:#241D19; --text:#F1EAE0; --dim:#9A8E82;
    --line:rgba(255,255,255,0.12); --accent:#C9A15A; --mauve:#C97A94; --good:#7FB88F; --bad:#C97A7A;
    --stage-bg:#241220; --stage-card:#2E1826;
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family: 'Manrope', system-ui, -apple-system, sans-serif; padding: 0; }
  a { color: var(--accent); }
  code { background: var(--panel2); padding: 1px 6px; border-radius: 5px; font-size: 12px; }
  button { font-family: inherit; cursor: pointer; }

  /* token gate */
  #gate { max-width: 320px; margin: 90px auto; text-align: center; padding: 0 20px; }
  #gate h1 { font-size: 18px; margin: 0 0 6px; }
  #gate input { width: 100%; margin-bottom: 10px; background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 10px; }
  #gate .sub { color: var(--dim); font-size: 12px; margin: 0 0 14px; }
  .primary { background: var(--accent); color: #201200; border: 1px solid var(--accent); font-weight: 700; border-radius: 8px; padding: 9px 16px; }
  #gate .primary { width: 100%; }

  #app { display:none; }

  /* top bar */
  .topbar { position: sticky; top: 0; z-index: 20; display:flex; justify-content:space-between; align-items:center; gap:12px;
    padding: 12px 18px; background: rgba(20,16,15,0.9); backdrop-filter: blur(8px); border-bottom: 1px solid var(--line); flex-wrap: wrap; }
  .crumbs { font-size: 12px; color: var(--dim); }
  .actions { display:flex; align-items:center; gap: 10px; }
  .actions button { background: var(--panel2); color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 8px 14px; font-size: 13px; }
  #status { font-size: 12px; }
  #status.ok { color: var(--good); } #status.err { color: var(--bad); }

  /* background control bar */
  .bgbar { display:flex; align-items:center; gap: 14px; flex-wrap: wrap; padding: 12px 18px; border-bottom: 1px solid var(--line); }
  .bgbar .bglabel { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--dim); }
  .seg { display:inline-flex; border: 1px solid var(--line); border-radius: 9px; overflow: hidden; }
  .seg button { background: transparent; color: var(--dim); border: 0; padding: 7px 13px; font-size: 12px; border-right: 1px solid var(--line); }
  .seg button:last-child { border-right: 0; }
  .seg button.active { background: var(--accent); color: #201200; font-weight: 700; }
  .seg.disabled { opacity: 0.4; pointer-events: none; }

  /* the phone-like preview stage (mirrors render.ts) */
  .stage { position: relative; width: 100%; max-width: 440px; margin: 20px auto 40px; border-radius: 24px; overflow: hidden;
    background: radial-gradient(120% 100% at 50% -10%, #34192C 0%, var(--stage-bg) 55%); min-height: 580px;
    display:flex; flex-direction: column; box-shadow: 0 24px 70px -24px #000, 0 0 0 1px var(--line); }
  /* pointer-events:none is load-bearing. .full-layer is inset:0 across the WHOLE
     stage and it exists even in banner mode, just empty — so when reposition
     mode lifts it to z-index:2 it floated an invisible empty div over the banner
     strip and swallowed the drag. A layout container must never hit-test; only
     real media opts back in (see .stage.repositioning .bg-media below). */
  .full-layer { position: absolute; inset: 0; z-index: 0; pointer-events: none; }
  .full-layer img, .full-layer video { width: 100%; height: 100%; object-fit: cover; display:block; }
  /* pointer-events:none is load-bearing, not cosmetic: the scrim is inset:0 over
     the background media, so without it it swallows every pointerdown meant for
     the image and drag-to-reposition silently does nothing. opacity:0 alone does
     NOT stop hit-testing. The banner's ::after gradient has the same guard. */
  .full-layer .scrim { position: absolute; inset: 0; pointer-events: none;
    background: linear-gradient(180deg, rgba(20,10,17,0.5), rgba(20,10,17,0.82)); }
  #bannerSlot { position: relative; z-index: 1; }
  .banner-strip { position: relative; width: 100%; height: 160px; overflow: hidden; }
  .banner-strip img, .banner-strip video { width: 100%; height: 100%; object-fit: cover; display:block; }
  .banner-strip::after { content:""; position:absolute; left:0; right:0; bottom:0; height:55%;
    background: linear-gradient(180deg, transparent, var(--stage-bg)); pointer-events:none; }

  /* Background tools live on .stage, NOT inside .full-layer. .full-layer sets
     z-index: 0, which makes it a stacking context — so a button nested inside
     it can never paint above .stage-content (z-index: 1) however high its own
     z-index is. That's what made the camera button visible but unclickable:
     .stage-content covered it and swallowed the clicks. As a direct child of
     .stage the button competes with .stage-content on equal terms and wins. */
  .stage-tools { position: absolute; right: 10px; top: 10px; z-index: 4; display: flex; gap: 6px; }

  /* Reposition mode: lift the background above the content so it can actually
     be grabbed (in 'full' the media sits behind everything and is otherwise
     unreachable), and drop the scrims so you can see what you're framing. */
  .stage.repositioning .stage-content { opacity: 0.15; pointer-events: none; }
  .stage.repositioning .full-layer { z-index: 2; }
  .stage.repositioning .full-layer .scrim { opacity: 0; }
  .stage.repositioning .banner-strip::after { opacity: 0; }
  /* The only thing in the stage that hit-tests while repositioning. pointer-events
     is auto ONLY here, so the background can be grabbed during reposition and is
     inert the rest of the time. */
  .stage.repositioning .bg-media { pointer-events: auto; cursor: grab; touch-action: none; }
  .stage.repositioning .bg-media.grabbing { cursor: grabbing; }
  .reposition-hint { position: absolute; left: 50%; bottom: 14px; transform: translateX(-50%); z-index: 6;
    background: rgba(0,0,0,0.72); color: #fff; font-size: 11px; padding: 6px 12px; border-radius: 999px;
    white-space: nowrap; pointer-events: none; }
  .bg-ph { display:flex; align-items:center; justify-content:center; width:100%; height:100%; min-height:120px;
    background: repeating-linear-gradient(45deg,#33192a,#33192a 12px,#2c1524 12px,#2c1524 24px); color: var(--dim); font-size: 12px; }

  .stage-content { position: relative; z-index: 1; padding: 30px 22px 36px; display:flex; flex-direction: column; align-items: center; }

  .avatar-wrap { position: relative; width: 96px; height: 96px; margin: 0 auto 16px; }
  .avatar { width: 96px; height: 96px; border-radius: 50%; display:flex; align-items:center; justify-content:center; overflow:hidden;
    background: linear-gradient(155deg, var(--accent), var(--mauve)); color: var(--stage-bg);
    font-family: 'Fraunces', Georgia, serif; font-size: 32px; font-weight: 600;
    box-shadow: 0 0 0 3px rgba(201,161,90,0.25), 0 12px 30px -12px rgba(0,0,0,0.6); }
  .avatar img { width:100%; height:100%; object-fit: cover; }
  .avatar.placeholder { background: repeating-linear-gradient(45deg,#3a2130,#3a2130 10px,#331c2a 10px,#331c2a 20px);
    color: var(--dim); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }

  /* editable text */
  .ed { outline: none; border-radius: 6px; transition: box-shadow .12s; cursor: text; max-width: 100%; }
  .ed:hover { box-shadow: 0 0 0 1px var(--line); }
  .ed:focus { box-shadow: 0 0 0 2px var(--accent); background: rgba(0,0,0,0.2); }
  .ed:empty:before { content: attr(data-ph); color: var(--dim); opacity: 0.7; }
  .ed.name { font-family: 'Fraunces', Georgia, serif; font-weight: 600; font-size: 26px; text-align:center; margin: 2px 0; padding: 0 6px; }
  .ed.handle { color: var(--accent); font-size: 14px; font-weight: 600; text-align:center; margin: 2px 0; padding: 0 6px; }
  .ed.tagline { color: #C9BDB4; font-size: 14px; text-align:center; margin: 6px 0 26px; padding: 2px 8px; line-height: 1.5; }

  /* link cards */
  .links { display:flex; flex-direction: column; gap: 14px; width: 100%; }
  .link-card { position: relative; display:flex; align-items:center; gap: 12px; background: var(--stage-card);
    border: 1px solid rgba(201,161,90,0.18); border-radius: 14px; padding: 14px 14px 14px 18px; }
  .link-icon { width: 34px; height: 34px; border-radius: 50%; flex:none; background: rgba(201,161,90,0.12);
    display:flex; align-items:center; justify-content:center; color: var(--accent); overflow: hidden; }
  .link-icon img { width: 20px; height: 20px; object-fit: contain; border-radius: 4px; }
  .link-label { font-size: 15px; font-weight: 600; flex: 1; }
  .card-actions { display:flex; gap: 4px; flex: none; }
  .icon-btn { width: 30px; height: 30px; border-radius: 8px; background: rgba(255,255,255,0.06); border: 1px solid var(--line);
    color: var(--text); display:flex; align-items:center; justify-content:center; }
  .icon-btn.danger { color: var(--bad); }
  .add-card { margin-top: 14px; width: 100%; border: 1px dashed rgba(201,161,90,0.4); background: transparent; color: var(--accent);
    border-radius: 14px; padding: 13px; font-size: 14px; font-weight: 600; }

  /* change buttons (overlay on avatar / background) */
  .change-btn { z-index: 3; width: 30px; height: 30px; border-radius: 50%; background: var(--accent);
    color: #201200; border: 2px solid var(--stage-bg); display:flex; align-items:center; justify-content:center; padding: 0; }
  .change-btn.on-avatar { position: absolute; right: -2px; bottom: -2px; }

  /* popovers */
  .overlay { position: fixed; inset: 0; z-index: 50; background: rgba(0,0,0,0.6); display:none; align-items:center; justify-content:center; padding: 20px; }
  .overlay.open { display:flex; }
  .modal { width: 100%; max-width: 420px; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 18px; }
  .modal h3 { margin: 0 0 14px; font-size: 14px; }
  .modal .field { margin-bottom: 12px; }
  .modal label { display:block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; color: var(--dim); margin: 0 0 5px; }
  .modal input, .modal select, .modal textarea { width: 100%; background: var(--panel2); color: var(--text); border: 1px solid var(--line);
    border-radius: 8px; padding: 9px 11px; font-family: inherit; font-size: 14px; }
  .modal .row { display:flex; gap: 8px; align-items:center; }
  .modal .row input { flex: 1; }
  .modal .mediaprev { width: 100%; height: 130px; border-radius: 10px; overflow:hidden; margin-bottom: 12px; background: var(--panel2);
    display:flex; align-items:center; justify-content:center; color: var(--dim); font-size: 12px; }
  .modal .mediaprev img, .modal .mediaprev video { width:100%; height:100%; object-fit: cover; }
  .modal .btns { display:flex; justify-content: space-between; gap: 8px; margin-top: 14px; }
  .modal .mini { background: var(--panel2); color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 8px 12px; font-size: 13px; }
  .modal .mini.danger { color: var(--bad); }
  .modal .hint { font-size: 11px; color: var(--dim); margin: 6px 0 0; }
  .checkbox { display:flex; align-items:center; gap: 8px; font-size: 13px; text-transform: none; letter-spacing: 0; color: var(--text); }
  .checkbox input { width: auto; }
  .more { max-width: 440px; margin: 0 auto 60px; padding: 0 6px; }
  .more summary { cursor: pointer; color: var(--dim); font-size: 13px; padding: 8px 0; }
  .more .field { margin: 10px 0; }
  .more label { display:block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.4px; color: var(--dim); margin: 0 0 5px; }
  .more input, .more textarea { width: 100%; background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 8px; padding: 9px 11px; font-family: inherit; }
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
    <div class="topbar">
      <div class="crumbs">Editing <code>${escapeHtml(pageId)}</code> · <a href="/" target="_blank">view page</a> · <a href="/dashboard" target="_blank">analytics</a></div>
      <div class="actions"><span id="status"></span><button id="reload" type="button">Discard</button><button id="save" class="primary" type="button">Save changes</button></div>
    </div>

    <div class="bgbar">
      <span class="bglabel">Background</span>
      <div class="seg" id="segType">
        <button type="button" data-type="none">None</button>
        <button type="button" data-type="banner">Banner</button>
        <button type="button" data-type="full">Full</button>
      </div>
      <div class="seg" id="segMedia">
        <button type="button" data-media="image">Image</button>
        <button type="button" data-media="video">Video</button>
      </div>
    </div>

    <div class="stage" id="stage">
      <div class="full-layer" id="fullLayer"></div>
      <div id="bannerSlot"></div>
      <div class="stage-content">
        <div class="avatar-wrap" id="avatarWrap"></div>
        <div class="ed name" contenteditable="true" data-field="modelName" data-ph="Display name"></div>
        <div class="ed handle" contenteditable="true" data-field="handle" data-ph="@handle"></div>
        <div class="ed tagline" contenteditable="true" data-field="tagline" data-ph="Short tagline"></div>
        <div class="links" id="stageLinks"></div>
        <button class="add-card" id="addLink" type="button">+ Add link</button>
      </div>
    </div>

    <details class="more">
      <summary>More settings (avatar fallback, link-preview text)</summary>
      <div class="field"><label>Avatar initials (fallback when no photo)</label><input type="text" id="avatarInitials" maxlength="3"></div>
      <div class="field"><label>OG description — shown in Instagram/Meta link previews. Keep it generic.</label><textarea id="ogDescription" rows="2"></textarea></div>
    </details>
  </div>

  <!-- media picker popover -->
  <div class="overlay" id="mediaOverlay">
    <div class="modal">
      <h3 id="mediaTitle">Change image</h3>
      <div class="mediaprev" id="mediaPrev">No media</div>
      <div class="field">
        <label>Paste a hosted URL</label>
        <div class="row"><input type="text" id="mediaUrl" placeholder="https://…"><button class="mini" type="button" id="mediaUseUrl">Use</button></div>
      </div>
      <p class="hint" id="mediaHint"></p>
      <div class="btns">
        <button class="mini" type="button" id="mediaUpload">Upload file</button>
        <div style="display:flex;gap:8px">
          <button class="mini danger" type="button" id="mediaRemove">Remove</button>
          <button class="mini" type="button" id="mediaClose">Done</button>
        </div>
      </div>
    </div>
  </div>

  <!-- link editor popover -->
  <div class="overlay" id="linkOverlay">
    <div class="modal">
      <h3>Edit link</h3>
      <div class="field"><label>ID (stable analytics key — letters, numbers, - and _)</label><input type="text" id="lkId" placeholder="vip"></div>
      <div class="field"><label>Label (shown on the card)</label><input type="text" id="lkLabel" placeholder="VIP Access"></div>
      <div class="field"><label>Destination URL (never rendered on the page)</label><input type="text" id="lkUrl" placeholder="https://…"></div>
      <div class="field"><label>Icon glyph</label><select id="lkIcon"></select></div>
      <div class="field"><label>Logo image URL (optional — overrides the glyph)</label>
        <div class="row"><input type="text" id="lkLogo" placeholder="https://… or upload"><button class="mini" type="button" id="lkLogoUpload">Upload</button></div>
      </div>
      <label class="checkbox"><input type="checkbox" id="lkFav"> Use destination favicon when no logo/glyph is set</label>
      <div class="btns">
        <button class="mini danger" type="button" id="lkDelete">Delete link</button>
        <div style="display:flex;gap:8px">
          <button class="mini" type="button" id="lkCancel">Cancel</button>
          <button class="primary" type="button" id="lkApply">Apply</button>
        </div>
      </div>
    </div>
  </div>

  <input type="file" id="fileInput" style="display:none" />

<script>
var ICON_LIST = ['', 'vip', 'instagram', 'x', 'telegram', 'tiktok', 'youtube', 'generic'];
var GLYPH = {
  vip:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8l4 3 5-6 5 6 4-3-2 11H5L3 8z"/></svg>',
  instagram:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/></svg>',
  telegram:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 3L2 11l6 2 2 6 3-4 5 3 3-15z"/></svg>',
  x:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4l16 16M20 4L4 20"/></svg>',
  tiktok:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 12a4 4 0 1 0 4 4V4c1 2 2.5 3 5 3"/></svg>',
  youtube:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="4"/><path d="M10 9l5 3-5 3z" fill="currentColor"/></svg>',
  generic:'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/></svg>'
};
var PENCIL = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20h4L20 8l-4-4L4 16v4z"/></svg>';
var TRASH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>';
var CAMERA = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 8h3l2-2h6l2 2h3v11H4z"/><circle cx="12" cy="13" r="3"/></svg>';
var MOVE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/></svg>';
var CHECK = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12l5 5L19 7"/></svg>';

var token = sessionStorage.getItem('lh_admin_token') || '';
var state = null;
var uploadCtx = null;   // {kind:'avatar'|'background'|'logo'} — where an uploaded/URL value goes
var editingLink = -1;   // index into state.links for the link editor

function h(id){ return document.getElementById(id); }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]; }); }
function setStatus(m,k){ var s=h('status'); s.textContent=m||''; s.className=k||''; }
function authHeaders(json){ var o={Authorization:'Bearer '+token}; if(json) o['content-type']='application/json'; return o; }

// ---- auth + load ----
function unlock(){ token=h('token').value.trim(); if(token) load(); }
function load(){
  fetch('/api/admin/config',{headers:authHeaders(false)})
    .then(function(r){ if(r.status===401) throw new Error('unauthorized'); if(!r.ok) throw new Error('load'); return r.json(); })
    .then(function(cfg){
      sessionStorage.setItem('lh_admin_token', token);
      state = normalize(cfg);
      h('gate').style.display='none';
      h('app').style.display='block';
      renderAll();
      setStatus('Loaded.', 'ok');
    })
    .catch(function(e){ h('gateErr').textContent = e.message==='unauthorized' ? 'Invalid token.' : 'Could not load config.'; });
}
function normalize(cfg){
  cfg = cfg || {};
  cfg.links = cfg.links || [];
  cfg.backgroundType = cfg.backgroundType || (cfg.backgroundUrl ? 'full' : 'none');
  cfg.backgroundMediaType = cfg.backgroundMediaType || 'image';
  cfg.backgroundPosition = cfg.backgroundPosition || '50% 50%';
  return cfg;
}

// ---- render ----
function renderAll(){
  // text fields
  document.querySelectorAll('[data-field]').forEach(function(el){ el.textContent = state[el.getAttribute('data-field')] || ''; });
  h('avatarInitials').value = state.avatarInitials || '';
  h('ogDescription').value = state.ogDescription || '';
  renderBgBar();
  renderBackground();
  renderAvatar();
  renderLinks();
}

function renderBgBar(){
  [].forEach.call(h('segType').children, function(b){ b.classList.toggle('active', b.getAttribute('data-type') === (state.backgroundType||'none')); });
  [].forEach.call(h('segMedia').children, function(b){ b.classList.toggle('active', b.getAttribute('data-media') === (state.backgroundMediaType||'image')); });
  h('segMedia').classList.toggle('disabled', (state.backgroundType||'none') === 'none');
}

function mediaMarkup(url, mediaType){
  if(!url) return '';
  var pos = esc(state.backgroundPosition || '50% 50%');
  return mediaType === 'video'
    ? '<video class="bg-media" src="'+esc(url)+'" style="object-position:'+pos+'" autoplay muted loop playsinline></video>'
    : '<img class="bg-media" src="'+esc(url)+'" style="object-position:'+pos+'" alt="">';
}
function bgInnerHtml(){
  return state.backgroundUrl ? mediaMarkup(state.backgroundUrl, state.backgroundMediaType)
    : '<div class="bg-ph">+ Add ' + (state.backgroundMediaType==='video'?'video':'image') + '</div>';
}

// ---- background focal point (object-position) ----
function bgPos(){
  var p = String(state.backgroundPosition || '50% 50%').split(/\\s+/);
  var x = parseFloat(p[0]), y = parseFloat(p[1]);
  return { x: isNaN(x)?50:x, y: isNaN(y)?50:y };
}
function clampPct(n){ return Math.min(100, Math.max(0, Math.round(n*10)/10)); }
function setBgPos(x, y){
  state.backgroundPosition = clampPct(x)+'% '+clampPct(y)+'%';
  var m = document.querySelector('.bg-media');
  if(m) m.style.objectPosition = state.backgroundPosition;
}

// How many px the media overflows its frame on each axis under object-fit:
// cover. That overflow IS the draggable range — dragging across it moves the
// focal point 0%..100%, so the image tracks the cursor 1:1. If natural
// dimensions aren't known yet (video metadata still loading), fall back to the
// frame size: less exact, still usable.
function overflowOf(el){
  var fw = el.clientWidth, fh = el.clientHeight;
  var nw = el.naturalWidth || el.videoWidth || 0;
  var nh = el.naturalHeight || el.videoHeight || 0;
  if(!nw || !nh || !fw || !fh) return { x: fw, y: fh };
  var s = Math.max(fw/nw, fh/nh);
  return { x: Math.max(0, nw*s - fw), y: Math.max(0, nh*s - fh) };
}

function attachDrag(el){
  var start = null;
  el.addEventListener('pointerdown', function(e){
    if(!h('stage').classList.contains('repositioning')) return;
    e.preventDefault();
    var p = bgPos();
    start = { mx:e.clientX, my:e.clientY, x:p.x, y:p.y, ov:overflowOf(el) };
    try { el.setPointerCapture(e.pointerId); } catch(_){}
    el.classList.add('grabbing');
  });
  el.addEventListener('pointermove', function(e){
    if(!start) return;
    // Dragging the image right reveals more of its LEFT edge, so the focal
    // point moves left — hence the subtraction. An axis with no overflow has
    // nothing to reveal and stays put.
    var nx = start.ov.x > 0 ? start.x - (e.clientX-start.mx)/start.ov.x*100 : start.x;
    var ny = start.ov.y > 0 ? start.y - (e.clientY-start.my)/start.ov.y*100 : start.y;
    setBgPos(nx, ny);
  });
  ['pointerup','pointercancel'].forEach(function(t){
    el.addEventListener(t, function(){ start=null; el.classList.remove('grabbing'); });
  });
}

function toggleReposition(){
  var st = h('stage');
  st.classList.toggle('repositioning');
  renderBackground();
}

function stageToolsEl(){
  var wrap = document.createElement('div');
  wrap.className = 'stage-tools';
  var cam = document.createElement('button');
  cam.type='button'; cam.className='change-btn'; cam.innerHTML=CAMERA; cam.title='Change background';
  cam.addEventListener('click', function(){ openMedia('background'); });
  wrap.appendChild(cam);
  // Repositioning only means anything once there's media to reposition.
  if(state.backgroundUrl){
    var on = h('stage').classList.contains('repositioning');
    var mv = document.createElement('button');
    mv.type='button'; mv.className='change-btn';
    mv.innerHTML = on ? CHECK : MOVE;
    mv.title = on ? 'Done repositioning' : 'Reposition background';
    mv.addEventListener('click', toggleReposition);
    wrap.appendChild(mv);
  }
  return wrap;
}

function renderBackground(){
  var stage=h('stage'), full=h('fullLayer'), banner=h('bannerSlot');
  full.innerHTML=''; banner.innerHTML='';
  var old = stage.querySelector('.stage-tools'); if(old) old.remove();
  var hint = stage.querySelector('.reposition-hint'); if(hint) hint.remove();

  var type = state.backgroundType || 'none';
  if(type==='none'){ stage.classList.remove('repositioning'); return; }

  if(type==='full'){
    full.innerHTML = bgInnerHtml() + '<div class="scrim"></div>';
  } else {
    var strip=document.createElement('div'); strip.className='banner-strip';
    strip.innerHTML = bgInnerHtml();
    banner.appendChild(strip);
  }
  // Tools are a direct child of .stage — see the .stage-tools CSS note for why
  // they must not live inside .full-layer.
  stage.appendChild(stageToolsEl());

  var media = stage.querySelector('.bg-media');
  if(media) attachDrag(media);
  if(!state.backgroundUrl) stage.classList.remove('repositioning');
  if(stage.classList.contains('repositioning') && media){
    var hp = document.createElement('div');
    hp.className='reposition-hint';
    hp.textContent='Drag to reposition — tap ✓ when done';
    stage.appendChild(hp);
    // Under object-fit: cover the media only overflows on ONE axis, and the
    // other axis genuinely cannot move — a landscape photo in the tall 'full'
    // frame slides horizontally only; the same photo in the short 'banner'
    // strip slides vertically only. Say which, or a dead axis reads as a bug.
    var say = function(){
      var ov = overflowOf(media), x = ov.x > 1, y = ov.y > 1;
      hp.textContent = x && y ? 'Drag to reposition — tap ✓ when done'
        : x ? 'Drag left/right to reposition — tap ✓ when done'
        : y ? 'Drag up/down to reposition — tap ✓ when done'
        : 'This image already fits — nothing to reposition';
    };
    // naturalWidth is 0 until the media has actually loaded.
    if(media.complete || media.videoWidth) say();
    else media.addEventListener(media.tagName==='VIDEO' ? 'loadedmetadata' : 'load', say);
  }
}

function renderAvatar(){
  var w=h('avatarWrap'); w.innerHTML='';
  var av=document.createElement('div');
  if(state.avatarUrl){ av.className='avatar'; av.innerHTML='<img src="'+esc(state.avatarUrl)+'" alt="">'; }
  else if(state.avatarInitials){ av.className='avatar'; av.textContent=state.avatarInitials; }
  else { av.className='avatar placeholder'; av.textContent='Photo'; }
  w.appendChild(av);
  var b=document.createElement('button'); b.type='button'; b.className='change-btn on-avatar'; b.innerHTML=CAMERA; b.title='Change photo';
  b.addEventListener('click', function(){ openMedia('avatar'); });
  w.appendChild(b);
}

function iconPreview(l){
  if(l.logoUrl) return '<img src="'+esc(l.logoUrl)+'" alt="">';
  if(l.icon && GLYPH[l.icon]) return GLYPH[l.icon];
  return GLYPH.generic;
}
function renderLinks(){
  var c=h('stageLinks'); c.innerHTML='';
  state.links.forEach(function(l, i){
    var card=document.createElement('div'); card.className='link-card';
    card.innerHTML =
      '<div class="link-icon">'+iconPreview(l)+'</div>' +
      '<div class="link-label ed" contenteditable="true" data-linklabel="'+i+'" data-ph="Label">'+esc(l.label)+'</div>' +
      '<div class="card-actions">' +
        '<button class="icon-btn" type="button" data-edit="'+i+'" title="Edit link">'+PENCIL+'</button>' +
        '<button class="icon-btn danger" type="button" data-del="'+i+'" title="Delete link">'+TRASH+'</button>' +
      '</div>';
    c.appendChild(card);
  });
  c.querySelectorAll('[data-edit]').forEach(function(b){ b.addEventListener('click', function(){ openLinkEditor(+b.getAttribute('data-edit')); }); });
  c.querySelectorAll('[data-del]').forEach(function(b){ b.addEventListener('click', function(){
    if(state.links.length<=1){ setStatus('Keep at least one link.', 'err'); return; }
    state.links.splice(+b.getAttribute('data-del'), 1); renderLinks();
  }); });
  bindSingleLine(c.querySelectorAll('.ed'));
}

// keep contenteditable single-line (Enter blurs instead of inserting a newline)
function bindSingleLine(nodes){
  [].forEach.call(nodes, function(el){
    el.addEventListener('keydown', function(e){ if(e.key==='Enter'){ e.preventDefault(); el.blur(); } });
  });
}

// pull every editable value out of the DOM into state (called before save)
function syncState(){
  document.querySelectorAll('[data-field]').forEach(function(el){ state[el.getAttribute('data-field')] = el.textContent.replace(/\\s+/g,' ').trim(); });
  state.avatarInitials = h('avatarInitials').value.trim();
  state.ogDescription = h('ogDescription').value.trim();
  document.querySelectorAll('[data-linklabel]').forEach(function(el){
    var i=+el.getAttribute('data-linklabel'); if(state.links[i]) state.links[i].label = el.textContent.replace(/\\s+/g,' ').trim();
  });
}

// ---- background segmented controls ----
[].forEach.call(h('segType').children, function(b){
  b.addEventListener('click', function(){ state.backgroundType = b.getAttribute('data-type'); renderBgBar(); renderBackground(); });
});
[].forEach.call(h('segMedia').children, function(b){
  b.addEventListener('click', function(){ state.backgroundMediaType = b.getAttribute('data-media'); renderBgBar(); renderBackground(); });
});

// ---- media picker popover ----
function openMedia(kind){
  uploadCtx = { kind: kind };
  var cur = kind==='avatar' ? state.avatarUrl : state.backgroundUrl;
  var isVideo = kind==='background' && state.backgroundMediaType==='video';
  h('mediaTitle').textContent = 'Change ' + (kind==='avatar' ? 'profile photo' : 'background');
  h('mediaUrl').value = cur || '';
  h('mediaHint').textContent = isVideo ? 'Video: short muted loop works best, max 30 MB.' : 'Image: JPG/PNG/WebP, max 5 MB.';
  renderMediaPrev(cur, isVideo);
  h('mediaOverlay').classList.add('open');
}
function renderMediaPrev(url, isVideo){
  var p=h('mediaPrev');
  if(!url){ p.innerHTML='No media'; return; }
  p.innerHTML = isVideo ? '<video src="'+esc(url)+'" autoplay muted loop playsinline></video>' : '<img src="'+esc(url)+'" alt="">';
}
function applyMediaValue(url){
  if(uploadCtx.kind==='avatar'){ state.avatarUrl = url; renderAvatar(); }
  else if(uploadCtx.kind==='background'){
    state.backgroundUrl = url;
    if(url && (state.backgroundType==='none' || !state.backgroundType)) state.backgroundType='full';
    renderBgBar(); renderBackground();
  } else if(uploadCtx.kind==='logo'){
    if(state.links[editingLink]){ state.links[editingLink].logoUrl = url; h('lkLogo').value = url; }
  }
}
h('mediaUseUrl').addEventListener('click', function(){
  var v=h('mediaUrl').value.trim(); applyMediaValue(v);
  renderMediaPrev(v, uploadCtx.kind==='background' && state.backgroundMediaType==='video');
  setStatus('Set. Remember to Save.', 'ok');
});
h('mediaRemove').addEventListener('click', function(){ applyMediaValue(''); renderMediaPrev('', false); });
h('mediaClose').addEventListener('click', function(){ h('mediaOverlay').classList.remove('open'); });
h('mediaUpload').addEventListener('click', function(){
  var isVideo = uploadCtx.kind==='background' && state.backgroundMediaType==='video';
  h('fileInput').setAttribute('accept', isVideo ? 'video/*' : 'image/*');
  h('fileInput').click();
});

// ---- shared file upload ----
h('fileInput').addEventListener('change', function(){
  var file=this.files && this.files[0]; this.value='';
  if(!file || !uploadCtx) return;
  setStatus('Uploading…','');
  fetch('/api/admin/upload?filename='+encodeURIComponent(file.name), {
    method:'POST', headers:{Authorization:'Bearer '+token,'content-type':file.type||'application/octet-stream'}, body:file
  })
    .then(function(r){ return r.json().then(function(b){ return {ok:r.ok, body:b}; }); })
    .then(function(res){
      if(!res.ok){ setStatus(res.body && res.body.error ? res.body.error : 'Upload failed.', 'err'); return; }
      applyMediaValue(res.body.url);
      var isVideo = uploadCtx.kind==='background' && state.backgroundMediaType==='video';
      if(h('mediaOverlay').classList.contains('open')) renderMediaPrev(res.body.url, isVideo);
      setStatus('Uploaded. Remember to Save.', 'ok');
    })
    .catch(function(){ setStatus('Upload error.', 'err'); });
});

// ---- link editor popover ----
function openLinkEditor(i){
  editingLink = i; var l = state.links[i] || {};
  var sel=h('lkIcon'); sel.innerHTML = ICON_LIST.map(function(ic){
    return '<option value="'+ic+'"'+((l.icon||'')===ic?' selected':'')+'>'+(ic===''?'(none)':ic)+'</option>';
  }).join('');
  h('lkId').value=l.id||''; h('lkLabel').value=l.label||''; h('lkUrl').value=l.url||'';
  h('lkLogo').value=l.logoUrl||''; h('lkFav').checked = l.faviconFallback !== false;
  h('linkOverlay').classList.add('open');
}
h('lkLogoUpload').addEventListener('click', function(){ uploadCtx={kind:'logo'}; h('fileInput').setAttribute('accept','image/*'); h('fileInput').click(); });
h('lkApply').addEventListener('click', function(){
  var l = state.links[editingLink]; if(!l) return;
  l.id=h('lkId').value.trim(); l.label=h('lkLabel').value.trim(); l.url=h('lkUrl').value.trim();
  l.icon=h('lkIcon').value||undefined; l.logoUrl=h('lkLogo').value.trim()||undefined; l.faviconFallback=h('lkFav').checked;
  h('linkOverlay').classList.remove('open'); renderLinks();
});
h('lkCancel').addEventListener('click', function(){ h('linkOverlay').classList.remove('open'); });
h('lkDelete').addEventListener('click', function(){
  if(state.links.length<=1){ setStatus('Keep at least one link.', 'err'); return; }
  state.links.splice(editingLink,1); h('linkOverlay').classList.remove('open'); renderLinks();
});

h('addLink').addEventListener('click', function(){
  state.links.push({ id:'', label:'New link', url:'', faviconFallback:true });
  renderLinks(); openLinkEditor(state.links.length-1);
});

// ---- save ----
function save(){
  syncState();
  setStatus('Saving…','');
  fetch('/api/admin/config', { method:'PUT', headers:authHeaders(true), body:JSON.stringify(state) })
    .then(function(r){ return r.json().then(function(b){ return {ok:r.ok, body:b}; }); })
    .then(function(res){
      if(!res.ok){ setStatus(res.body && res.body.error ? res.body.error : 'Save failed.', 'err'); return; }
      state = normalize(res.body); renderAll();
      setStatus('Saved. Live now (edges refresh within ~60s).', 'ok');
    })
    .catch(function(){ setStatus('Network error.', 'err'); });
}

h('unlock').addEventListener('click', unlock);
h('token').addEventListener('keydown', function(e){ if(e.key==='Enter') unlock(); });
h('save').addEventListener('click', save);
h('reload').addEventListener('click', load);
bindSingleLine(document.querySelectorAll('.stage-content > .ed'));

if(token) load();
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
