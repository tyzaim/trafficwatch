# TrafficWatch — Claude Context & Project Memory

> Last updated: 2026-02-28  
> Purpose: Full context for any new Claude session picking up this project.

---

## Project Overview

**TrafficWatch** is a real-time traffic monitoring system for the two main UN Buffer Zone crossing points in Nicosia, Cyprus:

- **Metehan** (Agios Dometios / Metehan) — the main city crossing
- **Astromeritis** (Astromeritis / Zodia) — the western crossing

The system polls the TomTom Routing API every 5 minutes to measure actual driving time vs. free-flow time for both directions of each crossing, logs results to CSV, and serves a live dashboard over HTTP.

**Why this project exists:** These crossings are the only way to cross between the Republic of Cyprus (south) and the Turkish-occupied north. Queues can be severe and unpredictable, especially at Metehan during morning rush hours. The goal is to make wait times visible and searchable over time.

---

## System Architecture

### Stack

- **Runtime:** Node.js (no dependencies — pure stdlib only: `http`, `https`, `fs`)
- **API:** TomTom Routing API v1 (`calculateRoute` endpoint with `traffic=true`)
- **Hosting:** Railway (deployed via GitHub push)
- **Storage:** Flat CSV files (one per route, written to Railway's ephemeral filesystem)
- **Frontend:** Single-page HTML dashboard served inline from `server.js`

### Files

```
trafficwatch-v2/
├── server.js        # Everything: polling, CSV logging, HTTP server, live dashboard
├── package.json     # name + version only, no deps
├── railway.toml     # [deploy] startCommand = "node server.js"
└── README.md
```

### Environment Variables (Railway)

| Variable        | Purpose                          |
|-----------------|----------------------------------|
| `TOMTOM_KEY`    | TomTom API key                   |
| `INTERVAL_MIN`  | Poll interval in minutes (default: 5) |
| `PORT`          | HTTP port (Railway sets this)    |
| `DOWNLOAD_USER` | Basic auth username for CSV download |
| `DOWNLOAD_PASS` | Basic auth password for CSV download |

### Routes Monitored

Each crossing is polled in both directions:

| Crossing     | Direction | Origin coords           | Dest coords             |
|-------------|-----------|-------------------------|-------------------------|
| Metehan     | S→N       | 35.177, 33.324 (south)  | 35.182, 33.323 (north)  |
| Metehan     | N→S       | 35.190, 33.327 (north)  | 35.180, 33.325 (south)  |
| Astromeritis| S→N       | 35.145, 33.036 (south)  | 35.159, 33.019 (north)  |
| Astromeritis| N→S       | 35.159, 33.019 (north)  | 35.145, 33.036 (south)  |

---

## Architecture Decisions & Rationale

### Why no npm dependencies?
Railway's free tier has cold starts and ephemeral storage. Keeping the entire app as a single `server.js` with zero dependencies means:
- No `npm install` step needed (faster deploys)
- Nothing can break due to package version issues
- Easy to read and audit

### Why TomTom instead of Google Maps?
TomTom's free tier includes live traffic data. Google Maps routing API charges per request and doesn't offer a meaningful free tier for this use case.

### Why flat CSV instead of a database?
- No infrastructure needed (no Postgres addon, no cost)
- CSV files are directly downloadable for offline analysis
- Data volume is small: ~288 rows/day per route = ~1000 rows/route per 4 days
- The download endpoint uses HTTP Basic Auth to prevent casual scraping

### Why inline HTML dashboard in server.js?
Avoids any static file serving complexity. The dashboard uses Chart.js via CDN and updates every 30 seconds by fetching `/api/status`. No build step, no bundler.

### Why Cyprus timezone (+2) for all timestamps?
The crossings are in Cyprus. All display times are converted to `Asia/Nicosia`. CSV files store UTC ISO timestamps for portability.

---

## Dashboard Design (Analysis Dashboard)

The analysis dashboard (`traffic-analysis.html`) uses a newspaper/editorial aesthetic:

- **Fonts:** Fraunces (serif headlines) + DM Mono (data/numbers) from Google Fonts
- **Colors:** Cream background (`#faf8f3`), ink text (`#1a1a1a`), with severity color coding
  - LOW: green (`#2d6a4f`)
  - MODERATE: amber (`#b45309`)
  - HIGH: red (`#991b1b`)
- **Layout:** Stats grid → Key findings prose → Timeline charts → Heatmap → Delay distribution

### Chart Refinements Applied

After initial charts looked too visually noisy:
- Line thickness reduced: traffic lines 1px (was 2px), normal baseline 0.75px dashed
- Point dots removed (`pointRadius: 0`, `pointHoverRadius: 3`)
- Y-axis: always starts at 0, shared dynamic max per crossing (max of both routes + 15% headroom)
- This gives a cleaner, more editorial look appropriate for the newspaper style

---

## Data Findings (4-Day Dataset: Feb 24–28, 2026)

### Metehan N→S: SEVERE CONGESTION
The worst-performing route. Normal time is ~10 minutes but actual times regularly hit 30–43 minutes during business hours.

- Peak traffic time: **43 min** (normal: 10 min)
- Peak delay: **34 min**
- 176 HIGH severity readings, 135 MODERATE readings out of ~1003 total
- **Wednesday Feb 25:** Congestion 08:56–13:11 (sustained 11–23 min delays)
- **Thursday Feb 26:** Congestion 08:56–13:46 (peak 33 min delay at 11:21)
- **Friday Feb 27:** Worst day — congestion 07:06–18:16 (peak 34 min delay at 13:01–13:36)

Pattern: Delays are almost exclusively **morning rush hours** (7am–2pm), with Friday being significantly worse than mid-week.

### Metehan S→N: MODERATE ISSUES
- Peak traffic time: **17 min** (normal: 9 min)
- Peak delay: **12 min**
- 1 HIGH reading, 69 MODERATE readings
- Notable: **Friday Feb 27** had delays 15:41–22:26 (evening return traffic), peak 12 min at 22:11
- Thursday Feb 26 had a late-night spike at 23:01–23:16 (6 min delay — unusual)

### Astromeritis: ESSENTIALLY STABLE
- Both directions consistently 4–7 minutes
- Zero MODERATE or HIGH readings for S→N
- N→S: max delay was 2 minutes total across the entire dataset
- This crossing is far less used and appears congestion-free

---

## What Didn't Work / Approaches We Abandoned

### Initial coordinate attempts for Metehan
The first set of TomTom waypoints placed origin/dest too close together (within the buffer zone itself), causing TomTom to return routes that didn't actually cross the checkpoint. Had to move coordinates further south/north to ensure the calculated route goes through the actual crossing point.

### Trying to use TomTom's "traffic incidents" endpoint
Explored using TomTom's incident API to get queue length data directly. The endpoint returned data but the incident polygons didn't align well with the crossing geometry — the calculated route travel time difference proved more reliable and consistent.

### Weather integration (partially shelved)
The server.js has infrastructure comments suggesting weather data was intended to be added as a correlation layer. This was not implemented in the final deployed version because the Cyprus Met Office API required registration, and OpenWeatherMap's free tier had rate limits that conflicted with the 5-minute polling cycle.

---

## Current State of the Code

### `server.js` (deployed to Railway)
- Polls TomTom every `INTERVAL_MIN` minutes for all 4 routes simultaneously
- Logs to 4 CSV files: `log-metehan-s2n.csv`, `log-metehan-n2s.csv`, `log-astromeritis-s2n.csv`, `log-astromeritis-n2s.csv`
- Severity classification: LOW = delay < 3 min, MODERATE = 3–9 min, HIGH = 10+ min
- HTTP endpoints:
  - `GET /` — live dashboard (Chart.js, auto-refreshes every 30s)
  - `GET /api/status` — JSON with current readings + last 24h data
  - `GET /download/:filename` — Basic Auth protected CSV download
- Chart refinements applied: thin lines, no dots, shared Y-axis max per crossing

### `traffic-analysis.html` (offline analysis dashboard)
- Standalone single-file HTML consuming the 4-day CSV dataset
- Newspaper aesthetic (Fraunces + DM Mono)
- Contains: stats grid, key findings narrative, per-route timeline charts, day-of-week heatmap, delay distribution histogram

---

## Next Steps

### Immediate
- [ ] **Deploy updated server.js to Railway** — push the chart-refined version to GitHub to trigger Railway redeploy
- [ ] **Build the comprehensive 4-day analysis dashboard** — the analysis dashboard work was interrupted before completion; the data is analyzed and ready, the HTML file needs to be finalized

### Short-term
- [ ] **Add day-of-week heatmap to live dashboard** — the analysis showed clear patterns (Friday worst); a heatmap of average delay by hour×day would be valuable on the live site
- [ ] **Persist CSVs across Railway restarts** — Railway has ephemeral storage; CSVs are lost on each deploy/restart. Options: Railway Volume (persistent disk), push CSV data to a free Supabase DB, or use a scheduled GitHub commit job.
- [ ] **Extend severity thresholds** — current thresholds (3/10 min) were set empirically; with more data, recalibrate based on observed distribution (Metehan N→S is very different from Astromeritis)

### Longer-term
- [ ] **Predictive layer** — with enough historical data, build a simple model predicting "expect X min delay on Fridays at 11am at Metehan N→S"
- [ ] **Alerts** — webhook or email when delay crosses a threshold (useful for people who cross regularly)
- [ ] **Mobile-friendly dashboard** — current dashboard is desktop-first

---

## Key Files Reference

| File | Location | Description |
|------|----------|-------------|
| `server.js` | `/mnt/user-data/outputs/trafficwatch-v2/server.js` | Main app (deployed) |
| `package.json` | `/mnt/user-data/outputs/trafficwatch-v2/package.json` | Minimal, no deps |
| `railway.toml` | `/mnt/user-data/outputs/trafficwatch-v2/railway.toml` | Deploy config |
| `traffic-analysis.html` | `/mnt/user-data/outputs/traffic-analysis.html` | Offline analysis dashboard |
| 4-day CSV data | `/mnt/user-data/uploads/log-*__*.csv` | Feb 24–28 dataset |

---

## Quick Reference: TomTom API Call

```
GET https://api.tomtom.com/routing/1/calculateRoute/{lat1,lng1}:{lat2,lng2}/json
  ?key={TOMTOM_KEY}
  &traffic=true
  &travelMode=car
  &routeType=fastest
  &computeTravelTimeFor=all
```

Response fields used:
- `routes[0].summary.travelTimeInSeconds` → actual (with traffic) travel time
- `routes[0].summary.noTrafficTravelTimeInSeconds` → free-flow baseline
- Delay = `travelTime - noTrafficTravelTime`

---

*This file was generated from conversation history on 2026-02-28.*
