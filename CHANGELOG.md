# Changelog

All notable changes to the Calendar Webhook app will be documented in this file.

## v.1.0.06.01 — Development
Date: 2026-02-18
Type: Dev Change

### Summary
- Fixed setValues row mismatch ("data has 8 but range has 9")

### Changes (detailed)

#### Fixed
- Functions.js — fetchAndCacheTodayLessons()
  - From: getRange(2, 1, out.length + 1, headers.length) — numRows was 1 too many
  - To: getRange(2, 1, out.length, headers.length)
- MonthlyCache.js — cacheEventsToSheet()
  - From: getRange(2, 1, validRows.length + 1, headers.length)
  - To: getRange(2, 1, validRows.length, headers.length)

---

## v.1.0.08.01 — Development
Date: 2026-02-18
Type: Dev Change

### Summary
- Prefer non-empty over empty when merging old status into lessons (folderName)

### Changes (detailed)

#### Fixed
- Functions.js — fetchAndCacheTodayLessons()
  - From: Always overwrite lesson.folderName with oldStatus.folderName (including empty)
  - To: Only use old folderName when it has a real folder (non-DEMO); else keep new from Student List

---

## v.1.0.08.00 — Production Release
Date: 2026-02-18
Type: Production

### Release Summary
- Config.js: single declaration for all shared constants

---

## v.1.0.07.02 — Development
Date: 2026-02-18
Type: Dev Change

### Summary
- Config.js: single declaration for all shared constants (Apps Script merges files)

### Changes (detailed)

#### Added
- Config.js — WEBHOOK_URL, WEBHOOK_LOG_SHEET, SS_ID, STUDENTLIST_SS_ID, ADMIN_SS_ID, CALENDAR_ID, DEMO_CALENDAR_ID, OWNER_CALENDAR_ID, STUDENTLIST, APPSTATE_SHEET_NAME

#### Changed
- Code.js, Functions.js, MonthlyCache.js — Removed duplicate declarations; use globals from Config.js

---

## v.1.0.07.01 — Development
Date: 2026-02-18
Type: Dev Change

### Summary
- Declare variables once only; MonthlyCache uses calendar IDs from Functions.js

### Changes (detailed)

#### Changed
- MonthlyCache.js
  - Removed duplicate LESSON_CALENDAR_ID, DEMO_CALENDAR_ID, SHAM_CALENDAR_ID
  - Uses CALENDAR_ID, DEMO_CALENDAR_ID, OWNER_CALENDAR_ID from Functions.js

---

## v.1.0.07.00 — Production Release
Date: 2026-02-18
Type: Production

### Release Summary
- Don't clear when combined data empty; MonthlyCache fetches from all 3 calendars

---

## v.1.0.06.02 — Development
Date: 2026-02-18
Type: Dev Change

### Summary
- Don't clear/write when combined data is empty (preserve existing)
- MonthlyCache fetches from all 3 calendars

### Changes (detailed)

#### Changed
- Functions.js — fetchAndCacheTodayLessons()
  - Early return when lessons.length === 0; skip clear/write to preserve existing data
- MonthlyCache.js
  - Added DEMO_CALENDAR_ID
  - getAllEventsForMonth() — From: main calendar only. To: fetch from all 3 calendars (main, demo, owner)
  - cacheEventsToSheet() — Fetch/process first; if validRows empty, return without clearing

---

## v.1.0.06.00 — Production Release
Date: 2026-02-18
Type: Production

### Release Summary
- Fixed duplicate SS_ID declaration (SyntaxError)

---

## v.1.0.05.01 — Development
Date: 2026-02-18
Type: Dev Change

### Summary
- Fixed duplicate SS_ID declaration (SyntaxError)

### Changes (detailed)

#### Fixed
- Code.js
  - Removed duplicate `const SS_ID` — use SS_ID from Functions.js (same Teacher Admin spreadsheet)

---

## v.1.0.05.00 — Production Release
Date: 2026-02-18
Type: Production

### Release Summary
- Functions.js, MonthlyCache.js (refactored from LegacyCode, Admin)
- doPost updates MonthlySchedule + NextMonthSchedule + lessons_today on POST

---

## v.1.0.04.01 — Development
Date: 2026-02-18
Type: Dev Change

### Summary
- Refactored: Functions.js (from LegacyCode), MonthlyCache.js (from Admin)
- doPost now updates MonthlySchedule/NextMonthSchedule + lessons_today on POST

### Changes (detailed)

#### Added
- Functions.js
  - fetchAndCacheTodayLessons(), getOrCreateAppStateSheet(), getLessonsTodayFingerprint(), getLessonsTodayStatuses(), getLessonStatus_(), getLessonLocationStatus_(), changeEventColor()
- MonthlyCache.js
  - cacheMonthlyEventsForBothMonths(), cacheEventsToSheet(), getAllEventsForMonth(), processEventsForMonth(), toYYYYMM()

#### Changed
- Code.js
  - doPost()
    - From: fetchAndCacheTodayLessons() only
    - To: cacheMonthlyEventsForBothMonths() + fetchAndCacheTodayLessons()
  - manualSync()
    - From: fetchAndCacheTodayLessons() only
    - To: cacheMonthlyEventsForBothMonths() + fetchAndCacheTodayLessons()

#### Removed
- Admin.js
- LegacyCode.js

