#!/usr/bin/env node
/**
 * TrafficWatch — TomTom API edition
 * No browser/Puppeteer needed. Lightweight, cloud-ready.
 */

const http = require('http');
const https = require('https');
const fs   = require('fs');
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────────────────
const config = {
  tomtomKey:   process.env.TOMTOM_KEY   || '',
  intervalMin: parseInt(process.env.INTERVAL_MIN || '5'),
  dashPort:    parseInt(process.env.PORT          || '3000'),
  logFile:     process.env.LOG_FILE      || 'traffic-log.csv',
  routes: JSON.parse(process.env.ROUTES || JSON.stringify([
    {
      name:    'South to North',
      logFile: 'log-south-to-north.csv',
      origin:  { lat: 35.17738946649458,  lng: 33.323703790315996, label: 'South' },
      dest:    { lat: 35.18248230357691,  lng: 33.32297160214468,  label: 'North' },
    },
    {
      name:    'North to South',
      logFile: 'log-north-to-south.csv',
      origin:  { lat: 35.189972638909815, lng: 33.3267300933598,   label: 'North' },
      dest:    { lat: 35.17997580404659,  lng: 33.32508411149086,  label: 'South' },
    },
  ])),
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
const now  = () => new Date().toLocaleString();
const log  = (...a) => console.log(`\x1b[36m[${now()}]\x1b[0m`, ...a);
const warn = (...a) => console.warn(`\x1b[33m[${now()}] ⚠\x1b[0m`, ...a);
const ok   = (...a) => console.log(`\x1b[32m[${now()}] ✔\x1b[0m`, ...a);
const err  = (...a) => console.error(`\x1b[31m[${now()}] ✖\x1b[0m`, ...a);

// ─── In-memory store ─────────────────────────────────────────────────────────
// readings[routeIndex] = array of { timestamp, trafficMin, normalMin, delay, level, freeFlowMin }
const readings = config.routes.map(() => []);

// ─── CSV ──────────────────────────────────────────────────────────────────────
function ensureCsv() {
  config.routes.forEach(r => {
    if (!fs.existsSync(r.logFile)) {
      fs.writeFileSync(r.logFile,
        'timestamp,route,origin,destination,traffic_min,normal_min,delay_min,traffic_level\n');
    }
  });
}

function appendCsv(routeIdx, row) {
  const r = config.routes[routeIdx];
  const line = [
    `"${row.timestamp}"`,
    `"${r.name}"`,
    `"${r.origin.label}"`,
    `"${r.dest.label}"`,
    row.trafficMin,
    row.normalMin,
    row.delay,
    `"${row.level}"`,
  ].join(',') + '\n';
  fs.appendFileSync(r.logFile, line);
}

// ─── TomTom API ───────────────────────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Invalid JSON response')); }
      });
    }).on('error', reject);
  });
}

async function fetchRoute(origin, dest) {
  // TomTom Routing API — returns travel time with and without traffic
  const url =
    `https://api.tomtom.com/routing/1/calculateRoute/` +
    `${origin.lat},${origin.lng}:${dest.lat},${dest.lng}/json` +
    `?key=${config.tomtomKey}` +
    `&traffic=true` +
    `&travelMode=car` +
    `&routeType=fastest` +
    `&computeTravelTimeFor=all`;

  const data = await httpsGet(url);

  if (!data.routes || data.routes.length === 0) {
    throw new Error(data.detailedError?.message || 'No route returned from TomTom');
  }

  const route   = data.routes[0];
  const summary = route.summary;

  const trafficSec   = summary.travelTimeInSeconds;
  const normalSec    = summary.noTrafficTravelTimeInSeconds ?? summary.travelTimeInSeconds;
  const freeFlowSec  = summary.historicTrafficTravelTimeInSeconds ?? normalSec;

  return {
    trafficMin:  Math.round(trafficSec  / 60),
    normalMin:   Math.round(freeFlowSec / 60),
    distanceKm:  +(summary.lengthInMeters / 1000).toFixed(1),
  };
}

// ─── Traffic classifier ───────────────────────────────────────────────────────
function trafficLevel(delay) {
  if (delay <= 2)  return 'LOW';
  if (delay <= 10) return 'MODERATE';
  return 'HIGH';
}

