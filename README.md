# Calendar Webhook (Apps Script)

Apps Script webhook for **Google Calendar API push notifications**. When calendar events are created or updated, Google POSTs to the deployed Web App; we fetch events and update the `lessons_today` sheet.

## Architecture

- **Code.js** — Entry point: `doGet` (web app UI), `doPost` (webhook), `registerCalendarWatch`
- **LegacyCode.js** — Reference: `fetchAndCacheTodayLessons` and related logic
- **appsscript.json** — Calendar API v3 advanced service enabled

## Setup

1. **Deploy as Web App**
   - In the script editor: Deploy > New deployment > Web app
   - Execute as: **Me**
   - Who has access: **Anyone** (so Google can POST to the webhook)
   - Copy the deployment URL (e.g. `https://script.google.com/macros/s/XXX/exec`)

2. **Enable Calendar API**
   - Resources > Advanced Google services > Enable "Google Calendar API"

3. **Register the watch**
   - Run `registerCalendarWatch(webhookUrl)` from the script editor, passing your deployment URL
   - Re-run every ~6 days (channels expire)

4. **Optional: remove 15‑minute trigger**
   - If using webhooks, you may no longer need `scheduledLessonCacheUpdate` every 15 min
