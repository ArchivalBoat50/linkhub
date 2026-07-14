export function renderDashboardShell(pageId: string, modelName: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${modelName} — Analytics</title>
<style>
  :root { --bg:#14100F; --card:#1E1815; --text:#F1EAE0; --dim:#9A8E82; --accent:#C9A15A; --good:#7FB88F; --bad:#C97A7A; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family: 'Manrope', system-ui, sans-serif; padding: 24px; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .sub { color: var(--dim); font-size: 12px; margin: 0 0 20px; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
  .stat { background: var(--card); border-radius: 10px; padding: 14px 16px; flex: 1; min-width: 130px; }
  .stat .n { font-size: 22px; font-weight: 700; }
  .stat .l { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.4px; margin-top: 2px; }
  .panel { background: var(--card); border-radius: 10px; padding: 16px; margin-bottom: 12px; }
  .panel h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--dim); margin: 0 0 12px; }
  .bar-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; font-size: 13px; }
  .bar-label { width: 130px; flex: none; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-track { flex: 1; height: 8px; background: rgba(255,255,255,0.06); border-radius: 4px; overflow: hidden; }
  .bar-fill { height: 100%; background: var(--accent); }
  .bar-n { width: 40px; text-align: right; color: var(--dim); font-size: 12px; }
  input, button, select { font-family: inherit; background: var(--card); color: var(--text); border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; padding: 8px 10px; }
  #gate { max-width: 320px; margin: 80px auto; text-align: center; }
  #gate input { width: 100%; margin-bottom: 10px; }
  #gate button { width: 100%; cursor: pointer; }
  #app { display: none; }
</style>
</head>
<body>
  <div id="gate">
    <h1>${modelName} — Analytics</h1>
    <p class="sub">Enter dashboard token</p>
    <input type="password" id="token" placeholder="Token" />
    <button id="unlock">View</button>
    <p class="sub" id="err" style="color:var(--bad)"></p>
  </div>

  <div id="app">
    <h1>${modelName} — Analytics</h1>
    <p class="sub" id="windowLabel"></p>
    <div class="row">
      <select id="days">
        <option value="7">Last 7 days</option>
        <option value="30" selected>Last 30 days</option>
        <option value="90">Last 90 days</option>
      </select>
    </div>
    <div class="row" id="stats"></div>
    <div class="panel">
      <h2>Clicks by link</h2>
      <div id="clicksByLink"></div>
    </div>
    <div class="row">
      <div class="panel" style="flex:1;">
        <h2>Device</h2>
        <div id="deviceSplit"></div>
      </div>
      <div class="panel" style="flex:1;">
        <h2>Top countries</h2>
        <div id="countrySplit"></div>
      </div>
    </div>
    <div class="row">
      <div class="panel" style="flex:1;">
        <h2>Top referrers</h2>
        <div id="referrerSplit"></div>
      </div>
      <div class="panel" style="flex:1;">
        <h2>Bot traffic (crawlers hitting the safe page)</h2>
        <div id="botTypeSplit"></div>
      </div>
    </div>
  </div>

<script>
var pageId = ${JSON.stringify(pageId)};
var token = '';

function bars(container, rows, keyField) {
  if (!rows || !rows.length) { container.innerHTML = '<p class="sub">No data yet</p>'; return; }
  var max = Math.max.apply(null, rows.map(function (r) { return r.n; }));
  container.innerHTML = rows.map(function (r) {
    var label = r[keyField] || '(direct / unknown)';
    var pct = max > 0 ? Math.round((r.n / max) * 100) : 0;
    return '<div class="bar-row"><div class="bar-label">' + label + '</div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="bar-n">' + r.n + '</div></div>';
  }).join('');
}

function stat(n, l) {
  return '<div class="stat"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>';
}

function load() {
  var days = document.getElementById('days').value;
  fetch('/api/analytics?page=' + encodeURIComponent(pageId) + '&days=' + days, {
    headers: { Authorization: 'Bearer ' + token }
  }).then(function (r) {
    if (r.status === 401) throw new Error('unauthorized');
    return r.json();
  }).then(function (d) {
    document.getElementById('gate').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    document.getElementById('windowLabel').textContent = 'Last ' + d.windowDays + ' days';
    document.getElementById('stats').innerHTML =
      stat(d.humanVisits, 'Page visits') +
      stat(d.uniqueHumanVisitors, 'Unique visitors') +
      stat(d.totalClicks, 'Link clicks') +
      stat(d.clickThroughRate + '%', 'Click-through rate') +
      stat(d.botVisits, 'Crawler hits');
    bars(document.getElementById('clicksByLink'), d.clicksByLink, 'link_id');
    bars(document.getElementById('deviceSplit'), d.deviceSplit, 'device');
    bars(document.getElementById('countrySplit'), d.countrySplit, 'country');
    bars(document.getElementById('referrerSplit'), d.referrerSplit, 'referrer');
    bars(document.getElementById('botTypeSplit'), d.botTypeSplit, 'bot_type');
  }).catch(function (e) {
    document.getElementById('err').textContent = 'Invalid token or no data yet.';
  });
}

document.getElementById('unlock').addEventListener('click', function () {
  token = document.getElementById('token').value;
  load();
});
document.getElementById('days').addEventListener('change', load);
</script>
</body>
</html>`;
}
