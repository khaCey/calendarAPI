/**
 * Config.js — All shared constants. Apps Script merges files into one scope, so declare once here.
 *
 * Secrets: do not put real API keys in Git. Set BOOKING_API_KEY (and POLL_API_KEY, etc.) in
 * Project Settings → Script properties, or run migratePropertiesFromConfig_() once after pasting
 * values locally only. WEBHOOK_URL: paste from Deploy after publishing the web app.
 */

// Webhook
var WEBHOOK_URL = '';
var WEBHOOK_LOG_SHEET = 'WebhookLog';
var BOOKING_API_KEY = '';

// Spreadsheets
var SS_ID = '1nAxTJVh45mc6N9tX2Xr_B4DGQ-fG3s0LTp7eY4sacVo'; // Teacher Admin — lessons_today, AppState, WebhookLog
var STUDENTLIST_SS_ID = '1IobCrDaNAPquEX0WKR8fLyh0p-Q9XutIdHHuu_3XXEg'; // Student List sheet
var ADMIN_SS_ID = '1upKC-iNWs7HIeKiVVAegve5O5WbNebbjMlveMcvnuow'; // Admin — MonthlySchedule, NextMonthSchedule

// Calendars
var CALENDAR_ID = 'greensquare.jp_h8u0oufn8feana384v67o46o78@group.calendar.google.com';
var DEMO_CALENDAR_ID = 'greensquare.jp_1m1bhvfu9mtts7gq9s9jsj9kbk@group.calendar.google.com';
var OWNER_CALENDAR_ID = 'c_403306dccf2039f61a620a4cfc22424c5a6f79e945054e57f30ecc50c90b9207@group.calendar.google.com';

// Sheet/cache state names
var APPSTATE_SHEET_NAME = 'AppState';
var SCHEDULE_CACHE_STATE_SHEET = 'ScheduleCacheState';

// Do not open spreadsheets at global scope. Apps Script evaluates top-level code for every
// web request, so a global SpreadsheetApp.openById() adds Sheets latency even to routes that
// never use that spreadsheet (for example availability or booking mutations).
var _STUDENTLIST_SPREADSHEET = null;

function getStudentListSpreadsheet_() {
  if (!_STUDENTLIST_SPREADSHEET) {
    _STUDENTLIST_SPREADSHEET = SpreadsheetApp.openById(STUDENTLIST_SS_ID);
  }
  return _STUDENTLIST_SPREADSHEET;
}
