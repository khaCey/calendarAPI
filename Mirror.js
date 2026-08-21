/**
 * Calendar Mirror for the rebuilt Green Square schedule system.
 * Google Calendar is the source of truth; this bound spreadsheet is the read mirror.
 */

var MIRROR_MONTHLY_HEADERS_ = [
  'eventKey','calendarSource','googleEventId','recurringEventId','originalStartTime',
  'studentId','studentName','teacherId','teacherName','lessonKind','title','start','end',
  'date','time','status','location','updatedAt','lastSyncedAt','iCalUID'
];

var MIRROR_STUDENTS_INDEX_HEADERS_ = [
  'studentId','tabName','status','lastUpdated','lastRebuiltAt'
];

var MIRROR_SYNC_STATE_HEADERS_ = [
  'calendarSource','calendarId','syncToken','lastSuccessfulSync','lastFullSync',
  'lastReconciliation','status','lastError','scheduleVersion'
];

var MIRROR_SYNC_AUDIT_HEADERS_ = [
  'auditId','timestamp','runType','calendarSource','eventsChecked','durationMs','status','errorMessage'
];

function requireCalendarMirrorSpreadsheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error('This Apps Script must be attached to the Calendar Mirror spreadsheet');
  return ss;
}

function calendarMirrorSources_() {
  return [
    { key: 'main', id: CALENDAR_ID, lessonKind: 'regular' },
    { key: 'demo', id: DEMO_CALENDAR_ID, lessonKind: 'demo' },
    { key: 'owner', id: OWNER_CALENDAR_ID, lessonKind: 'owner' }
  ].filter(function (source) { return !!source.id; });
}

function ensureMirrorSheet_(ss, name, headers) {
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  return sheet;
}

function setupCalendarMirrorSpreadsheet() {
  var ss = requireCalendarMirrorSpreadsheet_();
  ensureMirrorSheet_(ss, 'monthlyLessons', MIRROR_MONTHLY_HEADERS_);
  ensureMirrorSheet_(ss, 'studentsIndex', MIRROR_STUDENTS_INDEX_HEADERS_);
  ensureMirrorSheet_(ss, 'syncState', MIRROR_SYNC_STATE_HEADERS_);
  ensureMirrorSheet_(ss, 'syncAudit', MIRROR_SYNC_AUDIT_HEADERS_);
  return {
    ok: true,
    spreadsheetId: ss.getId(),
    sheets: ['monthlyLessons','studentsIndex','syncState','syncAudit']
  };
}

function mirrorMonthBounds_(monthText) {
  var value = String(monthText || '').trim();
  if (!value) value = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM');
  if (!/^\d{4}-\d{2}$/.test(value)) throw new Error('month must be YYYY-MM');

  var parts = value.split('-');
  var year = Number(parts[0]);
  var month = Number(parts[1]);
  if (month < 1 || month > 12) throw new Error('month must be YYYY-MM');

  // Midnight JST represented in UTC.
  var start = new Date(Date.UTC(year, month - 1, 1, -9, 0, 0));
  var end = new Date(Date.UTC(year, month, 1, -9, 0, 0));
  return { month: value, timeMin: start.toISOString(), timeMax: end.toISOString() };
}

function fetchMirrorSourceEvents_(source, bounds) {
  var out = [];
  var pageToken = null;
  do {
    var params = {
      timeMin: bounds.timeMin,
      timeMax: bounds.timeMax,
      singleEvents: true,
      showDeleted: false,
      maxResults: 2500,
      timeZone: 'Asia/Tokyo'
    };
    if (pageToken) params.pageToken = pageToken;

    var result = Calendar.Events.list(source.id, params);
    var items = (result && result.items) || [];
    for (var i = 0; i < items.length; i++) out.push(items[i]);
    pageToken = result && result.nextPageToken ? result.nextPageToken : null;
  } while (pageToken);
  return out;
}

function mirrorEventStartIso_(event) {
  return event && event.start ? String(event.start.dateTime || event.start.date || '') : '';
}

function mirrorEventEndIso_(event) {
  return event && event.end ? String(event.end.dateTime || event.end.date || '') : '';
}

function mirrorOriginalStartIso_(event) {
  return event && event.originalStartTime
    ? String(event.originalStartTime.dateTime || event.originalStartTime.date || '')
    : '';
}

