/**
 * Config.js — safe defaults for the private-calendar branch.
 *
 * Apps Script merges all .js files into one global scope. Do not put account IDs,
 * calendar IDs, spreadsheet IDs or API keys in this tracked file. Override any
 * value through Project Settings → Script properties.
 */

// Web app / API. BOOKING_API_KEY must be set as a Script Property before deployment.
var BOOKING_API_KEY = '';

// Private-calendar mode. The Calendar API recognises "primary" as the deploying
// user's default private calendar. Optional demo/owner calendars fall back to it.
var CALENDAR_ID = 'primary';
var DEMO_CALENDAR_ID = '';
var OWNER_CALENDAR_ID = '';
