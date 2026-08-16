# Private Google Calendar Booking API (Apps Script)

This branch adapts the original Green Square Calendar webhook into a backend for the LINE MINI App sandbox. It uses the **private primary Google Calendar of the account that deploys the Apps Script project**.

The LINE MINI App remains hosted at `https://booking.kaelenoer.com/`. Cloudflare calls this GAS web app server-to-server; the browser must not call GAS directly.

## Safety defaults

- `CALENDAR_ID` defaults to the Calendar API keyword `primary`.
- The Green Square calendar and spreadsheet IDs are not present on this branch.
- Regular, demo and owner bookings all use the private primary calendar unless separate IDs are explicitly configured.
- Availability returns only merged busy intervals. It never returns private event titles, descriptions, attendees or event IDs.
- Booking creation and rescheduling use `LockService` and check the calendar again while holding the lock to prevent two API requests from taking the same slot.
- Rescheduling is limited to a single 50-minute lesson occurrence. Whole-series time moves are rejected.
- The Green Square spreadsheet synchronisation and contact-sync code are not included on this branch, so the project requests calendar access only.
- The old tracked `.clasp.json` was removed so this branch cannot accidentally push into the existing Green Square Apps Script project.

## Create a separate Apps Script project

Do **not** deploy this branch into the existing Green Square Apps Script project.

1. Sign in to the Google account whose private calendar should be used.
2. Create a new standalone Apps Script project.
3. Copy `.clasp.json.example` to `.clasp.json` locally and replace the placeholder with the new project ID, or copy the source files into the Apps Script editor.
4. Confirm that the advanced Google Calendar service is enabled. It is declared in `appsscript.json` as Calendar API v3.
5. Open **Project Settings → Script properties** and add:
   - `BOOKING_API_KEY`: a long random secret shared only with the Cloudflare Worker.
   - `PRIVATE_CALENDAR_ID`: optional. Leave it unset to use the account's primary private calendar.
6. Run `authorisePrivateCalendarOnce()` in the editor and approve calendar access. Check the execution log to confirm the expected calendar name and time zone.
7. Deploy as a Web app:
   - Execute as: **Me**
   - Who has access: **Anyone**
8. Store the resulting `/exec` URL and `BOOKING_API_KEY` as Cloudflare Worker secrets. Never put the key in browser JavaScript.

The manifest and calendar use `Asia/Tokyo`.

## API

All requests require the shared key. In production, only the Cloudflare Worker sends it. POST is preferred so the key stays in the request body rather than the URL.

### Health

```http
GET /exec?action=health&key=BOOKING_API_KEY
```

### Private availability

Preferred Worker request:

```http
POST /exec
Content-Type: application/json

{
  "action": "availability",
  "key": "BOOKING_API_KEY",
  "date": "2026-08-20"
}
```

GET remains available for manual diagnostics:

One day in Japan:

```http
GET /exec?action=availability&date=2026-08-20&key=BOOKING_API_KEY
```

Or an explicit RFC 3339 window of up to 31 days:

```http
GET /exec?action=availability&timeMin=2026-08-20T00:00:00%2B09:00&timeMax=2026-08-21T00:00:00%2B09:00&key=BOOKING_API_KEY
```

Example response:

```json
{
  "ok": true,
  "timeZone": "Asia/Tokyo",
  "window": {
    "timeMin": "2026-08-19T15:00:00.000Z",
    "timeMax": "2026-08-20T15:00:00.000Z"
  },
  "busy": [
    {
      "start": "2026-08-20T01:00:00.000Z",
      "end": "2026-08-20T01:50:00.000Z"
    }
  ]
}
```

The Cloudflare app converts the busy windows into the public 50-minute availability grid and displays occupied slots as `満席`.

### Create a booking

```http
POST /exec
Content-Type: application/json

{
  "action": "lesson_book_create",
  "key": "BOOKING_API_KEY",
  "lessonKind": "regular",
  "title": "LINE Booking 8K4M2",
  "start": "2026-08-20T10:00:00+09:00",
  "end": "2026-08-20T10:50:00+09:00",
  "bookingKey": "an-opaque-unique-booking-id"
}
```

If another event overlaps the requested period, GAS returns:

```json
{
  "ok": false,
  "error": "Slot unavailable",
  "code": "SLOT_UNAVAILABLE"
}
```

`bookingKey` makes retries idempotent: resending the same booking returns the existing calendar event instead of creating a duplicate.

### Reschedule a booking

Rescheduling extends the existing `lesson_book_update` action. Supplying both `start` and `end` opts into a time move. Metadata-only `lesson_book_update` requests continue to behave as before.

Normal lesson:

```http
POST /exec
Content-Type: application/json

{
  "action": "lesson_book_update",
  "key": "BOOKING_API_KEY",
  "eventId": "opaque-calendar-event-id",
  "updateScope": "thisInstanceOnly",
  "start": "2026-08-22T15:00:00+09:00",
  "end": "2026-08-22T15:50:00+09:00"
}
```

For a recurring lesson occurrence, include the original occurrence start so only that occurrence is moved:

```json
{
  "action": "lesson_book_update",
  "key": "BOOKING_API_KEY",
  "eventId": "series-or-instance-id",
  "seriesMasterId": "series-master-id",
  "occurrenceStartIso": "2026-08-20T01:00:00.000Z",
  "updateScope": "thisInstanceOnly",
  "start": "2026-08-22T15:00:00+09:00",
  "end": "2026-08-22T15:50:00+09:00"
}
```

Successful response:

```json
{
  "ok": true,
  "actionTaken": "rescheduled",
  "eventId": "resolved-event-id",
  "start": "2026-08-22T06:00:00.000Z",
  "end": "2026-08-22T06:50:00.000Z"
}
```

Reschedule rules:

- `start` and `end` must both be supplied.
- The new duration must be exactly 50 minutes.
- `updateScope` must be `thisInstanceOnly`.
- Recurring lessons require `occurrenceStartIso`.
- The destination slot is checked again while holding the booking lock.
- An occupied destination returns the same `SLOT_UNAVAILABLE` error used by booking creation.
- Metadata fields supported by the existing update action (`title`, color fields, and Student Admin description metadata) can be included in the same reschedule request.

The existing `lesson_book_delete`, `lesson_book_delete_series` and `reserved_hold_recurring_create` actions remain available and are routed through the configured private calendar.

## Tests

```bash
node tests/lesson_book_delete.test.mjs
node tests/private_calendar.test.mjs
node tests/reschedule.test.mjs
```
