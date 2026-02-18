/**
 * Config.js — All shared constants. Apps Script merges files into one scope, so declare once here.
 */

// Webhook
var WEBHOOK_URL = 'https://script.google.com/a/macros/greensquare.jp/s/AKfycbzO_0AOx5ySN_omhkmF14SyanY5A5Wy6m3xK35nO0Ox9i_AAmT4KVWRrs2TD7rsJ4Y3/exec';
var WEBHOOK_LOG_SHEET = 'WebhookLog';

// Spreadsheets
var SS_ID = '1nAxTJVh45mc6N9tX2Xr_B4DGQ-fG3s0LTp7eY4sacVo'; // Teacher Admin — lessons_today, AppState, WebhookLog
var STUDENTLIST_SS_ID = '1IobCrDaNAPquEX0WKR8fLyh0p-Q9XutIdHHuu_3XXEg'; // Student List sheet
var ADMIN_SS_ID = '1upKC-iNWs7HIeKiVVAegve5O5WbNebbjMlveMcvnuow'; // Admin — MonthlySchedule, NextMonthSchedule

// Calendars
var CALENDAR_ID = 'greensquare.jp_h8u0oufn8feana384v67o46o78@group.calendar.google.com';
var DEMO_CALENDAR_ID = 'greensquare.jp_1m1bhvfu9mtts7gq9s9jsj9kbk@group.calendar.google.com';
var OWNER_CALENDAR_ID = 'c_403306dccf2039f61a620a4cfc22424c5a6f79e945054e57f30ecc50c90b9207@group.calendar.google.com';

// Derived (opened once at load)
var STUDENTLIST = SpreadsheetApp.openById(STUDENTLIST_SS_ID);
var APPSTATE_SHEET_NAME = 'AppState';
