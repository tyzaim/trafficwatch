# 🚦 TrafficWatch v2

Real-time traffic monitor for two routes using the TomTom API.
No browser/Puppeteer needed — lightweight and cloud-ready.

## Local Setup

```bash
# Set your TomTom API key
export TOMTOM_KEY=your_key_here

# Run it
node server.js
```

Then open http://localhost:3000

## Configuration

All config is via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `TOMTOM_KEY` | required | Your TomTom API key |
| `PORT` | 3000 | Dashboard port |
| `INTERVAL_MIN` | 5 | Minutes between checks |
| `LOG_FILE` | traffic-log.csv | CSV log file path |
| `ROUTES` | Nicosia routes | JSON array of route objects |

### Custom routes

Set the `ROUTES` environment variable as a JSON array:

```json
[
  {
    "name": "Outbound",
    "origin": { "lat": 35.1856, "lng": 33.3823, "label": "Messios, Nicosia" },
    "dest":   { "lat": 35.1667, "lng": 33.3500, "label": "Gesfi Döviz, Metehan" }
  },
  {
    "name": "Return",
    "origin": { "lat": 35.1667, "lng": 33.3500, "label": "Gesfi Döviz, Metehan" },
    "dest":   { "lat": 35.1856, "lng": 33.3823, "label": "Messios, Nicosia" }
  }
]
```

## Deploy to Railway

1. Push this folder to a GitHub repository
2. Go to railway.app and create a new project from your GitHub repo
3. Add environment variable: `TOMTOM_KEY` = your key
4. Railway auto-deploys and gives you a public URL

## API Endpoints

- `GET /` — Live dashboard
- `GET /api/readings` — Raw JSON data
- `GET /health` — Health check
