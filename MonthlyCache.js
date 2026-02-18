/**
 * MonthlyCache.js — Fetches calendar events for a month and writes to sheets.
 * Config (ADMIN_SS_ID, CALENDAR_ID, etc.) in Config.js — files are merged into one scope.
 */

function toYYYYMM(dateOrString) {
  if (!dateOrString) return '';
  if (dateOrString instanceof Date) {
    return Utilities.formatDate(dateOrString, Session.getScriptTimeZone(), 'yyyy-MM');
  }
  var s = String(dateOrString).trim();
  if (/^\d{4}-\d{2}$/.test(s)) return s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s.substring(0, 7);
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
    var parts = s.split('/');
    var d = new Date(Number(parts[2]), Number(parts[1]) - 1, Number(parts[0]));
    return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM');
  }
  var m = s.match(/^(January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})$/);
  if (m) {
    var monthNum = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].indexOf(m[1]);
    return m[2] + '-' + ('0' + (monthNum + 1)).slice(-2);
  }
  var d2 = new Date(s);
  if (!isNaN(d2)) return Utilities.formatDate(d2, Session.getScriptTimeZone(), 'yyyy-MM');
  return '';
}

function getAllEventsForMonth(monthText) {
  var monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var year, monthNum;
  if (/^\d{4}-\d{2}$/.test(monthText)) {
    var parts = monthText.split('-');
    year = Number(parts[0]);
    monthNum = Number(parts[1]) - 1;
  } else if (/^[A-Za-z]+ \d{4}$/.test(monthText)) {
    var parts = monthText.trim().split(' ');
    monthNum = monthNames.indexOf(parts[0]);
    year = Number(parts[1]);
  } else {
    throw new Error('Invalid monthText format: ' + monthText);
  }
  var startDate = new Date(year, monthNum, 1);
  var endDate = new Date(year, monthNum + 1, 1);
  var allEvents = [];
  [CALENDAR_ID, DEMO_CALENDAR_ID, OWNER_CALENDAR_ID].forEach(function (calId) {
    var cal = CalendarApp.getCalendarById(calId);
    if (cal) {
      cal.getEvents(startDate, endDate).forEach(function (e) { allEvents.push(e); });
    }
  });
  return allEvents;
}

function processEventsForMonth(events) {
  var validRows = [];
  events.forEach(function (event) {
    var title = event.getTitle();
    if (/break/i.test(title) || /teacher/i.test(title)) return;

    var status = 'scheduled';
    if (/(placeholder)/i.test(title)) {
      status = 'reserved';
    } else if (/\[RESCHEDULED\]/i.test(title)) {
      status = 'rescheduled';
    } else {
      var color = event.getColor();
      if (color === '8' || color === '9') status = 'cancelled';
      else if (color === '5') status = 'rescheduled';
      else if (color === '11') status = 'demo';
    }

    var isKidsLesson = /子/.test(title);
    var startTime = event.getStartTime();
    var dateStr = Utilities.formatDate(startTime, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    var namePart = title.split('(')[0].replace(/\[RESCHEDULED\]\s*/gi, '').replace(/子/g, '');
    var names = namePart.split(/\s+and\s+/i).map(function (n) { return n.trim(); }).filter(Boolean);
    var lastName = '';
    if (names.length > 1) {
      var lastParts = names[names.length - 1].split(/\s+/);
      if (lastParts.length > 1) lastName = lastParts[lastParts.length - 1];
    }
    for (var i = 0; i < names.length; i++) {
      var parts = names[i].split(/\s+/);
      var teacherName = '';
      try {
        var calendarId = event.getOriginalCalendarId();
        if (calendarId === OWNER_CALENDAR_ID) teacherName = 'Sham';
      } catch (e) {}
      if (parts.length > 1) {
        validRows.push([
          event.getId(),
          title,
          dateStr,
          startTime,
          event.getEndTime(),
          status,
          names[i],
          isKidsLesson ? '子' : '',
          teacherName
        ]);
      } else {
        var fullName = parts[0] + (lastName ? ' ' + lastName : '');
        validRows.push([
          event.getId(),
          title,
          dateStr,
          startTime,
          event.getEndTime(),
          status,
          fullName.trim(),
          isKidsLesson ? '子' : '',
          teacherName
        ]);
      }
    }
  });
  return validRows;
}

/**
 * Cache events for a specific month to a specific sheet
 * @param {string} monthStr - Month in format 'YYYY-MM' or 'MMMM yyyy'
 * @param {string} sheetName - Name of the sheet to write to
 * @returns {number} Number of events processed
 */
function cacheEventsToSheet(monthStr, sheetName) {
  var yyyymm = toYYYYMM(monthStr);
  if (!yyyymm) {
    Logger.log('Invalid monthStr format: ' + monthStr);
    return 0;
  }

  Logger.log('Caching events for month: ' + monthStr + ' to sheet: ' + sheetName);

  var events = getAllEventsForMonth(monthStr);
  Logger.log('Retrieved ' + events.length + ' events from 3 calendars for ' + monthStr);

  var validRows = processEventsForMonth(events);
  Logger.log('Processed ' + validRows.length + ' valid lesson events');

  if (validRows.length === 0) {
    Logger.log('No valid events, skipping update (preserve existing data)');
    return 0;
  }

  var ss = SpreadsheetApp.openById(ADMIN_SS_ID);
  var cacheSheet = ss.getSheetByName(sheetName);
  if (!cacheSheet) {
    cacheSheet = ss.insertSheet(sheetName);
  } else {
    cacheSheet.clear();
  }

  var headers = ['EventID', 'Title', 'Date', 'Start', 'End', 'Status', 'StudentName', 'IsKidsLesson', 'TeacherName'];
  cacheSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  cacheSheet.getRange(2, 1, validRows.length, headers.length).setValues(validRows);

  return validRows.length;
}

function cacheMonthlyEvents(monthStr) {
  if (!monthStr) {
    var today = new Date();
    monthStr = Utilities.formatDate(today, Session.getScriptTimeZone(), 'MMMM yyyy');
  }
  return cacheEventsToSheet(monthStr, 'MonthlySchedule');
}

/**
 * Cache events for both current month and next month into separate sheets
 * @returns {Object} Summary of events processed for both months
 */
function cacheMonthlyEventsForBothMonths() {
  Logger.log('=== Starting dual month cache operation ===');

  var today = new Date();
  var currentMonth = Utilities.formatDate(today, Session.getScriptTimeZone(), 'yyyy-MM');
  var nextMonthDate = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  var nextMonth = Utilities.formatDate(nextMonthDate, Session.getScriptTimeZone(), 'yyyy-MM');

  var results = {
    currentMonth: { month: currentMonth, events: 0, sheetName: 'MonthlySchedule' },
    nextMonth: { month: nextMonth, events: 0, sheetName: 'NextMonthSchedule' }
  };

  try {
    results.currentMonth.events = cacheEventsToSheet(currentMonth, 'MonthlySchedule');
    results.nextMonth.events = cacheEventsToSheet(nextMonth, 'NextMonthSchedule');
  } catch (error) {
    Logger.log('Error in dual month cache operation: ' + error.toString());
    results.error = error.toString();
  }

  Logger.log('=== Dual month cache operation completed ===');
  return results;
}