---

## v.1.0.04.00 — Production Release
Date: 2026-02-18
Type: Production

### Release Summary
- Debug logging for POST requests (WebhookLog sheet)
- Use Postman to test webhook delivery

---

## v.1.0.03.01 — Development
Date: 2026-02-18
Type: Dev Change

### Summary
- Removed webhook-test Node app (cancelled)

---

## v.1.0.03.00 — Production Release
Date: 2026-02-18
Type: Production

### Release Summary
- Student List from separate spreadsheet
- Teacher Admin for lessons_today, AppState

---

## v.1.0.02.00 — Production Release
Date: 2026-02-18
Type: Production

### Release Summary
- Student List optional; Teacher Admin target

---

## v.1.0.01.05 — Development
Date: 2026-02-18
Type: Dev Change

### Summary
- Student List now read from separate spreadsheet (original sheet)

### Changes (detailed)

#### Changed
- LegacyCode.js
  - Added STUDENTLIST_SS_ID = 1IobCrDaNAPquEX0WKR8fLyh0p-Q9XutIdHHuu_3XXEg
  - STUDENTLIST
    - From: openById(SS_ID) — same as Teacher Admin
    - To: openById(STUDENTLIST_SS_ID) — Student List in original spreadsheet

---

## v.1.0.01.04 — Development
Date: 2026-02-18
Type: Dev Change

### Summary
- Made Student List sheet optional; sync continues with empty folder map if missing

### Changes (detailed)

#### Fixed
- LegacyCode.js
  - fetchAndCacheTodayLessons()
    - From: Threw "Student List sheet not found" and stopped
    - To: Uses empty studentMap if sheet missing; logs warning and continues (folderName empty or DEMO)

---

## v.1.0.01.03 — Development
Date: 2026-02-18
Type: Dev Change

### Summary
- Added manualSync() for testing sync without webhook

### Changes (detailed)

#### Added
- Code.js
  - manualSync() — runs fetchAndCacheTodayLessons() from Editor; use to verify sync logic

---

## v.1.0.01.02 — Development
Date: 2026-02-18
Type: Dev Change

### Summary
- Target spreadsheet changed to Teacher Admin (1nAxTJVh45mc6N9tX2Xr_B4DGQ-fG3s0LTp7eY4sacVo)

### Changes (detailed)

#### Changed
- LegacyCode.js
  - SS_ID
    - From: 1IobCrDaNAPquEX0WKR8fLyh0p-Q9XutIdHHuu_3XXEg
    - To: 1nAxTJVh45mc6N9tX2Xr_B4DGQ-fG3s0LTp7eY4sacVo (Teacher Admin)
  - All getActiveSpreadsheet() calls
    - From: SpreadsheetApp.getActiveSpreadsheet()
    - To: SpreadsheetApp.openById(SS_ID) — ensures webhook writes to correct spreadsheet when script is standalone

---

## v.1.0.01.01 — Development
Date: 2026-02-18
Type: Dev Change

### Summary
- Removed Index.html dependency; doGet returns plain text (no UI needed for webhook)

### Changes (detailed)

#### Changed
- Code.js
  - doGet()
    - From: HtmlService.createHtmlOutputFromFile('Index') — required Index.html
    - To: ContentService.createTextOutput('Calendar Webhook — use POST') — no HTML file needed
  - WEBHOOK_URL
    - Set to deployed app URL

---

## v.1.0.01.00 — Production Release
Date: 2026-02-18
Type: Production

### Release Summary
- Initial production deployment
- Calendar Webhook app: doGet, doPost, registerCalendarWatch
- WEBHOOK_URL config at top of Code.js
- Apps Script with Calendar API v3

---

## v.1.0.00.02 — Development
Date: 2026-02-18
Type: Dev Change

### Summary
- Added WEBHOOK_URL constant at top of Code.js for easy deployment URL management

### Changes (detailed)

#### Added
- Code.js
  - WEBHOOK_URL constant — paste deployed Web App URL here; registerCalendarWatch() uses it by default

#### Changed
- Code.js
  - registerCalendarWatch(webhookUrl)
    - From: Required webhookUrl argument
    - To: Optional; defaults to WEBHOOK_URL; validates against YOUR_DEPLOYMENT_ID placeholder

---

## v.0.0.37.03 — Development
Date: 2026-02-18
Type: Dev Change

### Summary
- Added Node.js webhook app for Google Calendar API push notifications
- Renamed Code.js to LegacyCode.js (reference only)

### Changes (detailed)

#### Added
- package.json, server.js, config.js, .env.example
- services/syncService.js, scripts/register-watch.js

#### Removed
- Code.js (renamed to LegacyCode.js)

#### Changed
- LegacyCode.js (renamed from Code.js)
  - Added header comment: reference only for webhook app logic

---

## v.0.0.37.02 — Development
Date: 2026-01-26
Type: Dev Change

### Summary
- Status colors now override demo/owner styling when lesson has ended

### Changes (detailed)

#### Fixed
- Index.html
  - .event-block.danger, .event-block.caution, .event-block.safe
    - From: Defined before .event-block.demo and .event-block.owner; demo/owner overrode status colors (cards stayed blue/dark when pdf+history complete)
    - To: Status rules moved after demo/owner so danger/caution/safe override; demo/owner lessons now show correct green/orange/red when ended

---
