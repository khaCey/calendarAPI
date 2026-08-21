# Green Square New Calendar Sync / Student Number API

This branch contains the isolated Calendar-mirror/tagging work for the rebuilt Green Square schedule system.

It does **not** replace or modify the existing production `calendarAPI` used by the Teacher Calendar App. That existing system remains untouched.

The new flow follows the Calendar Mirror specification:

```text
Google Calendar
      ↓ background/full sync
Calendar Mirror Spreadsheet
      ↓
monthlyLessons
      ↓
student_<ID>
      ↓
new API / REACT-ADMIN
```

Google Calendar remains the source of truth. Normal preview/read operations use the Sheet mirror rather than fetching Calendar events one-by-one.

## Spreadsheet mirror

The Apps Script project is attached to the Calendar Mirror spreadsheet. The code uses that spreadsheet directly via `SpreadsheetApp.getActiveSpreadsheet()`; no spreadsheet ID needs to be configured manually.

The mirror contains:

```text
monthlyLessons
studentsIndex
syncState
syncAudit
student_<ID>
```

`monthlyLessons` is the canonical Sheet mirror. `student_<ID>` tabs are derived indexes and can be rebuilt from `monthlyLessons`.

## Initial fetch

After updating the Apps Script code, run:

```js
setupCalendarMirrorSpreadsheet()
```

Then fetch the current month from the regular/demo/owner calendars and bulk-write the mirror:

```js
syncCurrentMonthToCalendarMirror()
```

For a specific month:

```js
syncMonthToCalendarMirror('2026-08')
```

The full sync:

1. Reads the three calendars.
2. Expands recurring occurrences with `singleEvents: true`.
3. Builds stable `eventKey` values.
4. Parses existing `[GS_STUDENT_IDS:...]` metadata when present.
5. Bulk-writes `monthlyLessons`.
6. Rebuilds the relevant `student_<ID>` tabs.
7. Updates `studentsIndex` and `syncState`.
8. Appends an `initial_sync` entry to `syncAudit`.

It does not use the existing Teacher Calendar API.

## Event identity

Normal event:

```text
<calendarSource>:<googleEventId>
```

Recurring occurrence:

```text
<calendarSource>:<recurringEventId>:<originalStartTime>
```

Titles and student names are display information, not event identity.

## Tagging

Canonical metadata:

```text
[GS_STUDENT_IDS:123]
[GS_STUDENT_IDS:123,456]
```

The only Calendar mutation exposed by this work is:

```js
Calendar.Events.patch(
  { description: nextDescription },
  calendarId,
  exactEventId
)
```

No title, time, recurrence, attendee, location or color fields are sent.

The tag flow is:

```text
Sheet mirror says ID missing
      ↓
student_number_tag_update
      ↓
resolve exact Calendar event
      ↓
check conflicting IDs
      ↓
patch description only
      ↓
re-read exact same Calendar event
      ↓
verify canonical tag
      ↓
upsert verified event into monthlyLessons
      ↓
rebuild affected student_<ID> index
      ↓
success
```

If the bound mirror spreadsheet cannot be accessed/written, tagging is refused **before** Calendar is mutated.

If Calendar succeeds but the mirror write unexpectedly fails, the API reports `MIRROR_WRITE_FAILED` and does not pretend the whole operation succeeded.

## Web actions

### `calendar_mirror_read_month`

Sheet-only read. Does not contact Google Calendar.

Example body:

```json
{
  "action": "calendar_mirror_read_month",
  "month": "2026-08"
}
```

### `calendar_mirror_sync_month`

Background/admin synchronization action. Reads Calendar and rebuilds the Sheet mirror for the requested month.

### `student_number_tag_update`

The direct Calendar tagging action. Description-only Calendar mutation plus exact verification and mirror update.

### Direct Calendar preview

`student_number_tag_preview` is intentionally disabled. Preview/read must use the Sheet mirror.

## Required Script Property

Only the API secret is required here:

```text
STUDENT_NUMBER_TAG_API_KEY=<dedicated secret>
```

There is no `CALENDAR_MIRROR_SPREADSHEET_ID` setup step.

## Updating the Apps Script

1. Use the Apps Script project attached to the Calendar Mirror spreadsheet.
2. Keep the local `.clasp.json` pointed at that Apps Script project's script ID.
3. Pull this branch.
4. Run `clasp push`.
5. Approve the Calendar + Google Sheets scopes if prompted.
6. Run `setupCalendarMirrorSpreadsheet()`.
7. Run `syncCurrentMonthToCalendarMirror()`.
8. Deploy a new version of the existing Web App deployment if the HTTP actions are being used.

## Isolation rule

The existing Teacher Calendar App and production `calendarAPI/master` remain untouched.
