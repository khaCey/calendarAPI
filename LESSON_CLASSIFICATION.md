# Lesson classification (demo / normal / owner)

The Calendar API uses **three calendars** and encodes lesson type in the data sent to the React app.

## Calendars (Config.js)

| Calendar        | Config variable     | Purpose                          |
|----------------|---------------------|----------------------------------|
| Main           | `CALENDAR_ID`       | Regular student lessons          |
| Demo           | `DEMO_CALENDAR_ID`  | Demo lessons                     |
| Owner          | `OWNER_CALENDAR_ID` | Owner lessons (e.g. Sham)        |

`MonthlyCache.js` → `getAllEventsForMonth()` fetches from all three and merges events. Classification is then expressed in the **polling payload** as follows.

## What the GAS sends (POLLING_API_SPEC / MonthlyCache)

Each row has:

- **`status`** — Can be `scheduled`, `reserved`, `rescheduled`, `cancelled`, or **`demo`**.
  - **Order in `processEventsForMonth()` (MonthlyCache.js):** title `(placeholder)` → `reserved`; title `[RESCHEDULED]` → `rescheduled`; else **event color**: `8`/`9` → `cancelled`; **`5` (Banana / YELLOW)** → **`reserved`**; `11` (Tomato) → `demo`; otherwise **`scheduled`** (initial default).
  - **Reservations** come from **Banana (`5`)** or `(placeholder)` in the title. **Reschedules** use the **`[RESCHEDULED]`** title tag (evaluated before color) so they stay `rescheduled` even when the event still has a color.

- **`teacherName`** — Set to `'Sham'` when the event comes from **`OWNER_CALENDAR_ID`** (`event.getOriginalCalendarId() === OWNER_CALENDAR_ID`).
  - So **owner lessons** are identified by `teacherName === 'Sham'` (owner calendar only; not a separate “owner” status).

- **No** separate field like `lessonType` or `calendarSource` is sent. The React app can derive:
  - **Demo** → `status === 'demo'`
  - **Owner** → `teacherName === 'Sham'` (and optionally treat as “owner” lesson)
  - **Normal** → everything else (scheduled/reserved/rescheduled, not demo, not owner)

## Stored in React app (PostgreSQL)

`monthly_schedule` already stores:

- `status` (so `'demo'` is persisted)
- `teacher_name` (so owner is identifiable as teacher = Sham)

So **“monthly students (not demo)”** can be implemented by querying distinct students from `monthly_schedule` for a given month and excluding rows where `status = 'demo'`. No schema change is required for that. If you want an explicit **lesson_kind** (e.g. `demo` | `normal` | `owner`) for reporting, you can add it in GAS (e.g. from calendar ID) and in the Node sync + schema.
