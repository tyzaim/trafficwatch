#!/usr/bin/env node
/**
 * Nicosia Crossing Traffic Monitor v3
 * Monitors all Nicosia crossings in real time using TomTom API
 */

const http  = require('http');
const https = require('https');
const fs    = require('fs');

// ─── Crossings config ─────────────────────────────────────────────────────────
const CROSSINGS = [
  {
    id:          'metehan',
    name:        'Agios Dometios / Metehan',
    shortName:   'Metehan',
    description: 'Main Nicosia city crossing',
    routes: [
      {
        name:    'South to North',
        logFile: 'log-metehan-s2n.csv',
        origin:  { lat: 35.17738946649458,  lng: 33.323703790315996, label: 'South' },
        dest:    { lat: 35.18248230357691,  lng: 33.32297160214468,  label: 'North' },
      },
      {
        name:    'North to South',
        logFile: 'log-metehan-n2s.csv',
        origin:  { lat: 35.189972638909815, lng: 33.3267300933598,   label: 'North' },
        dest:    { lat: 35.17997580404659,  lng: 33.32508411149086,  label: 'South' },
      },
    ],
  },
  {
    id:          'astromeritis',
    name:        'Astromeritis / Zodia',
    shortName:   'Astromeritis',
    description: 'West Nicosia crossing',
    routes: [
      {
        name:    'South to North',
        logFile: 'log-astromeritis-s2n.csv',
        origin:  { lat: 35.14493622086859,  lng: 33.03599537704171,  label: 'South' },
        dest:    { lat: 35.15883484408819,  lng: 33.01875938024711,  label: 'North' },
      },
      {
        name:    'North to South',
        logFile: 'log-astromeritis-n2s.csv',
        origin:  { lat: 35.15883484408819,  lng: 33.01876659029276,  label: 'North' },
        dest:    { lat: 35.14498045733702,  lng: 33.03600414981479,  label: 'South' },
      },
    ],
  },
];

const CONFIG = {
  tomtomKey:    process.env.TOMTOM_KEY     || '',
  intervalMin:  parseInt(process.env.INTERVAL_MIN || '5'),
  port:         parseInt(process.env.PORT         || '3000'),
  downloadUser: process.env.DOWNLOAD_USER  || 'admin',
  downloadPass: process.env.DOWNLOAD_PASS  || '',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const cyprusTime = (date, extra={}) =>
  new Date(date).toLocaleTimeString('en-CY', { timeZone:'Asia/Nicosia', hour:'2-digit', minute:'2-digit', ...extra });
const nowStr = () => new Date().toLocaleString('en-CY', { timeZone:'Asia/Nicosia' });
const log  = (...a) => console.log(`\x1b[36m[${nowStr()}]\x1b[0m`, ...a);
const ok   = (...a) => console.log(`\x1b[32m[${nowStr()}] ✔\x1b[0m`, ...a);
const err  = (...a) => console.error(`\x1b[31m[${nowStr()}] ✖\x1b[0m`, ...a);

// ─── In-memory readings ───────────────────────────────────────────────────────
const readings = CROSSINGS.map(c => c.routes.map(() => []));

// ─── CSV ──────────────────────────────────────────────────────────────────────
function ensureCsv() {
  CROSSINGS.forEach(c => c.routes.forEach(r => {
    if (!fs.existsSync(r.logFile))
      fs.writeFileSync(r.logFile, 'timestamp,crossing,route,traffic_min,normal_min,delay_min,traffic_level\n');
  }));
}

function appendCsv(ci, ri, row) {
  const c = CROSSINGS[ci], r = c.routes[ri];
  fs.appendFileSync(r.logFile,
    `"${row.timestamp}","${c.name}","${r.name}",${row.trafficMin},${row.normalMin},${row.delay},"${row.level}"\n`);
}

// ─── TomTom API ───────────────────────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let d = '';
      res.on('data', chunk => d += chunk);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(new Error('Invalid JSON')); } });
    }).on('error', reject);
  });
}

