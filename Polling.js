/**
 * Polling.js — Read the cached MonthlySchedule for the React/Admin polling API.
 *
 * The schedule itself is still persisted in Google Sheets. The hot polling path is backed by
 * CacheService and a Script Properties cache-version so repeated GET requests do not reopen and
 * reread MonthlySchedule until the webhook sync bumps the schedule version.
 */

var POLL_PAYLOAD_CACHE_PREFIX_ = 'schedule-poll-v2-';
var POLL_PAYLOAD_CACHE_TTL_SECONDS_ = 600;
var SCHEDULE_CACHE_VERSION_PROPERTY_ = 'SCHEDULE_CACHE_VERSION';
var SCHEDULE_CACHE_UPDATED_PROPERTY_ = 'SCHEDULE_CACHE_LAST_UPDATED';
var POLL_PREVIOUS_KEYS_PROPERTY_ = 'POLL_PREVIOUS_ROW_KEYS';
var POLL_PREVIOUS_KEYS_CHUNK_COUNT_PROPERTY_ = 'POLL_PREVIOUS_ROW_KEYS_CHUNK_COUNT';
var POLL_PREVIOUS_KEYS_CHUNK_PREFIX_ = 'POLL_PREVIOUS_ROW_KEYS_CHUNK_';
var LAST_POLL_CACHE_VERSION_PROPERTY_ = 'LAST_POLL_CACHE_VERSION';

function getOrCreateScheduleCacheStateSheet_(ss) {
  var sheet = ss.getSheetByName(SCHEDULE_CACHE_STATE_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(SCHEDULE_CACHE_STATE_SHEET);
    sheet.getRange(1, 1, 1, 2).setValues([['cacheVersion', 'lastUpdated']]);
    sheet.getRange(2, 1, 1, 2).setValues([[0, new Date().toISOString()]]);
  }
  return sheet;
}

/**
 * Get schedule cache state. Script Properties are the hot path; the sheet is only a fallback for
 * first run / migration from the previous implementation.
 */
function getScheduleCacheState() {
  var props = PropertiesService.getScriptProperties();
  var versionRaw = props.getProperty(SCHEDULE_CACHE_VERSION_PROPERTY_);
  var updatedRaw = props.getProperty(SCHEDULE_CACHE_UPDATED_PROPERTY_);

  if (versionRaw !== null && versionRaw !== '') {
    var parsed = parseInt(versionRaw, 10);
    return {
      cacheVersion: isNaN(parsed) ? 0 : parsed,
      lastUpdated: updatedRaw || ''
    };
  }

  var version = 0;
  var lastUpdated = '';
  try {
    var ss = SpreadsheetApp.openById(ADMIN_SS_ID);
    var sheet = ss.getSheetByName(SCHEDULE_CACHE_STATE_SHEET);
    if (sheet && sheet.getLastRow() >= 2) {
      var values = sheet.getRange(2, 1, 1, 2).getValues()[0];
      var sheetVersion = parseInt(values[0], 10);
      version = isNaN(sheetVersion) ? 0 : sheetVersion;
      lastUpdated = values[1] instanceof Date
        ? values[1].toISOString()
        : String(values[1] || '');
    }
  } catch (e) {}

  var stateProps = {};
  stateProps[SCHEDULE_CACHE_VERSION_PROPERTY_] = String(version);
  stateProps[SCHEDULE_CACHE_UPDATED_PROPERTY_] = lastUpdated;
  props.setProperties(stateProps, false);

  return { cacheVersion: version, lastUpdated: lastUpdated };
}

function getScheduleCacheVersion_() {
  return getScheduleCacheState().cacheVersion;
}

/**
 * Called after MonthlySchedule has been rebuilt. The new version changes the CacheService key, so
 * polling immediately stops using the old snapshot without needing to scan/delete cache entries.
 */