// ─── Check all routes ─────────────────────────────────────────────────────────
async function checkAll() {
  for (let i = 0; i < config.routes.length; i++) {
    const route = config.routes[i];
    log(`Checking: ${route.origin.label} → ${route.dest.label}`);
    try {
      const result = await fetchRoute(route.origin, route.dest);
      const delay  = Math.max(0, result.trafficMin - result.normalMin);
      const level  = trafficLevel(delay);
      const row    = {
        timestamp:  new Date().toISOString(),
        trafficMin: result.trafficMin,
        normalMin:  result.normalMin,
        distanceKm: result.distanceKm,
        delay,
        level,
      };
      readings[i].push(row);
      if (readings[i].length > 500) readings[i].shift();
      appendCsv(i, row);

      const lc = level === 'LOW' ? '\x1b[32m' : level === 'MODERATE' ? '\x1b[33m' : '\x1b[31m';
      ok(`${route.name}: ${route.origin.label} → ${route.dest.label}`);
      console.log(`   🚗 With traffic : \x1b[36m${result.trafficMin} min\x1b[0m`);
      console.log(`   🗺  Normal       : ${result.normalMin} min`);
      console.log(`   ⏱  Delay        : ${delay > 0 ? '+' : ''}${delay} min`);
      console.log(`   📊 Traffic level: ${lc}${level}\x1b[0m`);
      console.log(`   📍 Distance     : ${result.distanceKm} km\n`);
    } catch(e) {
      err(`Route ${route.name} failed: ${e.message}`);
    }
  }
}

// ─── Dashboard HTML ───────────────────────────────────────────────────────────
function buildDashboard() {
  const routeData = config.routes.map((r, i) => ({
    name:     r.name,
    origin:   r.origin.label,
    dest:     r.dest.label,
    readings: readings[i],
    latest:   readings[i][readings[i].length - 1] || null,
  }));

  const chartData = routeData.map(r => ({
    labels:  r.readings.slice(-12).map(x => new Date(x.timestamp).toLocaleTimeString('en-CY', {hour:'2-digit', minute:'2-digit', timeZone:'Asia/Nicosia'})),
    traffic: r.readings.slice(-12).map(x => x.trafficMin),
    normal:  r.readings.slice(-12).map(x => x.normalMin),
  }));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>TrafficWatch</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --white: #ffffff;
    --bg: #f5f5f3;
    --card: #ffffff;
    --border: #e8e8e4;
    --text: #1a1a18;
    --muted: #8a8a85;
    --low: #16a34a;
    --low-bg: #f0fdf4;
    --low-border: #bbf7d0;
    --mod: #d97706;
    --mod-bg: #fffbeb;
    --mod-border: #fde68a;
    --high: #dc2626;
    --high-bg: #fef2f2;
    --high-border: #fecaca;
    --blue: #2563eb;
    --blue-light: #eff6ff;
  }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'DM Sans', sans-serif;
    min-height: 100vh;
    padding: 0;
  }

  /* Header */
  .header {
    background: var(--white);
    border-bottom: 1px solid var(--border);
    padding: 16px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px;
    position: sticky;
    top: 0;
    z-index: 10;
  }

  .header-left { display: flex; align-items: center; gap: 10px; }

  .logo-icon {
    width: 36px; height: 36px;
    background: var(--text);
    border-radius: 10px;
    display: flex; align-items: center; justify-content: center;
    font-size: 18px;
  }

  .site-title { font-size: 18px; font-weight: 700; letter-spacing: -0.3px; }
  .site-title span { color: var(--muted); font-weight: 400; }

  .header-right { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }

  .live-badge {
    display: flex; align-items: center; gap: 6px;
    font-size: 12px; color: var(--low);
    font-family: 'DM Mono', monospace;
    background: var(--low-bg);
    border: 1px solid var(--low-border);
    border-radius: 100px;
    padding: 4px 12px;
  }

  .live-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--low);
    animation: blink 2s infinite;
  }

  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.3} }

  .last-updated {
    font-size: 12px;
    color: var(--muted);
    font-family: 'DM Mono', monospace;
  }

  /* Main content */
  .main { max-width: 1100px; margin: 0 auto; padding: 28px 20px; }

  /* Route cards */
  .routes-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    margin-bottom: 16px;
  }

  .route-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
  }

  .route-card-header {
    padding: 20px 24px 16px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .route-direction {
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    letter-spacing: -0.2px;
  }

  .route-sub {
    font-size: 12px;
    color: var(--muted);
    margin-top: 2px;
    font-family: 'DM Mono', monospace;
  }

  .status-pill {
    flex-shrink: 0;
    padding: 4px 12px;
    border-radius: 100px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.3px;
    font-family: 'DM Mono', monospace;
    text-transform: uppercase;
  }

  .pill-LOW    { background: var(--low-bg);  color: var(--low);  border: 1px solid var(--low-border); }
  .pill-MODERATE { background: var(--mod-bg); color: var(--mod); border: 1px solid var(--mod-border); }
  .pill-HIGH   { background: var(--high-bg); color: var(--high); border: 1px solid var(--high-border); }
  .pill-none   { background: var(--bg); color: var(--muted); border: 1px solid var(--border); }

  /* Big numbers */
  .metrics-row {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    padding: 20px 24px;
    gap: 0;
    border-bottom: 1px solid var(--border);
  }

  .metric { padding: 0 16px 0 0; }
  .metric + .metric { padding-left: 16px; border-left: 1px solid var(--border); }

  .metric-label {
    font-size: 11px;
    font-weight: 500;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.8px;
    margin-bottom: 8px;
  }

  .metric-value {
    font-size: 42px;
    font-weight: 700;
    letter-spacing: -2px;
    line-height: 1;
    color: var(--text);
  }

  .metric-value.low      { color: var(--low); }
  .metric-value.moderate { color: var(--mod); }
  .metric-value.high     { color: var(--high); }
  .metric-value.blue     { color: var(--blue); }

  .metric-unit {
    font-size: 12px;
    color: var(--muted);
    margin-top: 4px;
    font-family: 'DM Mono', monospace;
  }

  /* Chart */
  .chart-area { padding: 20px 24px; }

  .chart-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.8px;
    margin-bottom: 14px;
  }

  .chart-wrap { height: 140px; position: relative; }

  .no-data {
    padding: 40px 24px;
    text-align: center;
    color: var(--muted);
    font-size: 13px;
    font-family: 'DM Mono', monospace;
  }

  /* Log table */
  .log-card {
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 16px;
    overflow: hidden;
    margin-bottom: 16px;
  }

  .log-card-header {
    padding: 16px 24px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
  }

  .table-wrap { overflow-x: auto; }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }

  th {
    text-align: left;
    padding: 10px 16px;
    font-size: 11px;
    font-weight: 500;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }

  td {
    padding: 11px 16px;
    border-bottom: 1px solid var(--border);
    color: var(--text);
    font-family: 'DM Mono', monospace;
    font-size: 12px;
    white-space: nowrap;
  }

  tr:last-child td { border-bottom: none; }
  tr:hover td { background: var(--bg); }

  .pill {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 100px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.3px;
    text-transform: uppercase;
  }

  .pill-LOW    { background: var(--low-bg);  color: var(--low);  border: 1px solid var(--low-border); }
  .pill-MODERATE { background: var(--mod-bg); color: var(--mod); border: 1px solid var(--mod-border); }
  .pill-HIGH   { background: var(--high-bg); color: var(--high); border: 1px solid var(--high-border); }

  /* Footer */
  footer {
    text-align: center;
    font-size: 12px;
    color: var(--muted);
    font-family: 'DM Mono', monospace;
    padding: 20px;
  }

  /* Responsive */
  @media (max-width: 700px) {
    .routes-grid { grid-template-columns: 1fr; }
    .metrics-row { grid-template-columns: 1fr 1fr; }
    .metric-value { font-size: 32px; }
    .header { padding: 12px 16px; }
    .main { padding: 16px; }
  }

  @media (max-width: 400px) {
    .metrics-row { grid-template-columns: 1fr; }
    .metric + .metric { border-left: none; border-top: 1px solid var(--border); padding-left: 0; padding-top: 12px; margin-top: 12px; }
  }