async function fetchRoute(origin, dest) {
  const url = `https://api.tomtom.com/routing/1/calculateRoute/${origin.lat},${origin.lng}:${dest.lat},${dest.lng}/json?key=${CONFIG.tomtomKey}&traffic=true&travelMode=car&routeType=fastest&computeTravelTimeFor=all`;
  const data = await httpsGet(url);
  if (!data.routes?.length) throw new Error(data.detailedError?.message || 'No route');
  const s = data.routes[0].summary;
  return {
    trafficMin: Math.round(s.travelTimeInSeconds / 60),
    normalMin:  Math.round((s.historicTrafficTravelTimeInSeconds ?? s.noTrafficTravelTimeInSeconds ?? s.travelTimeInSeconds) / 60),
    distanceKm: +(s.lengthInMeters / 1000).toFixed(1),
  };
}

// TomTom Flow Segment Data — current speed at a point
async function fetchSpeed(lat, lng) {
  try {
    const url = `https://api.tomtom.com/traffic/services/4/flowSegmentData/absolute/10/json?key=${CONFIG.tomtomKey}&point=${lat},${lng}&unit=KMPH`;
    const data = await httpsGet(url);
    const fd = data.flowSegmentData;
    if (!fd) return null;
    return {
      currentSpeed:  Math.round(fd.currentSpeed),
      freeFlowSpeed: Math.round(fd.freeFlowSpeed),
      speedPct:      Math.round((fd.currentSpeed / fd.freeFlowSpeed) * 100),
    };
  } catch(e) {
    return null;
  }
}

// Open-Meteo — free weather API, no key needed
// Use Nicosia coordinates for weather (applies to both crossings)
let weatherCache = null;
let weatherLastFetch = 0;