function bumpScheduleCacheVersion() {
  var lock = LockService.getScriptLock();
  var locked = false;
  try { locked = lock.tryLock(5000); } catch (e) {}

  try {
    var state = getScheduleCacheState();
    var previousVersion = Number(state.cacheVersion || 0);
    var nextVersion = previousVersion + 1;
    var lastUpdated = new Date().toISOString();

    var nextProps = {};
    nextProps[SCHEDULE_CACHE_VERSION_PROPERTY_] = String(nextVersion);
    nextProps[SCHEDULE_CACHE_UPDATED_PROPERTY_] = lastUpdated;
    PropertiesService.getScriptProperties().setProperties(nextProps, false);

    try {
      var ss = SpreadsheetApp.openById(ADMIN_SS_ID);
      var sheet = getOrCreateScheduleCacheStateSheet_(ss);
      sheet.getRange(2, 1, 1, 2).setValues([[nextVersion, lastUpdated]]);
    } catch (sheetErr) {
      Logger.log('bumpScheduleCacheVersion sheet write failed: ' + String(sheetErr));
    }

    try {
      CacheService.getScriptCache().remove(POLL_PAYLOAD_CACHE_PREFIX_ + String(previousVersion));
    } catch (cacheErr) {}

    return { cacheVersion: nextVersion, lastUpdated: lastUpdated };
  } finally {
    if (locked) {
      try { lock.releaseLock(); } catch (e) {}
    }
  }
}

function pollingMonthFromValue_(value, tz) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, tz, 'yyyy-MM');
  }
  var s = String(value == null ? '' : value).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}/.test(s)) return s.substring(0, 7);
  try {
    if (typeof toYYYYMM === 'function') {
      var parsed = toYYYYMM(s);
      if (parsed) return parsed;
    }
  } catch (e) {}
  var d = new Date(s);
  if (!isNaN(d.getTime())) return Utilities.formatDate(d, tz, 'yyyy-MM');
  return '';
}

function pollingDateString_(value, tz, fallbackDate) {
  if (value instanceof Date && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, tz, 'yyyy-MM-dd HH:mm');
  }
  var s = String(value == null ? '' : value).trim();
  if (!s) return '';
  if (/^\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}/.test(s)) return s;
  if (/^\d{1,2}:\d{2}/.test(s) && fallbackDate) {
    return String(fallbackDate).substring(0, 10) + ' ' + s.substring(0, 5);
  }
  return s;
}

/**
 * Read MonthlySchedule once and convert it to the JSON shape used by Code.js polling.
 * Only the current month is returned, matching the pre-existing polling contract.
 */
function readScheduleSheetsForPolling() {
  var ss = SpreadsheetApp.openById(ADMIN_SS_ID);
  var sheet = ss.getSheetByName('MonthlySchedule');
  if (!sheet) return [];

  var lastRow = sheet.getLastRow();
  var lastColumn = sheet.getLastColumn();
  if (lastRow < 2 || lastColumn < 1) return [];

  var values = sheet.getRange(1, 1, lastRow, lastColumn).getValues();
  var headers = values[0].map(function (h) { return String(h || '').trim(); });
  var rows = values.slice(1);
  var tz = Session.getScriptTimeZone();
  var currentMonth = Utilities.formatDate(new Date(), tz, 'yyyy-MM');

  function idx(name, fallback) {
    var found = headers.indexOf(name);
    return found >= 0 ? found : fallback;
  }

  var iEvent = idx('EventID', 0);
  var iTitle = idx('Title', 1);
  var iDate = idx('Date', 2);
  var iStart = idx('Start', 3);
  var iEnd = idx('End', 4);
  var iStatus = idx('Status', 5);
  var iStudent = idx('StudentName', 6);
  var iKids = idx('IsKidsLesson', 7);
  var iTeacher = idx('TeacherName', 8);
  var iKind = idx('LessonKind', 9);
  var iAwaiting = idx('AwaitingRescheduleDate', 10);

  var out = [];
  rows.forEach(function (row) {
    var dateValue = row[iDate];
    if (pollingMonthFromValue_(dateValue, tz) !== currentMonth) return;

    var dateString = dateValue instanceof Date && !isNaN(dateValue.getTime())
      ? Utilities.formatDate(dateValue, tz, 'yyyy-MM-dd')
      : String(dateValue || '').trim();
    var kind = String(row[iKind] || 'regular').trim().toLowerCase();
    if (kind !== 'regular' && kind !== 'demo' && kind !== 'owner') kind = 'regular';

    var item = {
      eventID: String(row[iEvent] || '').trim(),
      title: String(row[iTitle] || '').trim(),
      date: dateString,
      start: pollingDateString_(row[iStart], tz, dateString),
      end: pollingDateString_(row[iEnd], tz, dateString),
      status: String(row[iStatus] || 'scheduled').trim() || 'scheduled',
      studentName: String(row[iStudent] || '').trim(),
      isKidsLesson: row[iKids] === true || row[iKids] === '子' || String(row[iKids]).toLowerCase() === 'true',
      teacherName: String(row[iTeacher] || '').trim(),
      lessonKind: kind
    };

    var awaiting = row[iAwaiting];
    if (awaiting === true || awaiting === 1 || String(awaiting).trim() === '1') {
      item.awaitingRescheduleDate = true;
    } else if (awaiting === false || awaiting === 0 || String(awaiting).trim() === '0') {
      item.awaitingRescheduleDate = false;
    }

    out.push(item);
  });

  return out;
}

