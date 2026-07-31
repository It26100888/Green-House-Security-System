# 🌿 Green House Security Monitoring System (GHSM)

A working demo build: static HTML/CSS/JS dashboard + a PHP/SQLite REST API.

## Run it

You need PHP installed (no extra packages, no Composer, no Node build step).

```bash
cd green-house-security-monitoring
php -S localhost:8000
```

Then open **http://localhost:8000** in a browser.

That's it — `php -S` serves `index.html`, `css/`, `js/` as static files and
routes `php/api.php` as the API. The SQLite database file is created
automatically on first request at `database/ghsm.sqlite`.

### If you don't have PHP

Just open `index.html` directly in a browser. The frontend detects that
`php/api.php` isn't reachable and transparently switches to an in-memory
JS mock of the exact same API, so every page still works — it just won't
persist between page reloads.

## How the demo data works

There is no real ESP32 in this repo. Instead, `js/app.js` includes a
"Demo Mode" simulator that generates fake sensor readings and RFID scans
and **posts them to the same API endpoints a real ESP32 would call**
(`POST /api/sensors`, `POST /api/rfid/scan`). The dashboard only ever
reads from the database via `GET` endpoints — it has no idea whether the
data came from the simulator or a real device.

To connect real hardware later:
1. Point your ESP32's HTTP client at `http://<server-ip>:8000/php/api.php`.
2. Have it `POST` sensor readings to `?route=sensors` and RFID UIDs to
   `?route=rfid/scan` on every card read.
3. Turn **DEMO MODE** off in the header. Nothing else changes.

## What's implemented

- Dashboard with live status cards, environment chart, security timeline
- Security page: door lock/unlock (with confirmation dialog), RFID scanner
  animation (Ready → Scanning → Granted/Denied), auto-lock countdown
- RFID Users: table, add/register card (simulated scan), enable/disable/delete
- Access Records: search, filter (result/door state), date range, sort,
  pagination, CSV export
- Environment Monitoring: 4 live charts (temp/humidity/soil/light) with
  1h/6h/24h/7d/30d range selector
- Device Controls: fan / pump / light / buzzer / door with OFF/ON/AUTO modes
- Alerts: severity-coded list, mark as read / mark all as read, auto-created
  on unauthorized access and threshold breaches
- Settings: auto-lock duration, thresholds, automation toggles (persisted)
- Fully responsive: fixed sidebar on desktop, hamburger drawer on mobile

## What a real deployment would still need (see the "hard parts" discussion)

- Real authentication on the admin/API endpoints (currently open, per the
  spec's "university demo" scope — see `SECURITY REQUIREMENTS` in the brief)
- TLS between ESP32 and server, and a shared secret/HMAC on device requests
  so a spoofed device can't inject fake "GRANTED" scans
- A real-time channel (WebSocket / SSE / Supabase Realtime) instead of the
  current polling interval, if you need sub-second dashboard updates
- Swapping SQLite for Postgres/MySQL for concurrent multi-client writes

## Project structure

```text
green-house-security-monitoring/
├── index.html
├── css/style.css
├── js/app.js
├── php/
│   ├── db.php      (schema + seed data, auto-run on first request)
│   └── api.php     (REST endpoints)
└── database/
    └── schema.sql  (reference copy of the schema)
```
