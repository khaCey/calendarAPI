# Green Square Student Number Tag API

This branch is a **standalone Apps Script API** derived from `calendarAPI/master` for one purpose only:

> Let REACT-ADMIN inspect existing Green Square Calendar lesson events and add the canonical student-number tag to the event description.

Canonical tag:

```text
[GS_STUDENT_IDS:123]
[GS_STUDENT_IDS:123,456]
```

## Safety boundary

This branch does **not** expose the normal `calendarAPI` booking, polling, teacher-calendar, cache, delete, create, move, title, or color functionality.

The only write action is a Calendar API `Events.patch` containing **only**:

```js
{ description: nextDescription }
```

It does not send title, start/end, recurrence, attendees, location, or color fields.

Existing descriptions are preserved. If a conflicting student ID is already present, the API refuses the update.

## Actions

### `student_number_tag_preview`

Read-only. Finds the existing event/occurrence across the configured regular/demo/owner calendars and returns its current description and parsed student IDs.

### `student_number_tag_update`

Description-only write. Adds or normalizes the canonical `[GS_STUDENT_IDS:...]` tag. Existing conflicting student metadata causes `STUDENT_ID_MISMATCH` and no write.

## Deployment — IMPORTANT

Do **not** deploy this branch to the existing `calendarAPI` Apps Script project used by the Teacher Calendar App.

The branch intentionally does not contain the live `.clasp.json` binding.

1. Create a **new standalone Apps Script project**.
2. Copy `.clasp.json.example` to `.clasp.json` locally.
3. Put the new Apps Script project's script ID into `.clasp.json`.
4. Push this branch to that new project with `clasp push`.
5. In Apps Script Project Settings → Script properties, add:

```text
STUDENT_NUMBER_TAG_API_KEY=<dedicated secret>
```

6. Deploy as a Web App:
   - Execute as: the Green Square account that can edit the lesson calendars
   - Access: appropriate for the server-to-server setup
7. Put the deployment URL and the same secret in the REACT-ADMIN server `.env`:

```text
STUDENT_NUMBER_TAG_GAS_URL=https://script.google.com/macros/s/.../exec
STUDENT_NUMBER_TAG_API_KEY=...
```

8. Restart the REACT-ADMIN server/PM2 process.

## REACT-ADMIN isolation

Only **Admin → Calendar Student ID Backfill** uses this API.

All existing REACT-ADMIN booking, polling, staff schedule, Calendar, LINE, and other API paths remain unchanged.