function encodePollingPayloadForCache_(payload) {
  var json = JSON.stringify(payload);
  try {
    var zipped = Utilities.gzip(Utilities.newBlob(json, 'application/json'));
    return 'gz:' + Utilities.base64EncodeWebSafe(zipped.getBytes());
  } catch (e) {
    return 'json:' + json;
  }
}

function decodePollingPayloadFromCache_(encoded) {
  if (!encoded) return null;
  try {
    if (encoded.indexOf('gz:') === 0) {
      var bytes = Utilities.base64DecodeWebSafe(encoded.substring(3));
      return JSON.parse(Utilities.ungzip(Utilities.newBlob(bytes)).getDataAsString('UTF-8'));
    }
    if (encoded.indexOf('json:') === 0) return JSON.parse(encoded.substring(5));
    return JSON.parse(encoded);
  } catch (e) {
    return null;
  }
}

/**
 * Polling hot path. On a cache hit this performs no SpreadsheetApp calls.
 */
function getScheduleDataForPolling() {
  var state = getScheduleCacheState();
  var cacheKey = POLL_PAYLOAD_CACHE_PREFIX_ + String(state.cacheVersion || 0);
  var cache = CacheService.getScriptCache();

  try {
    var cached = decodePollingPayloadFromCache_(cache.get(cacheKey));
    if (cached && Array.isArray(cached.data)) return cached;
  } catch (e) {}

  var payload = {
    data: readScheduleSheetsForPolling(),
    cacheVersion: Number(state.cacheVersion || 0),
    lastUpdated: state.lastUpdated || ''
  };

  try {
    var encoded = encodePollingPayloadForCache_(payload);
    // CacheService values are limited to roughly 100 KB. Skip caching unusually large payloads
    // rather than failing the request; gzip keeps normal current-month payloads comfortably below it.
    if (encoded.length < 95000) {
      cache.put(cacheKey, encoded, POLL_PAYLOAD_CACHE_TTL_SECONDS_);
    }
  } catch (e) {}

  return payload;
}

function rowKeyFromLessonRow_(row) {
  var r = row || {};
  return [
    String(r.eventID || '').trim(),
    String(r.date || '').trim(),
    String(r.start || '').trim(),
    String(r.studentName || '').trim(),
    String(r.lessonKind || 'regular').trim()
  ].join('|');
}

function lessonKeysFromData_(data) {
  var seen = {};
  var out = [];
  (Array.isArray(data) ? data : []).forEach(function (row) {
    var key = rowKeyFromLessonRow_(row);
    if (!key || seen[key]) return;
    seen[key] = true;
    out.push(key);
  });
  return out.sort();
}