async function fetchWeather() {
  // Cache weather for 10 minutes to avoid unnecessary calls
  if (weatherCache && Date.now() - weatherLastFetch < 10 * 60 * 1000) return weatherCache;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=35.185&longitude=33.382&current=temperature_2m,precipitation,weather_code,wind_speed_10m&timezone=Asia/Nicosia&wind_speed_unit=kmh`;
    const data = await httpsGet(url);
    const c = data.current;
    weatherCache = {
      tempC:       Math.round(c.temperature_2m),
      precipitation: c.precipitation,
      windKmh:     Math.round(c.wind_speed_10m),
      condition:   weatherDescription(c.weather_code),
      icon:        weatherIcon(c.weather_code),
    };
    weatherLastFetch = Date.now();
    return weatherCache;
  } catch(e) {
    return null;
  }
}

function weatherDescription(code) {
  if (code === 0)           return 'Clear sky';
  if (code <= 2)            return 'Partly cloudy';
  if (code === 3)           return 'Overcast';
  if (code <= 49)           return 'Foggy';
  if (code <= 59)           return 'Drizzle';
  if (code <= 69)           return 'Rain';
  if (code <= 79)           return 'Snow';
  if (code <= 82)           return 'Rain showers';
  if (code <= 86)           return 'Snow showers';
  if (code <= 99)           return 'Thunderstorm';
  return 'Unknown';
}

function weatherIcon(code) {
  if (code === 0)           return '☀️';
  if (code <= 2)            return '⛅';
  if (code === 3)           return '☁️';
  if (code <= 49)           return '🌫️';
  if (code <= 69)           return '🌧️';
  if (code <= 79)           return '❄️';
  if (code <= 82)           return '🌦️';
  if (code <= 86)           return '🌨️';
  if (code <= 99)           return '⛈️';
  return '🌡️';
}

function trafficLevel(delay) {
  if (delay <= 2) return 'LOW';
  if (delay <= 10) return 'MODERATE';
  return 'HIGH';
}

async function checkAll() {
  // Fetch weather once per cycle
  const weather = await fetchWeather();
  if (weather) ok(`Weather: ${weather.icon} ${weather.condition} ${weather.tempC}°C wind:${weather.windKmh}km/h`);

  for (let ci = 0; ci < CROSSINGS.length; ci++) {
    const crossing = CROSSINGS[ci];
    for (let ri = 0; ri < crossing.routes.length; ri++) {
      const route = crossing.routes[ri];
      try {
        const [result, speed] = await Promise.all([
          fetchRoute(route.origin, route.dest),
          fetchSpeed(route.origin.lat, route.origin.lng),
        ]);
        const delay  = Math.max(0, result.trafficMin - result.normalMin);
        const level  = trafficLevel(delay);
        const row    = {
          timestamp: new Date().toISOString(),
          trafficMin: result.trafficMin,
          normalMin:  result.normalMin,
          distanceKm: result.distanceKm,
          delay,
          level,
          speed: speed || null,
          weather: weather || null,
        };
        readings[ci][ri].push(row);
        if (readings[ci][ri].length > 1000) readings[ci][ri].shift();
        appendCsv(ci, ri, row);
        const lc = level==='LOW'?'\x1b[32m':level==='MODERATE'?'\x1b[33m':'\x1b[31m';
        ok(`[${crossing.shortName}] ${route.name}: ${result.trafficMin}min  delay:+${delay}  ${lc}${level}\x1b[0m${speed ? `  ⚡${speed.currentSpeed}km/h (${speed.speedPct}%)` : ''}`);
      } catch(e) {
        err(`[${crossing.shortName}] ${route.name}: ${e.message}`);
      }
    }
  }
}

// ─── Trend calculator ─────────────────────────────────────────────────────────
function calcTrend(arr) {
  if (arr.length < 3) return { arrow: '', color: '' };
  const last3 = arr.slice(-3);
  const first  = last3[0].trafficMin;
  const latest = last3[2].trafficMin;
  const diff   = latest - first;
  if (diff >= 2)  return { arrow: '↑', color: 'var(--high)' };
  if (diff <= -2) return { arrow: '↓', color: 'var(--low)'  };
  return { arrow: '→', color: 'var(--muted)' };
}


const CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#f5f5f3;--card:#fff;--border:#e8e8e4;--text:#1a1a18;--muted:#8a8a85;
  --low:#16a34a;--low-bg:#f0fdf4;--low-b:#bbf7d0;
  --mod:#d97706;--mod-bg:#fffbeb;--mod-b:#fde68a;
  --high:#dc2626;--high-bg:#fef2f2;--high-b:#fecaca;
  --blue:#2563eb;}
body{background:var(--bg);color:var(--text);min-height:100vh;font-family:'DM Sans',sans-serif}
.header{background:#fff;border-bottom:1px solid var(--border);padding:14px 24px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;position:sticky;top:0;z-index:10}
.logo{display:flex;align-items:center;gap:10px}
.logo-icon{width:34px;height:34px;background:var(--text);border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:17px}
.site-title{font-size:17px;font-weight:700;letter-spacing:-.3px}
.site-title span{color:var(--muted);font-weight:400}
.header-right{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.live-badge{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--low);background:var(--low-bg);border:1px solid var(--low-b);border-radius:100px;padding:4px 12px;font-family:'DM Mono',monospace}
.dot{width:6px;height:6px;border-radius:50%;background:var(--low);animation:blink 2s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
.updated{font-size:12px;color:var(--muted);font-family:'DM Mono',monospace}
.main{max-width:1100px;margin:0 auto;padding:28px 20px}
.pill{display:inline-block;padding:3px 10px;border-radius:100px;font-size:11px;font-weight:600;letter-spacing:.3px;text-transform:uppercase;font-family:'DM Mono',monospace}
.pill-LOW{background:var(--low-bg);color:var(--low);border:1px solid var(--low-b)}
.pill-MODERATE{background:var(--mod-bg);color:var(--mod);border:1px solid var(--mod-b)}
.pill-HIGH{background:var(--high-bg);color:var(--high);border:1px solid var(--high-b)}
.pill-none{background:var(--bg);color:var(--muted);border:1px solid var(--border)}
.card{background:var(--card);border:1px solid var(--border);border-radius:16px;overflow:hidden}
.card-header{padding:18px 22px;border-bottom:1px solid var(--border);display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.card-title{font-size:14px;font-weight:600}
.card-sub{font-size:12px;color:var(--muted);margin-top:2px;font-family:'DM Mono',monospace}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:10px 16px;font-size:11px;font-weight:500;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;background:var(--bg);border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:11px 16px;border-bottom:1px solid var(--border);color:var(--text);font-family:'DM Mono',monospace;font-size:12px;white-space:nowrap}
tr:last-child td{border-bottom:none}
tr:hover td{background:var(--bg)}
footer{text-align:center;font-size:12px;color:var(--muted);font-family:'DM Mono',monospace;padding:20px}
a{color:var(--blue);text-decoration:none}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
.metric-big{font-size:40px;font-weight:700;letter-spacing:-2px;line-height:1}
.metric-label{font-size:11px;font-weight:500;color:var(--muted);text-transform:uppercase;letter-spacing:.8px;margin-bottom:8px}
.metric-unit{font-size:11px;color:var(--muted);margin-top:4px;font-family:'DM Mono',monospace}
@media(max-width:700px){.grid-2{grid-template-columns:1fr}.main{padding:16px}.header{padding:12px 16px}}
`;

const HEAD = (title) => `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>${title}</title>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<style>${CSS}</style></head><body>`;

const TOPBAR = (sub='') => `<div class="header">
  <div class="logo">
    <div class="logo-icon">🚦</div>
    <div class="site-title">Nicosia Crossings <span>${sub ? '/ '+sub : '/ Live'}</span></div>
  </div>
  <div class="header-right">
    <div class="updated">Cyprus: ${cyprusTime(new Date(), {second:'2-digit'})}</div>
    <div class="live-badge"><div class="dot"></div>Live · 30s</div>
  </div>
</div>`;

// ─── Main page ────────────────────────────────────────────────────────────────
function buildMainPage() {
  const levels = ['LOW','MODERATE','HIGH'];
  // Get latest weather from any reading
  let weather = null;
  for (let ci = 0; ci < CROSSINGS.length && !weather; ci++)
    for (let ri = 0; ri < CROSSINGS[ci].routes.length && !weather; ri++) {
      const arr = readings[ci][ri];
      if (arr.length) weather = arr[arr.length-1].weather;
    }

  return HEAD('Nicosia Crossings — Live Traffic') + TOPBAR() + `<div class="main">
  <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:24px">
    <div>
      <div style="font-size:22px;font-weight:700;letter-spacing:-.5px;margin-bottom:4px">Nicosia Crossing Monitor</div>
      <div style="font-size:14px;color:var(--muted)">Live traffic at all Nicosia checkpoints · Updated every ${CONFIG.intervalMin} minutes</div>
    </div>
    ${weather ? `<div style="display:flex;align-items:center;gap:10px;background:#fff;border:1px solid var(--border);border-radius:12px;padding:10px 16px;font-size:13px;flex-shrink:0">
      <span style="font-size:22px">${weather.icon}</span>
      <div>
        <div style="font-weight:600;color:var(--text)">${weather.condition}</div>
        <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--muted)">${weather.tempC}°C · Wind ${weather.windKmh} km/h${weather.precipitation > 0 ? ' · 🌧 '+weather.precipitation+'mm' : ''}</div>
      </div>
    </div>` : ''}
  </div>

  <div class="grid-2">
    ${CROSSINGS.map((c,ci) => {
      const l0 = readings[ci][0][readings[ci][0].length-1]||null;
      const l1 = readings[ci][1][readings[ci][1].length-1]||null;
      const worst = l0&&l1 ? levels[Math.max(levels.indexOf(l0.level),levels.indexOf(l1.level))] : null;
      return `<div class="card" style="cursor:pointer" onclick="location.href='/${c.id}'">
        <div class="card-header">
          <div><div class="card-title">${c.name}</div><div class="card-sub">${c.description}</div></div>
          <span class="pill ${worst?'pill-'+worst:'pill-none'}">${worst||'Waiting'}</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;border-top:1px solid var(--border)">
          ${[l0,l1].map((l,ri)=>{
            const col = l?(l.level==='LOW'?'var(--low)':l.level==='MODERATE'?'var(--mod)':'var(--high)'):'var(--muted)';
            const trend = calcTrend(readings[ci][ri]);
            return `<div style="padding:16px 20px;${ri===1?'border-left:1px solid var(--border)':''}">
              <div class="metric-label">${c.routes[ri].name}</div>
              <div style="display:flex;align-items:baseline;gap:6px">
                <div class="metric-big" style="color:${col}">${l?l.trafficMin:'--'}</div>
                ${trend.arrow?`<span style="font-size:22px;font-weight:700;color:${trend.color};line-height:1">${trend.arrow}</span>`:''}
              </div>
              <div class="metric-unit">minutes${l?(l.delay>0?' · +'+l.delay+' delay':''):''}</div>
              ${l&&l.speed?`<div style="font-size:11px;color:var(--muted);margin-top:4px;font-family:'DM Mono',monospace">⚡ ${l.speed.currentSpeed} km/h (${l.speed.speedPct}% normal)</div>`:''}
            </div>`;
          }).join('')}
        </div>
        <div style="padding:12px 20px;background:var(--bg);border-top:1px solid var(--border);font-size:12px;color:var(--blue);font-weight:500">View details & history →</div>
      </div>`;
    }).join('')}
  </div>

  <div class="card">
    <div class="card-header"><div class="card-title">Recent readings — all crossings</div></div>
    <div style="overflow-x:auto"><table>
      <thead><tr><th>Time</th><th>Crossing</th><th>Direction</th><th>Traffic</th><th>Delay</th><th>Speed</th><th>Status</th></tr></thead>
      <tbody>${(()=>{
        const all=[];
        CROSSINGS.forEach((c,ci)=>c.routes.forEach((r,ri)=>readings[ci][ri].forEach(rd=>all.push({...rd,cn:c.shortName,rn:r.name}))));
        return all.sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp)).slice(0,40)
          .map((r,i)=>`<tr style="${Math.floor(i/2)%2?'background:#f9f9f7':''}">
            <td>${cyprusTime(r.timestamp)}</td><td>${r.cn}</td><td>${r.rn}</td>
            <td>${r.trafficMin} min</td>
            <td>${r.delay>0?'+':''}${r.delay} min</td>
            <td>${r.speed?r.speed.currentSpeed+' km/h':'-'}</td>
            <td><span class="pill pill-${r.level}">${r.level}</span></td>
          </tr>`).join('');
      })()}</tbody>
    </table></div>
  </div>
</div>
<footer>Nicosia Crossings Monitor · Every ${CONFIG.intervalMin} min · TomTom + Open-Meteo</footer></body></html>`;
}

// ─── Detail page ──────────────────────────────────────────────────────────────
function buildDetailPage(id) {
  const ci = CROSSINGS.findIndex(c=>c.id===id);
  if (ci===-1) return null;
  const c = CROSSINGS[ci];

  const twelveHoursAgo = new Date(Date.now() - 12 * 60 * 60 * 1000);
  const chartData = c.routes.map((r,ri)=>{
    const last12h = readings[ci][ri].filter(x => new Date(x.timestamp) >= twelveHoursAgo);
    return {
      labels:  last12h.map(x=>cyprusTime(x.timestamp)),
      traffic: last12h.map(x=>x.trafficMin),
      normal:  last12h.map(x=>x.normalMin),
      count:   last12h.length,
    };
  });

  // Get latest weather reading
  let latestWeather = null;
  for (let ri = 0; ri < c.routes.length && !latestWeather; ri++) {
    const arr = readings[ci][ri];
    if (arr.length) latestWeather = arr[arr.length-1].weather;
  }

  return HEAD(`${c.name} — Live Traffic`) + TOPBAR(c.shortName) + `<div class="main">
  <div style="margin-bottom:20px;display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px">
    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <a href="/">← All crossings</a>
      <span style="color:var(--border)">|</span>
      <div>
        <div style="font-size:20px;font-weight:700;letter-spacing:-.4px">${c.name}</div>
        <div style="font-size:13px;color:var(--muted)">${c.description}</div>
      </div>
    </div>
    ${latestWeather ? `<div style="display:flex;align-items:center;gap:10px;background:#fff;border:1px solid var(--border);border-radius:12px;padding:10px 16px;font-size:13px;flex-shrink:0">
      <span style="font-size:22px">${latestWeather.icon}</span>
      <div>
        <div style="font-weight:600;color:var(--text)">${latestWeather.condition}</div>
        <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--muted)">${latestWeather.tempC}°C · Wind ${latestWeather.windKmh} km/h${latestWeather.precipitation > 0 ? ' · 🌧 '+latestWeather.precipitation+'mm' : ''}</div>
      </div>
    </div>` : ''}
  </div>

  <div class="grid-2">
    ${c.routes.map((route,ri)=>{
      const arr=readings[ci][ri];
      const l=arr[arr.length-1]||null;
      const level=l?l.level:null;
      const col=level==='LOW'?'var(--low)':level==='MODERATE'?'var(--mod)':level==='HIGH'?'var(--high)':'var(--muted)';
      return `<div class="card">
        <div class="card-header">
          <div><div class="card-title">${route.name}</div><div class="card-sub">${route.origin.label} → ${route.dest.label}</div></div>
          <span class="pill ${level?'pill-'+level:'pill-none'}">${level||'Waiting'}</span>
        </div>
        ${l?`
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;padding:18px 22px;border-bottom:1px solid var(--border)">
          <div>
            <div class="metric-label">With Traffic</div>
            <div style="display:flex;align-items:baseline;gap:6px">
              <div class="metric-big" style="color:${col};font-size:32px">${l.trafficMin}</div>
              ${(()=>{ const t=calcTrend(arr); return t.arrow?`<span style="font-size:20px;font-weight:700;color:${t.color}">${t.arrow}</span>`:''; })()}
            </div>
            <div class="metric-unit">minutes</div>
          </div>
          <div style="border-left:1px solid var(--border);padding-left:16px">
            <div class="metric-label">Delay</div>
            <div class="metric-big" style="color:${col};font-size:32px">${l.delay>0?'+':''}${l.delay}</div>
            <div class="metric-unit">minutes</div>
          </div>
          <div style="border-left:1px solid var(--border);padding-left:16px">
            <div class="metric-label">Speed</div>
            <div class="metric-big" style="color:var(--text);font-size:32px">${l.speed?l.speed.currentSpeed:'--'}</div>
            <div class="metric-unit">${l.speed?'km/h · '+l.speed.speedPct+'% normal':'no data'}</div>
          </div>
        </div>
        <div style="padding:18px 22px">
          <div class="metric-label" style="margin-bottom:12px">Last 12 hours (${Math.min(arr.filter(x=>new Date(x.timestamp)>=new Date(Date.now()-12*60*60*1000)).length,144)} readings)</div>
          <div style="height:180px;position:relative"><canvas id="chart-${ri}"></canvas></div>
        </div>`:`<div style="padding:40px;text-align:center;color:var(--muted);font-size:13px;font-family:'DM Mono',monospace">Waiting for first reading...</div>`}
      </div>`;
    }).join('')}
  </div>

  <div class="card">
    <div class="card-header"><div class="card-title">Full history — ${c.name}</div></div>
    <div style="overflow-x:auto"><table>
      <thead><tr><th>Time</th><th>Direction</th><th>Traffic</th><th>Delay</th><th>Speed</th><th>Weather</th><th>Status</th></tr></thead>
      <tbody>${(()=>{
        const all=[];
        c.routes.forEach((r,ri)=>readings[ci][ri].forEach(rd=>all.push({...rd,rn:r.name})));
        return all.sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp)).slice(0,80)
          .map((r,i)=>`<tr style="${Math.floor(i/2)%2?'background:#f9f9f7':''}">
            <td>${cyprusTime(r.timestamp)}</td><td>${r.rn}</td>
            <td>${r.trafficMin} min</td>
            <td>${r.delay>0?'+':''}${r.delay} min</td>
            <td>${r.speed?r.speed.currentSpeed+' km/h':'-'}</td>
            <td>${r.weather?r.weather.icon+' '+r.weather.tempC+'°C':'-'}</td>
            <td><span class="pill pill-${r.level}">${r.level}</span></td>
          </tr>`).join('');
      })()}</tbody>
    </table></div>
  </div>

  <div class="card" style="margin-top:16px">
    <div class="card-header"><div class="card-title">📥 Download log data</div></div>
    <div style="padding:18px 22px">
      ${(()=>{
        const allReadings=[];
        c.routes.forEach((r,ri)=>readings[ci][ri].forEach(rd=>allReadings.push(rd)));
        const oldest=allReadings.sort((a,b)=>new Date(a.timestamp)-new Date(b.timestamp))[0];
        const totalCount=readings[ci].reduce((sum,arr)=>sum+arr.length,0);
        const sinceStr=oldest?cyprusTime(oldest.timestamp,{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}):'No data yet';
        return `<div style="font-size:12px;color:var(--muted);font-family:'DM Mono',monospace;margin-bottom:16px">
          📊 Data collected since: ${sinceStr} · ${totalCount} readings in memory
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          ${c.routes.map(r=>{
            const slug=r.logFile.replace('log-','').replace('.csv','');
            return `<a href="/download/${slug}" style="display:inline-flex;align-items:center;gap:6px;padding:8px 16px;background:var(--blue);color:#fff;border-radius:8px;font-size:13px;font-weight:500;text-decoration:none">⬇ ${r.name}</a>`;
          }).join('')}
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:10px;font-family:'DM Mono',monospace">⚠ You will be prompted for your username and password</div>`;
      })()}
    </div>
  </div>

