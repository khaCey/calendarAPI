/**
 * MonthlyCache.js — Fetches calendar events for a month and writes to sheets.
 * Config (ADMIN_SS_ID, CALENDAR_ID, etc.) in Config.js — files are merged into one scope.
 * Fallback: if Config.js calendar IDs are undefined (load order), use these.
 */
var _CALENDAR_IDS = [
  'greensquare.jp_h8u0oufn8feana384v67o46o78@group.calendar.google.com',
  'greensquare.jp_1m1bhvfu9mtts7gq9s9jsj9kbk@group.calendar.google.com',
  'c_403306dccf2039f61a620a4cfc22424c5a6f79e945054e57f30ecc50c90b9207@group.calendar.google.com'
];

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
  var calIds;
  if (typeof CALENDAR_ID !== 'undefined' && CALENDAR_ID) {
    calIds = [CALENDAR_ID, DEMO_CALENDAR_ID, OWNER_CALENDAR_ID];
  }
  if (!calIds || !Array.isArray(calIds) || calIds.length === 0) {
    calIds = [
      'greensquare.jp_h8u0oufn8feana384v67o46o78@group.calendar.google.com',
      'greensquare.jp_1m1bhvfu9mtts7gq9s9jsj9kbk@group.calendar.google.com',
      'c_403306dccf2039f61a620a4cfc22424c5a6f79e945054e57f30ecc50c90b9207@group.calendar.google.com'
    ];
  }
  var names = ['main', 'demo', 'owner'];
  for (var i = 0; i < calIds.length; i++) {
    var calId = calIds[i];
    if (!calId) continue;
    var cal = CalendarApp.getCalendarById(calId);
    if (!cal) continue;
    var evts = cal.getEvents(startDate, endDate);
    if (!evts) continue;
    evts.forEach(function (e) { allEvents.push(e); });
    Logger.log('getAllEventsForMonth: ' + names[i] + ' ' + evts.length + ' events for ' + monthText);
  }
  return allEvents;
}

/** Strip demo marker and kids kanji from student names for MonthlySchedule / NextMonthSchedule only. */
function cleanMonthlyScheduleStudentName_(name) {
  if (name == null || name === '') return '';
  var s = String(name).replace(/\s*D\/L\s*/gi, ' ').replace(/子/g, '');
  return s.replace(/\s+/g, ' ').trim();
}

/** Same rules as server studentAdminCalendarDescription.js — parse ---student-admin--- block. */
function parseAwaitingRescheduleFromDescription_(desc) {
  var s = String(desc || '');
  var idx = s.indexOf('---student-admin---');
  if (idx < 0) return null;
  var tail = s.substring(idx);
  var m = tail.match(/awaiting_reschedule_date\s*=\s*([01])/i);
  if (!m) return null;
  return m[1] === '1';
}

