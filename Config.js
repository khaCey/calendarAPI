/**
 * Config.js — Green Square schedule sync / student-number project.
 *
 * The Apps Script project is attached to the Calendar Mirror spreadsheet, so
 * the mirror spreadsheet is obtained from SpreadsheetApp.getActiveSpreadsheet().
 * No spreadsheet ID needs to be configured manually.
 *
 * Keep secrets out of Git. Configure only:
 * STUDENT_NUMBER_TAG_API_KEY
 * in Apps Script → Project Settings → Script properties.
 */

var STUDENT_NUMBER_TAG_API_KEY = '';

var CALENDAR_MIRROR_SPREADSHEET_ID = (function () {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  return spreadsheet ? spreadsheet.getId() : '';
})();

var CALENDAR_ID = 'greensquare.jp_h8u0oufn8feana384v67o46o78@group.calendar.google.com';
var DEMO_CALENDAR_ID = 'greensquare.jp_1m1bhvfu9mtts7gq9s9jsj9kbk@group.calendar.google.com';
var OWNER_CALENDAR_ID = 'c_403306dccf2039f61a620a4cfc22424c5a6f79e945054e57f30ecc50c90b9207@group.calendar.google.com';
