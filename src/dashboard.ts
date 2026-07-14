export function renderDashboardShell(pageId: string, modelName: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${modelName} — Analytics</title>
<style>
  :root {
    --bg:#14100F; --card:#1E1815; --card2:#241D19; --text:#F1EAE0; --dim:#9A8E82;
    --line:rgba(255,255,255,0.08); --accent:#C9A15A; --good:#7FB88F; --bad:#C97A7A;
    /* Categorical series colors — validated as a set for the dark surface
       (dataviz skill; worst adjacent CVD ΔE 10.3, floor band, so every series
       also carries a legend swatch + direct end label as secondary encoding). */
    --s-visits:#3987e5; --s-unique:#199e70; --s-clicks:#c98500; --s-bots:#008300;
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family: 'Manrope', system-ui, sans-serif; padding: 24px; max-width: 1100px; margin: 0 auto; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .sub { color: var(--dim); font-size: 12px; margin: 0 0 20px; }
  .row { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
  .stat { background: var(--card); border-radius: 10px; padding: 14px 16px; flex: 1; min-width: 120px; }
  .stat .n { font-size: 22px; font-weight: 700; }
  .stat .l { font-size: 11px; color: var(--dim); text-transform: uppercase; letter-spacing: 0.4px; margin-top: 2px; }
  .panel { background: var(--card); border-radius: 10px; padding: 16px; margin-bottom: 12px; }
  .panel h2 { font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; color: var(--dim); margin: 0 0 12px; display:flex; justify-content:space-between; align-items:center; }
  .panel h2 .hint { text-transform: none; letter-spacing: 0; font-weight: 400; color: var(--dim); font-size: 11px; }
  .bar-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; font-size: 13px; }
  .bar-label { width: 130px; flex: none; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-track { flex: 1; height: 8px; background: rgba(255,255,255,0.06); border-radius: 4px; overflow: hidden; }
  .bar-fill { height: 100%; background: var(--accent); border-radius: 4px; }
  .bar-n { width: 44px; text-align: right; color: var(--dim); font-size: 12px; }
  input, button, select { font-family: inherit; background: var(--card); color: var(--text); border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; padding: 8px 10px; }
  #gate { max-width: 320px; margin: 80px auto; text-align: center; }
  #gate input { width: 100%; margin-bottom: 10px; }
  #gate button { width: 100%; cursor: pointer; }
  #app { display: none; }
  .grid2 { display:grid; grid-template-columns: 1fr 1fr; gap:12px; }
  @media (max-width: 640px) { .grid2 { grid-template-columns: 1fr; } }
  /* Time-series chart */
  .chart-wrap { width:100%; overflow-x:auto; }
  svg.chart { width:100%; height:auto; display:block; }
  .legend { display:flex; flex-wrap:wrap; gap:6px 14px; margin-top:10px; }
  .legend-item { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--text); cursor:pointer; user-select:none; padding:2px 4px; border-radius:6px; }
  .legend-item.off { color:var(--dim); opacity:0.55; }
  .legend-sw { width:10px; height:10px; border-radius:3px; flex:none; }
  .grid line { stroke: var(--line); stroke-width:1; }
  .axis text { fill: var(--dim); font-size: 10px; }
  .series-line { fill:none; stroke-width:2; }
  .end-label { font-size:10px; font-weight:600; }
  .crosshair { stroke: rgba(255,255,255,0.25); stroke-width:1; stroke-dasharray:3 3; }
  .tooltip { position:fixed; pointer-events:none; background:var(--card2); border:1px solid rgba(255,255,255,0.14); border-radius:8px; padding:8px 10px; font-size:12px; color:var(--text); box-shadow:0 6px 20px rgba(0,0,0,0.4); z-index:10; display:none; min-width:120px; }
  .tooltip .tt-day { color:var(--dim); font-size:11px; margin-bottom:4px; }
  .tooltip .tt-row { display:flex; align-items:center; gap:6px; justify-content:space-between; }
  .tooltip .tt-row .k { display:flex; align-items:center; gap:5px; }
  .tooltip .tt-sw { width:8px; height:8px; border-radius:2px; flex:none; }
  .split-bar { display:flex; height:26px; border-radius:6px; overflow:hidden; background:rgba(255,255,255,0.05); }
  .split-seg { height:100%; display:flex; align-items:center; padding:0 8px; font-size:11px; font-weight:600; color:#0d0b0a; white-space:nowrap; }
  .split-key { display:flex; gap:16px; margin-top:8px; font-size:12px; }
  .split-key span { display:flex; align-items:center; gap:6px; color:var(--dim); }
  .split-key .sw { width:10px; height:10px; border-radius:3px; }
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
      <h2>Traffic over time <span class="hint">tap a series to toggle</span></h2>
      <div class="chart-wrap"><div id="tsChart"></div></div>
    </div>

    <div class="grid2">
      <div class="panel">
        <h2>Click-through rate over time <span class="hint">clicks ÷ visits</span></h2>
        <div class="chart-wrap"><div id="ctrChart"></div></div>
      </div>
      <div class="panel">
        <h2>Human vs crawler traffic</h2>
        <div id="splitBar"></div>
      </div>
    </div>

    <div class="panel">
      <h2>Clicks by link</h2>
      <div id="clicksByLink"></div>
    </div>

    <div class="grid2">
      <div class="panel"><h2>Device</h2><div id="deviceSplit"></div></div>
      <div class="panel"><h2>Top countries</h2><div id="countrySplit"></div></div>
    </div>

    <div class="grid2">
      <div class="panel"><h2>Top referrers</h2><div id="referrerSplit"></div></div>
      <div class="panel"><h2>Crawler types <span class="hint">bots hitting the safe page</span></h2><div id="botTypeSplit"></div></div>
    </div>

    <div class="panel">
      <h2>Campaigns (UTM)</h2>
      <div class="grid2" style="margin-bottom:0;">
        <div><p class="sub" style="margin:0 0 8px;">Source</p><div id="utmSource"></div></div>
        <div><p class="sub" style="margin:0 0 8px;">Medium</p><div id="utmMedium"></div></div>
      </div>
      <div style="margin-top:12px;"><p class="sub" style="margin:0 0 8px;">Campaign</p><div id="utmCampaign"></div></div>
    </div>
  </div>

  <div class="tooltip" id="tooltip"></div>

<script>
var pageId = ${JSON.stringify(pageId)};
var token = '';

// ---- horizontal bar breakdowns (single-series; theme accent) ----
function bars(container, rows, keyField) {
  if (!rows || !rows.length) { container.innerHTML = '<p class="sub">No data yet</p>'; return; }
  var max = Math.max.apply(null, rows.map(function (r) { return r.n; }));
  container.innerHTML = rows.map(function (r) {
    var label = esc(r[keyField] || '(direct / none)');
    var pct = max > 0 ? Math.round((r.n / max) * 100) : 0;
    return '<div class="bar-row" title="' + label + ': ' + r.n + '"><div class="bar-label">' + label + '</div>' +
      '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="bar-n">' + r.n + '</div></div>';
  }).join('');
}

function stat(n, l) {
  return '<div class="stat"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>';
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  });
}

// ---- human vs crawler split bar ----
function splitBar(container, humans, bots) {
  var total = humans + bots;
  if (total === 0) { container.innerHTML = '<p class="sub">No data yet</p>'; return; }
  var hp = (humans / total) * 100, bp = 100 - hp;
  container.innerHTML =
    '<div class="split-bar">' +
      (hp > 0 ? '<div class="split-seg" style="width:' + hp + '%;background:var(--s-visits)">' + (hp >= 12 ? Math.round(hp) + '%' : '') + '</div>' : '') +
      (bp > 0 ? '<div class="split-seg" style="width:' + bp + '%;background:var(--s-bots)">' + (bp >= 12 ? Math.round(bp) + '%' : '') + '</div>' : '') +
    '</div>' +
    '<div class="split-key">' +
      '<span><span class="sw" style="background:var(--s-visits)"></span>Humans ' + humans + '</span>' +
      '<span><span class="sw" style="background:var(--s-bots)"></span>Crawlers ' + bots + '</span>' +
    '</div>';
}

// ---- inline-SVG time-series line chart ----
// series: [{ key, label, color, values:number[] }] aligned to labels[].
// One shared y-axis (all series share the same unit). Legend toggles a series;
// toggling recomputes the y-scale over visible series only (color stays bound
// to the entity, never repainted). Crosshair + tooltip on hover.
function lineChart(mountId, labels, series, opts) {
  opts = opts || {};
  var fmt = opts.format || function (v) { return String(v); };
  var W = 720, H = 260, mL = 40, mR = 54, mT = 12, mB = 26;
  var plotW = W - mL - mR, plotH = H - mT - mB;
  var n = labels.length;
  var visible = {};
  series.forEach(function (s) { visible[s.key] = visible[s.key] !== false; });

  var mount = document.getElementById(mountId);
  var tooltip = document.getElementById('tooltip');

  function xAt(i) { return n <= 1 ? mL + plotW / 2 : mL + (i / (n - 1)) * plotW; }

  function draw() {
    var active = series.filter(function (s) { return visible[s.key]; });
    var max = 1;
    active.forEach(function (s) { s.values.forEach(function (v) { if (v > max) max = v; }); });
    // round the axis top to a clean-ish number
    var step = Math.pow(10, Math.floor(Math.log10(max)));
    max = Math.ceil(max / step) * step;
    function yAt(v) { return mT + plotH - (v / max) * plotH; }

    var svg = '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="xMidYMid meet" role="img">';

    // horizontal gridlines + y labels (4 bands)
    svg += '<g class="grid">';
    for (var g = 0; g <= 4; g++) {
      var gy = mT + (plotH / 4) * g;
      svg += '<line x1="' + mL + '" y1="' + gy + '" x2="' + (mL + plotW) + '" y2="' + gy + '"/>';
    }
    svg += '</g><g class="axis">';
    for (var g2 = 0; g2 <= 4; g2++) {
      var val = max - (max / 4) * g2;
      var gy2 = mT + (plotH / 4) * g2;
      svg += '<text x="' + (mL - 6) + '" y="' + (gy2 + 3) + '" text-anchor="end">' + fmt(Math.round(val)) + '</text>';
    }
    // x labels (~5 evenly spaced dates)
    var ticks = Math.min(n, 5);
    for (var t = 0; t < ticks; t++) {
      var idx = ticks <= 1 ? 0 : Math.round((t / (ticks - 1)) * (n - 1));
      var d = labels[idx] ? labels[idx].slice(5) : '';
      svg += '<text x="' + xAt(idx) + '" y="' + (H - 8) + '" text-anchor="middle">' + d + '</text>';
    }
    svg += '</g>';

    // series lines + end labels
    active.forEach(function (s) {
      var dpath = s.values.map(function (v, i) { return (i === 0 ? 'M' : 'L') + xAt(i).toFixed(1) + ' ' + yAt(v).toFixed(1); }).join(' ');
      svg += '<path class="series-line" d="' + dpath + '" stroke="' + s.color + '"/>';
      var last = s.values[n - 1] || 0;
      svg += '<text class="end-label" x="' + (mL + plotW + 4) + '" y="' + (yAt(last) + 3) + '" fill="' + s.color + '">' + fmt(last) + '</text>';
    });

    // crosshair + hover dots (hidden until hover)
    svg += '<line class="crosshair" id="' + mountId + '-cross" x1="0" y1="' + mT + '" x2="0" y2="' + (mT + plotH) + '" style="display:none"/>';
    active.forEach(function (s) {
      svg += '<circle id="' + mountId + '-dot-' + s.key + '" r="3.5" fill="' + s.color + '" stroke="var(--card)" stroke-width="1.5" style="display:none"/>';
    });
    // transparent capture rect
    svg += '<rect x="' + mL + '" y="' + mT + '" width="' + plotW + '" height="' + plotH + '" fill="transparent" id="' + mountId + '-hit"/>';
    svg += '</svg>';

    mount.innerHTML = svg + legendHtml();

    var svgEl = mount.querySelector('svg');
    var hit = document.getElementById(mountId + '-hit');
    var cross = document.getElementById(mountId + '-cross');

    function nearestIndex(evt) {
      var pt = svgEl.createSVGPoint();
      pt.x = evt.clientX; pt.y = evt.clientY;
      var loc = pt.matrixTransform(svgEl.getScreenCTM().inverse());
      if (n <= 1) return 0;
      var i = Math.round(((loc.x - mL) / plotW) * (n - 1));
      return Math.max(0, Math.min(n - 1, i));
    }

    hit.addEventListener('mousemove', function (evt) {
      var i = nearestIndex(evt);
      var cx = xAt(i);
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx);
      cross.style.display = '';
      var rows = '';
      active.forEach(function (s) {
        var dot = document.getElementById(mountId + '-dot-' + s.key);
        dot.setAttribute('cx', cx); dot.setAttribute('cy', yAt(s.values[i]));
        dot.style.display = '';
        rows += '<div class="tt-row"><span class="k"><span class="tt-sw" style="background:' + s.color + '"></span>' + s.label + '</span><b>' + fmt(s.values[i]) + '</b></div>';
      });
      tooltip.innerHTML = '<div class="tt-day">' + labels[i] + '</div>' + rows;
      tooltip.style.display = 'block';
      tooltip.style.left = Math.min(evt.clientX + 14, window.innerWidth - 160) + 'px';
      tooltip.style.top = (evt.clientY + 14) + 'px';
    });
    hit.addEventListener('mouseleave', function () {
      cross.style.display = 'none';
      tooltip.style.display = 'none';
      active.forEach(function (s) { document.getElementById(mountId + '-dot-' + s.key).style.display = 'none'; });
    });
  }

  function legendHtml() {
    if (!opts.toggle || series.length < 2) return '';
    return '<div class="legend">' + series.map(function (s) {
      return '<div class="legend-item ' + (visible[s.key] ? '' : 'off') + '" data-key="' + s.key + '">' +
        '<span class="legend-sw" style="background:' + s.color + '"></span>' + s.label + '</div>';
    }).join('') + '</div>';
  }

  draw();

  if (opts.toggle) {
    mount.addEventListener('click', function (e) {
      var item = e.target.closest ? e.target.closest('.legend-item') : null;
      if (!item) return;
      var key = item.getAttribute('data-key');
      var willHide = visible[key];
      var remaining = series.filter(function (s) { return visible[s.key]; }).length;
      if (willHide && remaining <= 1) return; // keep at least one series visible
      visible[key] = !visible[key];
      draw();
    });
  }
}