function mirrorEventKey_(sourceKey, event) {
  var source = String(sourceKey || '').trim();
  var eventId = String((event && event.id) || '').trim();
  var recurringId = String((event && event.recurringEventId) || '').trim();
  var originalStart = mirrorOriginalStartIso_(event);
  if (recurringId && originalStart) return source + ':' + recurringId + ':' + originalStart;
  return source + ':' + eventId;
}

function mirrorTeacherName_(description) {
  var match = String(description || '').match(/#teacher([A-Za-z0-9_-]+)/i);
  return match ? String(match[1] || '').trim() : '';
}

function mirrorStudentNamesFromTitle_(title) {
  var raw = String(title || '')
    .replace(/^\s*Moved\s+(?:to|from)\s+(?:\?{3}|\d{1,2}(?:st|nd|rd|th))\s*[·•\-]\s*/i, '')
    .replace(/\s*[·•\-]\s*Moved\s+(?:to|from)\s+(?:\?{3}|\d{1,2}(?:st|nd|rd|th))\s*$/i, '')
    .replace(/\[RESCHEDULED\]\s*/gi, '')
    .replace(/子/g, '')
    .trim();

  var beforeParen = raw.split('(')[0].trim();
  if (!beforeParen) return [];
  return beforeParen.split(/\s+and\s+/i)
    .map(function (name) { return String(name || '').replace(/\s+/g, ' ').trim(); })
    .filter(Boolean);
}

function normalizeMirrorEvent_(source, event, syncedAtIso) {
  var description = String((event && event.description) || '');
  var studentIds = parseStudentIdsFromDescription_(description);
  var studentNames = mirrorStudentNamesFromTitle_(event && event.summary);
  var start = mirrorEventStartIso_(event);
  var end = mirrorEventEndIso_(event);
  var date = start ? Utilities.formatDate(new Date(start), 'Asia/Tokyo', 'yyyy-MM-dd') : '';
  var time = start && /T/.test(start) ? Utilities.formatDate(new Date(start), 'Asia/Tokyo', 'HH:mm') : '';

  return {
    eventKey: mirrorEventKey_(source.key, event),
    calendarSource: source.key,
    googleEventId: String((event && event.id) || ''),
    recurringEventId: String((event && event.recurringEventId) || ''),
    originalStartTime: mirrorOriginalStartIso_(event),
    studentId: studentIds.join(','),
    studentName: studentNames.join(' | '),
    teacherId: '',
    teacherName: source.key === 'owner' ? 'Sham' : mirrorTeacherName_(description),
    lessonKind: source.lessonKind,
    title: String((event && event.summary) || ''),
    start: start,
    end: end,
    date: date,
    time: time,
    status: String((event && event.status) || 'confirmed'),
    location: String((event && event.location) || ''),
    updatedAt: String((event && event.updated) || ''),
    lastSyncedAt: syncedAtIso,
    iCalUID: String((event && event.iCalUID) || '')
  };
}

function mirrorRowArray_(row) {
  return MIRROR_MONTHLY_HEADERS_.map(function (header) {
    return row && row[header] != null ? row[header] : '';
  });
}

function replaceMirrorSheetRows_(sheet, headers, rows) {
  var lastRow = sheet.getLastRow();
  var lastCol = Math.max(sheet.getLastColumn(), headers.length);
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, lastCol).clearContent();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (rows.length) sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
}

function mirrorStudentIdsFromRow_(row) {
  return String((row && row.studentId) || '').split(',')
    .map(function (id) { return String(id || '').trim(); })
    .filter(Boolean);
}

function mirrorBuildStudentRows_(monthlyRows) {
  var byStudent = {};
  for (var i = 0; i < monthlyRows.length; i++) {
    var row = monthlyRows[i];
    var ids = mirrorStudentIdsFromRow_(row);
    for (var j = 0; j < ids.length; j++) {
      var id = ids[j];
      if (!byStudent[id]) byStudent[id] = [];
      var copy = {};
      for (var key in row) copy[key] = row[key];
      copy.studentId = id;
      byStudent[id].push(copy);
    }
  }
  return byStudent;
}

function mirrorReadStudentsIndexIds_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  return sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues()
    .map(function (row) { return String(row[0] || '').trim(); })
    .filter(Boolean);
}