function encodePreviousPollKeys_(keys) {
  var json = JSON.stringify(Array.isArray(keys) ? keys : []);
  try {
    var zipped = Utilities.gzip(Utilities.newBlob(json, 'application/json'));
    return 'gz:' + Utilities.base64EncodeWebSafe(zipped.getBytes());
  } catch (e) {
    return 'json:' + json;
  }
}

function decodePreviousPollKeys_(encoded) {
  if (!encoded) return [];
  try {
    if (encoded.indexOf('gz:') === 0) {
      var bytes = Utilities.base64DecodeWebSafe(encoded.substring(3));
      var json = Utilities.ungzip(Utilities.newBlob(bytes)).getDataAsString('UTF-8');
      var parsed = JSON.parse(json);
      return Array.isArray(parsed) ? parsed : [];
    }
    if (encoded.indexOf('json:') === 0) {
      var parsedJson = JSON.parse(encoded.substring(5));
      return Array.isArray(parsedJson) ? parsedJson : [];
    }
    var legacy = JSON.parse(encoded);
    return Array.isArray(legacy) ? legacy : [];
  } catch (e) {
    return [];
  }
}

function loadPreviousPollKeys_() {
  var props = PropertiesService.getScriptProperties();
  var count = parseInt(props.getProperty(POLL_PREVIOUS_KEYS_CHUNK_COUNT_PROPERTY_) || '0', 10);
  if (count > 0) {
    var encoded = '';
    for (var i = 0; i < count; i++) {
      encoded += props.getProperty(POLL_PREVIOUS_KEYS_CHUNK_PREFIX_ + i) || '';
    }
    return decodePreviousPollKeys_(encoded);
  }

  // Backwards compatibility with the original single-property implementation.
  return decodePreviousPollKeys_(props.getProperty(POLL_PREVIOUS_KEYS_PROPERTY_) || '[]');
}

function savePreviousPollKeysFromData_(data) {
  var props = PropertiesService.getScriptProperties();
  var encoded = encodePreviousPollKeys_(lessonKeysFromData_(data));
  var chunkSize = 7000;
  var chunks = [];
  for (var pos = 0; pos < encoded.length; pos += chunkSize) {
    chunks.push(encoded.substring(pos, pos + chunkSize));
  }
  if (chunks.length === 0) chunks.push('json:[]');

  var oldCount = parseInt(props.getProperty(POLL_PREVIOUS_KEYS_CHUNK_COUNT_PROPERTY_) || '0', 10);
  var updates = {};
  updates[POLL_PREVIOUS_KEYS_CHUNK_COUNT_PROPERTY_] = String(chunks.length);
  for (var i = 0; i < chunks.length; i++) {
    updates[POLL_PREVIOUS_KEYS_CHUNK_PREFIX_ + i] = chunks[i];
  }
  props.setProperties(updates, false);

  for (var j = chunks.length; j < oldCount; j++) {
    props.deleteProperty(POLL_PREVIOUS_KEYS_CHUNK_PREFIX_ + j);
  }
  props.deleteProperty(POLL_PREVIOUS_KEYS_PROPERTY_);
}

function sortedKeysJson_(keys) {
  return JSON.stringify((Array.isArray(keys) ? keys.slice() : []).sort());
}

function pollPreviousKeyStillPresent_(previousKey, currentSet) {
  return !!(currentSet && currentSet[previousKey]);
}

function loadLastPollCacheVersion_() {
  var raw = PropertiesService.getScriptProperties().getProperty(LAST_POLL_CACHE_VERSION_PROPERTY_);
  if (raw === null || raw === '') return null;
  var n = parseInt(raw, 10);
  return isNaN(n) ? null : n;
}

function saveLastPollCacheVersion_(version) {
  PropertiesService.getScriptProperties().setProperty(
    LAST_POLL_CACHE_VERSION_PROPERTY_,
    String(Number(version || 0))
  );
}