function pluck(series, field) {
  return series.map(function (p) { return p[field]; });
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

    var s = d.dailySeries || [];
    var labels = pluck(s, 'day');
    lineChart('tsChart', labels, [
      { key: 'humans',  label: 'Page visits',    color: 'var(--s-visits)', values: pluck(s, 'humans') },
      { key: 'uniques', label: 'Unique visitors', color: 'var(--s-unique)', values: pluck(s, 'uniques') },
      { key: 'clicks',  label: 'Link clicks',    color: 'var(--s-clicks)', values: pluck(s, 'clicks') },
      { key: 'bots',    label: 'Crawler hits',   color: 'var(--s-bots)',   values: pluck(s, 'bots') }
    ], { toggle: true });

    lineChart('ctrChart', labels, [
      { key: 'ctr', label: 'CTR', color: 'var(--accent)', values: pluck(s, 'ctr') }
    ], { format: function (v) { return v + '%'; } });

    splitBar(document.getElementById('splitBar'), d.humanVisits, d.botVisits);

    bars(document.getElementById('clicksByLink'), d.clicksByLink, 'link_id');
    bars(document.getElementById('deviceSplit'), d.deviceSplit, 'device');
    bars(document.getElementById('countrySplit'), d.countrySplit, 'country');
    bars(document.getElementById('referrerSplit'), d.referrerSplit, 'referrer');
    bars(document.getElementById('botTypeSplit'), d.botTypeSplit, 'bot_type');
    bars(document.getElementById('utmSource'), d.utmSourceSplit, 'utm_source');
    bars(document.getElementById('utmMedium'), d.utmMediumSplit, 'utm_medium');
    bars(document.getElementById('utmCampaign'), d.utmCampaignSplit, 'utm_campaign');
  }).catch(function (e) {
    document.getElementById('err').textContent = 'Invalid token or no data yet.';
  });
}

document.getElementById('unlock').addEventListener('click', function () {
  token = document.getElementById('token').value;
  load();
});
document.getElementById('token').addEventListener('keydown', function (e) {
  if (e.key === 'Enter') { token = this.value; load(); }
});
document.getElementById('days').addEventListener('change', load);
</script>
</body>
</html>`;
}