</style>
</head>
<body>

<div class="header">
  <div class="header-left">
    <div class="logo-icon">🚦</div>
    <div class="site-title">TrafficWatch <span>/ Live</span></div>
  </div>
  <div class="header-right">
    <div class="last-updated">Updated: ${new Date().toLocaleTimeString('en-CY', {hour:'2-digit', minute:'2-digit', second:'2-digit', timeZone:'Asia/Nicosia'})}</div>
    <div class="live-badge"><div class="live-dot"></div> Live · refreshes 30s</div>
  </div>
</div>

<div class="main">

  <div class="routes-grid">
    ${routeData.map((r, idx) => {
      const l = r.latest;
      const level = l ? l.level : null;
      const cls = level === 'LOW' ? 'low' : level === 'MODERATE' ? 'moderate' : level === 'HIGH' ? 'high' : '';
      return `<div class="route-card">
      <div class="route-card-header">
        <div>
          <div class="route-direction">${r.name}</div>
          <div class="route-sub">${r.origin} → ${r.dest}</div>
        </div>
        <div class="status-pill ${level ? 'pill-'+level : 'pill-none'}">${level || 'Waiting'}</div>
      </div>
      ${l ? `
      <div class="metrics-row">
        <div class="metric">
          <div class="metric-label">With Traffic</div>
          <div class="metric-value ${cls}">${l.trafficMin}</div>
          <div class="metric-unit">minutes</div>
        </div>
        <div class="metric">
          <div class="metric-label">Normal</div>
          <div class="metric-value blue">${l.normalMin}</div>
          <div class="metric-unit">minutes</div>
        </div>
        <div class="metric">
          <div class="metric-label">Delay</div>
          <div class="metric-value ${cls}">${l.delay > 0 ? '+' : ''}${l.delay}</div>
          <div class="metric-unit">minutes extra</div>
        </div>
      </div>
      <div class="chart-area">
        <div class="chart-label">Travel time — last ${Math.min(r.readings.length, 12)} checks</div>
        <div class="chart-wrap">
          <canvas id="chart-${idx}"></canvas>
        </div>
      </div>` : `<div class="no-data">Waiting for first reading...</div>`}
    </div>`;
    }).join('')}
  </div>

  <div class="log-card">
    <div class="log-card-header">Recent readings</div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Route</th>
            <th>With Traffic</th>
            <th>Normal</th>
            <th>Delay</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          ${readings.flatMap((arr, i) => arr.map(r => ({...r, routeName: config.routes[i].name})))
            .sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp))
            .slice(0, 60)
            .map((r, rowIdx) => {
              const pairIdx = Math.floor(rowIdx / 2);
              const bg = pairIdx % 2 === 0 ? '' : 'background:#f9f9f7;';
              return `<tr style="${bg}">
              <td>${new Date(r.timestamp).toLocaleTimeString('en-CY', {hour:'2-digit', minute:'2-digit', timeZone:'Asia/Nicosia'})}</td>
              <td>${r.routeName}</td>
              <td>${r.trafficMin} min</td>
              <td>${r.normalMin} min</td>
              <td>${r.delay > 0 ? '+' : ''}${r.delay} min</td>
              <td><span class="pill pill-${r.level}">${r.level}</span></td>
            </tr>`;
            }).join('')}
        </tbody>
      </table>
    </div>
  </div>