function processEventsForMonth(events) {
  var validRows = [];
  if (!events || !Array.isArray(events)) return validRows;
  events.forEach(function (event) {
    var title = event.getTitle();
    if (/break/i.test(title) || /teacher/i.test(title)) return;

    var description = '';
    try { description = event.getDescription() || ''; } catch (e) { description = ''; }
    var teacherFromDesc = '';
    try {
      var tm = String(description || '').match(/#teacher(\w+)/i);
      teacherFromDesc = tm ? String(tm[1] || '').trim() : '';
    } catch (e) { teacherFromDesc = ''; }

    var awaitingFromDesc = '';
    try {
      var arP = parseAwaitingRescheduleFromDescription_(description);
      if (arP === true) awaitingFromDesc = '1';
      else if (arP === false) awaitingFromDesc = '0';
    } catch (eAr) {}

    // Student Admin writes "Moved to/from <day>" (suffix or legacy prefix). Older titles used [RESCHEDULED].
    // Graphite (8) alone = cancelled; graphite + Moved marker = rescheduled (do not overwrite to cancelled).
    var movedMarkerRe = /Moved\s+(to|from)\s+(\?{3}|\d{1,2}(?:st|nd|rd|th))/i;
    var status = 'scheduled';
    if (/(placeholder)/i.test(title)) {
      status = 'reserved';
    } else if (movedMarkerRe.test(title) || /\[RESCHEDULED\]/i.test(title)) {
      status = 'rescheduled';
    } else {
      var color = event.getColor();
      if (color === '8' || color === '9') status = 'cancelled';
      // Google Calendar "Banana" = event colorId 5 (Apps Script YELLOW) — holds / reservation slots
      else if (color === '5') status = 'reserved';
      else if (color === '11') status = 'demo';
    }

    var isKidsLesson = /子/.test(title);
    var startTime = event.getStartTime();
    var dateStr = Utilities.formatDate(startTime, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    var titleForNames = String(title || '')
      .replace(/^\s*Moved\s+(?:to|from)\s+(?:\?{3}|\d{1,2}(?:st|nd|rd|th))\s*[·•\-]\s*/i, '')
      .replace(/\s*[·•\-]\s*Moved\s+(?:to|from)\s+(?:\?{3}|\d{1,2}(?:st|nd|rd|th))\s*$/i, '')
      .replace(/\[RESCHEDULED\]\s*/gi, '')
      .trim();
    var namePart = titleForNames.split('(')[0].replace(/子/g, '');
    var names = namePart.split(/\s+and\s+/i).map(function (n) { return n.trim(); }).filter(Boolean);
    var lastName = '';
    if (names.length > 1) {
      var lastParts = names[names.length - 1].split(/\s+/);
      if (lastParts.length > 1) lastName = lastParts[lastParts.length - 1];
    }
    var lessonKind = 'regular';
    try {
      var calendarId = event.getOriginalCalendarId();
      if (calendarId === OWNER_CALENDAR_ID) lessonKind = 'owner';
      else if (calendarId === DEMO_CALENDAR_ID) lessonKind = 'demo';
      else if (calendarId === CALENDAR_ID) lessonKind = 'regular';
    } catch (e) {}
    for (var i = 0; i < names.length; i++) {
      var parts = names[i].split(/\s+/);
      var teacherName = '';
      try {
        var calendarId = event.getOriginalCalendarId();
        if (calendarId === OWNER_CALENDAR_ID) teacherName = 'Sham';
      } catch (e) {}
      if (!teacherName && teacherFromDesc) teacherName = teacherFromDesc;
      if (parts.length > 1) {
        validRows.push([
          event.getId(),
          title,
          dateStr,
          startTime,
          event.getEndTime(),
          status,
          cleanMonthlyScheduleStudentName_(names[i]),
          isKidsLesson ? '子' : '',
          teacherName,
          lessonKind,
          awaitingFromDesc
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
          cleanMonthlyScheduleStudentName_(fullName.trim()),
          isKidsLesson ? '子' : '',
          teacherName,
          lessonKind,
          awaitingFromDesc
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
  if (!events || !Array.isArray(events)) events = [];
  Logger.log('Retrieved ' + events.length + ' events from 3 calendars for ' + monthStr);

  var validRows = processEventsForMonth(events);
  Logger.log('Processed ' + validRows.length + ' valid lesson events');

  if (validRows.length === 0) {
    Logger.log('No valid events, skipping update (preserve existing data)');
    return 0;
  }

  var adminSsId = (typeof ADMIN_SS_ID !== 'undefined' && ADMIN_SS_ID)
    ? ADMIN_SS_ID
    : '1upKC-iNWs7HIeKiVVAegve5O5WbNebbjMlveMcvnuow'; // Admin — MonthlySchedule
  var ss = SpreadsheetApp.openById(adminSsId);
  var cacheSheet = ss.getSheetByName(sheetName);
  if (!cacheSheet) {
    cacheSheet = ss.insertSheet(sheetName);
  } else {
    cacheSheet.clear();
  }

  var headers = [
    'EventID',
    'Title',
    'Date',
    'Start',
    'End',
    'Status',
    'StudentName',
    'IsKidsLesson',
    'TeacherName',
    'LessonKind',
    'AwaitingRescheduleDate'
  ];
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
 * Convert processEventsForMonth rows to polling format (objects with eventID, title, date, start, end, etc.).
 * @param {Array<Array>} rows - Output of processEventsForMonth
 * @returns {Array<Object>}
 */
function rowsToPollingFormat(rows) {
  var tz = Session.getScriptTimeZone();
  var out = [];
  var validKinds = { regular: 1, demo: 1, owner: 1 };
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (!r || r.length < 9) continue;
    var startVal = r[3];
    var startStr = '';
    if (startVal instanceof Date && !isNaN(startVal.getTime())) {
      startStr = Utilities.formatDate(startVal, tz, 'yyyy-MM-dd HH:mm');
    } else if (startVal) startStr = String(startVal).trim();
    var endVal = r[4];
    var endStr = '';
    if (endVal instanceof Date && !isNaN(endVal.getTime())) {
      endStr = Utilities.formatDate(endVal, tz, 'yyyy-MM-dd HH:mm');
    } else if (endVal) endStr = String(endVal).trim();
    var lessonKind = (r[9] && validKinds[String(r[9]).toLowerCase()]) ? String(r[9]).toLowerCase() : 'regular';
    var rowObj = {
      eventID: String(r[0] || '').trim(),
      title: String(r[1] || '').trim(),
      date: String(r[2] || '').trim(),
      start: startStr,
      end: endStr,
      status: String(r[5] || 'scheduled').trim() || 'scheduled',
      studentName: String(r[6] || '').trim(),
      isKidsLesson: r[7] === '子' || r[7] === true,
      teacherName: String(r[8] || '').trim(),
      lessonKind: lessonKind
    };
    var ard = r[10];
    if (ard === '1') rowObj.awaitingRescheduleDate = true;
    else if (ard === '0') rowObj.awaitingRescheduleDate = false;
    out.push(rowObj);
  }
  return out;
}

/**
 * Fetch schedule data for a specific month directly from Calendar (for retroactive backfill).
 * @param {string} monthStr - YYYY-MM
 * @returns {{ data: Array, month: string }}
 */
function getScheduleDataForMonth(monthStr) {
  var yyyymm = toYYYYMM(monthStr);
  if (!yyyymm) return { data: [], month: '' };
  var events = getAllEventsForMonth(monthStr);
  var rows = processEventsForMonth(events);
  return { data: rowsToPollingFormat(rows), month: yyyymm };
}

/**
 * Fetch schedule data for a full year from Calendar (for retroactive backfill).
 * @param {string|number} year - e.g. 2024 or '2024'
 * @returns {{ data: Array, year: string, months: Array<string> }}
 */
function getScheduleDataForYear(year) {
  var y = parseInt(year, 10);
  if (isNaN(y) || y < 2000 || y > 2100) return { data: [], year: String(year), months: [] };
  var all = [];
  var months = [];
  for (var m = 1; m <= 12; m++) {
    var mm = ('0' + m).slice(-2);
    var yyyymm = y + '-' + mm;
    var result = getScheduleDataForMonth(yyyymm);
    if (result.data.length > 0) {
      all = all.concat(result.data);
      months.push(yyyymm);
    }
  }
  return { data: all, year: String(y), months: months };
}

/**
 * Cache a full year of events to MonthlySchedule sheet.
 * @param {string|number} year - e.g. 2024 or '2024'
 * @returns {{ rows: number, months: Array<string> }}
 */
function cacheYearToSheet(year) {
  var result = getScheduleDataForYear(year);
  var data = result.data || [];
  if (data.length === 0) {
    Logger.log('cacheYearToSheet: no events for year ' + year);
    return { rows: 0, months: [] };
  }
  var rows = data.map(function (r) {
    var arCell = '';
    if (r.awaitingRescheduleDate === true) arCell = '1';
    else if (r.awaitingRescheduleDate === false) arCell = '0';
    return [
      r.eventID || '',
      r.title || '',
      r.date || '',
      r.start || '',
      r.end || '',
      r.status || 'scheduled',
      r.studentName || '',
      r.isKidsLesson ? '子' : '',
      r.teacherName || '',
      r.lessonKind || 'regular',
      arCell
    ];
  });
  var adminSsId = (typeof ADMIN_SS_ID !== 'undefined' && ADMIN_SS_ID)
    ? ADMIN_SS_ID
    : '1upKC-iNWs7HIeKiVVAegve5O5WbNebbjMlveMcvnuow';
  var ss = SpreadsheetApp.openById(adminSsId);
  var cacheSheet = ss.getSheetByName('MonthlySchedule');
  if (!cacheSheet) cacheSheet = ss.insertSheet('MonthlySchedule');
  else cacheSheet.clear();
  var headers = [
    'EventID',
    'Title',
    'Date',
    'Start',
    'End',
    'Status',
    'StudentName',
    'IsKidsLesson',
    'TeacherName',
    'LessonKind',
    'AwaitingRescheduleDate'
  ];
  cacheSheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (rows.length > 0) {
    cacheSheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }
  bumpScheduleCacheVersion();
  Logger.log('cacheYearToSheet: stored ' + rows.length + ' rows for year ' + year + ' (' + (result.months || []).length + ' months)');
  return { rows: rows.length, months: result.months || [] };
}

/**
 * Manual run: cache full year to MonthlySchedule. Run from Script Editor.
 * @param {string|number} [year] - e.g. 2025; defaults to current year
 */
function fetchYear(year) {
  var y = year != null ? year : new Date().getFullYear();
  return cacheYearToSheet(y);
}

/**
 * Cache events for the current calendar month only (script timezone) into MonthlySchedule.
 * Next month is not written — polling and DB sync only use this month.
 * @returns {Object} Summary of events processed
 */
function cacheMonthlyEventsForBothMonths() {
  Logger.log('=== Starting monthly cache (current month only) ===');

  var today = new Date();
  var currentMonth = Utilities.formatDate(today, Session.getScriptTimeZone(), 'yyyy-MM');

  var results = {
    currentMonth: { month: currentMonth, events: 0, sheetName: 'MonthlySchedule' }
  };

  try {
    results.currentMonth.events = cacheEventsToSheet(currentMonth, 'MonthlySchedule');
    bumpScheduleCacheVersion();
  } catch (error) {
    Logger.log('Error in monthly cache operation: ' + error.toString());
    results.error = error.toString();
  }

  Logger.log('=== Monthly cache operation completed ===');
  return results;
}
function debugCalendarAccess() {
  var ranges = [
    { label: '2025-01', start: new Date(2025, 0, 1), end: new Date(2025, 1, 1) },
    { label: '2026-03', start: new Date(2026, 2, 1), end: new Date(2026, 3, 1) }
  ];
  var cals = [
    { id: CALENDAR_ID, name: 'main' },
    { id: DEMO_CALENDAR_ID, name: 'demo' },
    { id: OWNER_CALENDAR_ID, name: 'owner' }
  ];
  ranges.forEach(function (r) {
    Logger.log('--- ' + r.label + ' ---');
    cals.forEach(function (c) {
      var cal = CalendarApp.getCalendarById(c.id);
      if (!cal) {
        Logger.log('  ' + c.name + ': NULL (no access)');
        return;
      }
      var events = cal.getEvents(r.start, r.end);
      Logger.log('  ' + c.name + ': ' + events.length + ' events');
    });
  });
}