function writeFullMirror_(ss, monthlyRows, sourceStats, startedAtMs, syncedAtIso) {
  var monthlySheet = ensureMirrorSheet_(ss, 'monthlyLessons', MIRROR_MONTHLY_HEADERS_);
  var studentsIndexSheet = ensureMirrorSheet_(ss, 'studentsIndex', MIRROR_STUDENTS_INDEX_HEADERS_);
  var syncStateSheet = ensureMirrorSheet_(ss, 'syncState', MIRROR_SYNC_STATE_HEADERS_);
  var syncAuditSheet = ensureMirrorSheet_(ss, 'syncAudit', MIRROR_SYNC_AUDIT_HEADERS_);

  replaceMirrorSheetRows_(monthlySheet, MIRROR_MONTHLY_HEADERS_, monthlyRows.map(mirrorRowArray_));

  var byStudent = mirrorBuildStudentRows_(monthlyRows);
  var currentStudentIds = Object.keys(byStudent).sort(function (a, b) {
    return String(a).localeCompare(String(b), undefined, { numeric: true });
  });
  var previousStudentIds = mirrorReadStudentsIndexIds_(studentsIndexSheet);
  var currentSet = {};
  currentStudentIds.forEach(function (id) { currentSet[id] = true; });

  for (var p = 0; p < previousStudentIds.length; p++) {
    var oldId = previousStudentIds[p];
    if (currentSet[oldId]) continue;
    var oldSheet = ss.getSheetByName('student_' + oldId);
    if (oldSheet) replaceMirrorSheetRows_(oldSheet, MIRROR_MONTHLY_HEADERS_, []);
  }

  var indexRows = [];
  for (var s = 0; s < currentStudentIds.length; s++) {
    var studentId = currentStudentIds[s];
    var tabName = 'student_' + studentId;
    var studentSheet = ensureMirrorSheet_(ss, tabName, MIRROR_MONTHLY_HEADERS_);
    replaceMirrorSheetRows_(studentSheet, MIRROR_MONTHLY_HEADERS_, byStudent[studentId].map(mirrorRowArray_));
    indexRows.push([studentId, tabName, 'active', syncedAtIso, syncedAtIso]);
  }
  replaceMirrorSheetRows_(studentsIndexSheet, MIRROR_STUDENTS_INDEX_HEADERS_, indexRows);

  var version = syncedAtIso;
  var stateRows = sourceStats.map(function (stat) {
    return [stat.key, stat.calendarId, '', syncedAtIso, syncedAtIso, '', 'healthy', '', version];
  });
  replaceMirrorSheetRows_(syncStateSheet, MIRROR_SYNC_STATE_HEADERS_, stateRows);

  var durationMs = Date.now() - startedAtMs;
  syncAuditSheet.appendRow([
    Utilities.getUuid(), syncedAtIso, 'initial_sync', 'all', monthlyRows.length,
    durationMs, 'success', ''
  ]);

  return {
    monthlyRows: monthlyRows.length,
    studentTabs: currentStudentIds.length,
    durationMs: durationMs,
    scheduleVersion: version
  };
}

function syncMonthToCalendarMirror(monthText) {
  var startedAtMs = Date.now();
  var bounds = mirrorMonthBounds_(monthText);
  var syncedAtIso = new Date().toISOString();
  var sources = calendarMirrorSources_();
  var monthlyRows = [];
  var sourceStats = [];

  for (var i = 0; i < sources.length; i++) {
    var source = sources[i];
    var events = fetchMirrorSourceEvents_(source, bounds);
    sourceStats.push({ key: source.key, calendarId: source.id, eventCount: events.length });
    for (var e = 0; e < events.length; e++) {
      if (!events[e] || !events[e].id) continue;
      monthlyRows.push(normalizeMirrorEvent_(source, events[e], syncedAtIso));
    }
  }

  monthlyRows.sort(function (a, b) {
    var startCompare = String(a.start || '').localeCompare(String(b.start || ''));
    if (startCompare !== 0) return startCompare;
    return String(a.eventKey || '').localeCompare(String(b.eventKey || ''));
  });

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = requireCalendarMirrorSpreadsheet_();
    var result = writeFullMirror_(ss, monthlyRows, sourceStats, startedAtMs, syncedAtIso);
    return {
      ok: true,
      month: bounds.month,
      sources: sourceStats,
      monthlyRows: result.monthlyRows,
      studentTabs: result.studentTabs,
      durationMs: result.durationMs,
      scheduleVersion: result.scheduleVersion
    };
  } finally {
    lock.releaseLock();
  }
}