</div>
<footer>Nicosia Crossings Monitor · Every ${CONFIG.intervalMin} min · TomTom + Open-Meteo</footer>

<script>
const chartData=${JSON.stringify(chartData)};
chartData.forEach((d,idx)=>{
  const canvas=document.getElementById('chart-'+idx);
  if(!canvas||!d.labels.length) return;
  new Chart(canvas,{
    type:'line',
    data:{labels:d.labels,datasets:[
      {label:'With Traffic',data:d.traffic,borderColor:'#dc2626',backgroundColor:'rgba(220,38,38,0.06)',borderWidth:2,pointRadius:3,fill:true,tension:0.4},
      {label:'Normal',data:d.normal,borderColor:'#2563eb',backgroundColor:'transparent',borderWidth:1.5,borderDash:[4,4],pointRadius:2,fill:false,tension:0.4}
    ]},
    options:{responsive:true,maintainAspectRatio:false,
      interaction:{mode:'index',intersect:false},
      plugins:{
        legend:{labels:{color:'#8a8a85',font:{family:'DM Mono',size:11},boxWidth:16,padding:10}},
        tooltip:{backgroundColor:'#fff',borderColor:'#e8e8e4',borderWidth:1,titleColor:'#1a1a18',bodyColor:'#8a8a85',padding:10,
          callbacks:{label:ctx=>' '+ctx.dataset.label+': '+ctx.parsed.y+' min'}}
      },
      scales:{
        x:{ticks:{color:'#8a8a85',font:{family:'DM Mono',size:10},maxTicksLimit:12},grid:{color:'#f0f0ee'}},
        y:{ticks:{color:'#8a8a85',font:{family:'DM Mono',size:10}},grid:{color:'#f0f0ee'},beginAtZero:false}
      }
    }
  });
});
</script></body></html>`;
}

// ─── Basic Auth ───────────────────────────────────────────────────────────────
function checkAuth(req, res) {
  const authHeader = req.headers['authorization'];
  if (authHeader) {
    const b64 = authHeader.split(' ')[1] || '';
    const [user, pass] = Buffer.from(b64, 'base64').toString().split(':');
    if (user === CONFIG.downloadUser && pass === CONFIG.downloadPass) return true;
  }
  res.writeHead(401, {
    'WWW-Authenticate': 'Basic realm="TrafficWatch Downloads"',
    'Content-Type': 'text/plain',
  });
  res.end('Authentication required');
  return false;
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────
function startServer() {
  // Map of download slugs to log files
  const downloadMap = {};
  CROSSINGS.forEach(c => {
    c.routes.forEach(r => {
      // e.g. /download/metehan-s2n → log-metehan-s2n.csv
      const slug = r.logFile.replace('log-','').replace('.csv','');
      downloadMap[slug] = { file: r.logFile, name: r.logFile };
    });
  });

  http.createServer((req,res)=>{
    const url = req.url.split('?')[0];

    if (url === '/health') { res.writeHead(200); res.end('OK'); return; }

    if (url === '/api/data') {
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({crossings:CROSSINGS.map((c,ci)=>({
        id:c.id, name:c.name,
        routes:c.routes.map((r,ri)=>({name:r.name, latest:readings[ci][ri][readings[ci][ri].length-1]||null}))
      }))}));
      return;
    }

    // Download endpoints — password protected
    if (url.startsWith('/download/')) {
      if (!checkAuth(req, res)) return;
      const slug = url.replace('/download/','');
      const entry = downloadMap[slug];
      if (!entry || !fs.existsSync(entry.file)) {
        res.writeHead(404); res.end('File not found'); return;
      }
      const data = fs.readFileSync(entry.file);
      res.writeHead(200, {
        'Content-Type': 'text/csv',
        'Content-Disposition': `attachment; filename="${entry.name}"`,
      });
      res.end(data);
      return;
    }

    // Detail pages
    const id = url.replace('/','');
    if (id && CROSSINGS.find(c=>c.id===id)) {
      const html = buildDetailPage(id);
      res.writeHead(200, {'Content-Type':'text/html'});
      res.end(html);
      return;
    }

    // Main page
    res.writeHead(200, {'Content-Type':'text/html'});
    res.end(buildMainPage());

  }).listen(CONFIG.port, () => {
    ok(`Running at http://localhost:${CONFIG.port}`);
    CROSSINGS.forEach(c => ok(`  /${c.id}  →  ${c.name}`));
    ok(`Downloads: /download/<slug> (password protected)`);
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n\x1b[36m╔════════════════════════════════════════╗');
  console.log('║  Nicosia Crossings Monitor v3.0        ║');
  console.log('╚════════════════════════════════════════╝\x1b[0m\n');
  if(!CONFIG.tomtomKey){err('TOMTOM_KEY not set!');process.exit(1);}
  ensureCsv();
  startServer();
  CROSSINGS.forEach(c=>c.routes.forEach(r=>log(`Monitoring: [${c.shortName}] ${r.name}`)));
  console.log();
  await checkAll();
  setInterval(checkAll,CONFIG.intervalMin*60*1000);
  process.on('SIGINT',()=>{log('Shutting down...');process.exit(0);});
}

main().catch(e=>{err(e.message);process.exit(1);});