</div>

<footer>TrafficWatch · Checks every ${config.intervalMin} min · Powered by TomTom</footer>

<script>
const chartData = ${JSON.stringify(chartData)};

chartData.forEach((d, idx) => {
  const canvas = document.getElementById('chart-' + idx);
  if (!canvas || d.labels.length === 0) return;

  new Chart(canvas, {
    type: 'line',
    data: {
      labels: d.labels,
      datasets: [
        {
          label: 'With Traffic',
          data: d.traffic,
          borderColor: '#dc2626',
          backgroundColor: 'rgba(220,38,38,0.06)',
          borderWidth: 2,
          pointRadius: 3,
          pointBackgroundColor: '#dc2626',
          fill: true,
          tension: 0.4,
        },
        {
          label: 'Normal',
          data: d.normal,
          borderColor: '#2563eb',
          backgroundColor: 'transparent',
          borderWidth: 1.5,
          borderDash: [4, 4],
          pointRadius: 2,
          pointBackgroundColor: '#2563eb',
          fill: false,
          tension: 0.4,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          labels: {
            color: '#8a8a85',
            font: { family: 'DM Mono', size: 11 },
            boxWidth: 16,
            padding: 12,
          }
        },
        tooltip: {
          backgroundColor: '#fff',
          borderColor: '#e8e8e4',
          borderWidth: 1,
          titleColor: '#1a1a18',
          bodyColor: '#8a8a85',
          padding: 10,
          callbacks: {
            label: ctx => ' ' + ctx.dataset.label + ': ' + ctx.parsed.y + ' min'
          }
        }
      },
      scales: {
        x: {
          ticks: { color: '#8a8a85', font: { family: 'DM Mono', size: 10 }, maxTicksLimit: 8 },
          grid: { color: '#f0f0ee' }
        },
        y: {
          ticks: { color: '#8a8a85', font: { family: 'DM Mono', size: 10 } },
          grid: { color: '#f0f0ee' },
          beginAtZero: false,
        }
      }
    }
  });
});
</script>

</body></html>`;
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────
function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/readings') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ routes: config.routes, readings }));
      return;
    }
    if (req.url === '/health') {
      res.writeHead(200); res.end('OK'); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(buildDashboard());
  });
  server.listen(config.dashPort, () => {
    ok(`Dashboard → http://localhost:${config.dashPort}`);
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n\x1b[36m╔══════════════════════════════════╗');
  console.log('║    TrafficWatch v2.0 (TomTom)    ║');
  console.log('╚══════════════════════════════════╝\x1b[0m\n');

  if (!config.tomtomKey) {
    err('No TomTom API key! Set TOMTOM_KEY environment variable.');
    process.exit(1);
  }

  ensureCsv();
  startServer();

  config.routes.forEach(r => log(`Monitoring: ${r.origin.label} → ${r.dest.label}`));
  console.log();

  await checkAll();
  setInterval(checkAll, config.intervalMin * 60 * 1000);

  process.on('SIGINT', () => {
    log('Shutting down...');
    process.exit(0);
  });
}

main().catch(e => { err(e.message); process.exit(1); });