function syncCurrentMonthToCalendarMirror() {
  return syncMonthToCalendarMirror(Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM'));
}

function mirrorSourceByCalendarId_(calendarId, lessonKind) {
  var sources = calendarMirrorSources_();
  for (var i = 0; i < sources.length; i++) {
    if (String(sources[i].id) === String(calendarId)) return sources[i];
  }
  var kind = String(lessonKind || '').toLowerCase();
  for (var j = 0; j < sources.length; j++) {
    if (sources[j].lessonKind === kind) return sources[j];
  }
  return null;
}

function mirrorRowsFromSheet_(sheet) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, MIRROR_MONTHLY_HEADERS_.length).getValues();
  return values.map(function (arr) {
    var obj = {};
    for (var i = 0; i < MIRROR_MONTHLY_HEADERS_.length; i++) obj[MIRROR_MONTHLY_HEADERS_[i]] = arr[i];
    return obj;
  }).filter(function (row) { return String(row.eventKey || '').trim(); });
}

function upsertVerifiedEventIntoCalendarMirror_(calendarId, lessonKind, exactEvent) {
  if (!exactEvent || !exactEvent.id) throw new Error('Exact verified Calendar event is required for mirror upsert');
  var source = mirrorSourceByCalendarId_(calendarId, lessonKind);
  if (!source) throw new Error('Could not map verified event to a mirror calendar source');

  var ss = requireCalendarMirrorSpreadsheet_();
  var monthlySheet = ensureMirrorSheet_(ss, 'monthlyLessons', MIRROR_MONTHLY_HEADERS_);
  var studentsIndexSheet = ensureMirrorSheet_(ss, 'studentsIndex', MIRROR_STUDENTS_INDEX_HEADERS_);
  var syncedAtIso = new Date().toISOString();
  var nextRow = normalizeMirrorEvent_(source, exactEvent, syncedAtIso);
  var rows = mirrorRowsFromSheet_(monthlySheet);
  var replaced = false;
  var oldStudentIds = [];

  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].eventKey) === String(nextRow.eventKey) ||
        (String(rows[i].calendarSource) === source.key && String(rows[i].googleEventId) === String(nextRow.googleEventId))) {
      oldStudentIds = mirrorStudentIdsFromRow_(rows[i]);
      rows[i] = nextRow;
      replaced = true;
      break;
    }
  }
  if (!replaced) rows.push(nextRow);

  rows.sort(function (a, b) {
    var startCompare = String(a.start || '').localeCompare(String(b.start || ''));
    if (startCompare !== 0) return startCompare;
    return String(a.eventKey || '').localeCompare(String(b.eventKey || ''));
  });
  replaceMirrorSheetRows_(monthlySheet, MIRROR_MONTHLY_HEADERS_, rows.map(mirrorRowArray_));

  var affected = {};
  oldStudentIds.concat(mirrorStudentIdsFromRow_(nextRow)).forEach(function (id) {
    if (id) affected[id] = true;
  });
  var byStudent = mirrorBuildStudentRows_(rows);
  Object.keys(affected).forEach(function (studentId) {
    var sheet = ensureMirrorSheet_(ss, 'student_' + studentId, MIRROR_MONTHLY_HEADERS_);
    replaceMirrorSheetRows_(sheet, MIRROR_MONTHLY_HEADERS_, (byStudent[studentId] || []).map(mirrorRowArray_));
  });

  var allStudentIds = Object.keys(byStudent).sort(function (a, b) {
    return String(a).localeCompare(String(b), undefined, { numeric: true });
  });
  var indexRows = allStudentIds.map(function (studentId) {
    return [studentId, 'student_' + studentId, 'active', syncedAtIso, syncedAtIso];
  });
  replaceMirrorSheetRows_(studentsIndexSheet, MIRROR_STUDENTS_INDEX_HEADERS_, indexRows);

  return {
    ok: true,
    eventKey: nextRow.eventKey,
    studentIds: mirrorStudentIdsFromRow_(nextRow),
    inserted: !replaced,
    updated: replaced,
    lastSyncedAt: syncedAtIso
  };
}

function readCalendarMirrorMonth(monthText) {
  var bounds = mirrorMonthBounds_(monthText);
  var ss = requireCalendarMirrorSpreadsheet_();
  var sheet = ensureMirrorSheet_(ss, 'monthlyLessons', MIRROR_MONTHLY_HEADERS_);
  var rows = mirrorRowsFromSheet_(sheet).filter(function (row) {
    return String(row.date || '').indexOf(bounds.month) === 0;
  });
  return { ok: true, month: bounds.month, rows: rows };
}
