/**
 * Calendar Webhook — Apps Script entry point.
 * Receives Google Calendar API push notifications and updates lessons_today.
 * Config (WEBHOOK_URL, SS_ID, etc.) in Config.js — files are merged into one scope.
 *
 * Flow:
 * 1. Deploy as Web App (Anyone) → copy the URL below
 * 2. Run registerCalendarWatch() once to register the watch
 * 3. When events change, Google POSTs to the webhook
 * 4. doPost() fetches events and updates sheets (MonthlySchedule via MonthlyCache.js, lessons_today via Functions.js)
 */

/**
 * Debug: log when a POST request is received. Writes to WebhookLog sheet (Logger.log doesn't work with doPost).
 * @param {GoogleAppsScript.Events.DoPost} e - The doPost event object
 * @param {string=} extra - Optional extra info (e.g. error message)
 */
function logWebhookReceived(e, extra) {
  try {
    const ss = SpreadsheetApp.openById(SS_ID);
    let sheet = ss.getSheetByName(WEBHOOK_LOG_SHEET);
    if (!sheet) {
      sheet = ss.insertSheet(WEBHOOK_LOG_SHEET);
      sheet.getRange(1, 1, 1, 4).setValues([['Timestamp', 'Event', 'HasParams', 'Details']]);
    }
    const now = new Date();
    const hasParams = e && (e.parameters || (e.postData && e.postData.contents));
    const details = extra || (e && e.postData ? String(e.postData.contents).slice(0, 200) : '') || '';
    sheet.appendRow([now, 'POST received', !!hasParams, details]);
  } catch (err) {
    // Fallback: try to write to AppState or first sheet if WebhookLog fails
    try {
      const ss = SpreadsheetApp.openById(SS_ID);
      const sheet = ss.getSheets()[0];
      sheet.appendRow([new Date(), 'WebhookLog error:', String(err)]);
    } catch (_) {}
  }
}

function getPollingApiKey_() {
  try {
    var fromProps = PropertiesService.getScriptProperties().getProperty('POLL_API_KEY');
    if (fromProps) return String(fromProps).trim();
  } catch (err) {}
  return String(POLL_API_KEY || '').trim();
}

function getStudentSyncApiKey_() {
  try {
    var fromProps = PropertiesService.getScriptProperties().getProperty('STUDENT_SYNC_API_KEY');
    if (fromProps) return String(fromProps).trim();
  } catch (err) {}
  return String(typeof STUDENT_SYNC_API_KEY !== 'undefined' ? STUDENT_SYNC_API_KEY : '').trim();
}

function getBookingApiKey_() {
  try {
    var fromProps = PropertiesService.getScriptProperties().getProperty('BOOKING_API_KEY');
    if (fromProps) return String(fromProps).trim();
  } catch (err) {}
  return String(typeof BOOKING_API_KEY !== 'undefined' ? BOOKING_API_KEY : '').trim();
}

/**
 * One-time setup helper: write API keys into Script Properties.
 *
 * How to use:
 * - In the Apps Script editor, ensure your Config.js defines POLL_API_KEY / STUDENT_SYNC_API_KEY / BOOKING_API_KEY.
 * - Run this function once.
 * - Deploy a new Web app version after changing Script Properties.
 *
 * Notes:
 * - This function will NOT overwrite an existing Script Property value.
 * - Keys are stored in Script Properties so you don't have to hardcode them in source.
 */
function setupScriptPropertiesFromConfigOnce() {
  var props = PropertiesService.getScriptProperties();
  var updates = {};

  function maybeSet(key, val) {
    var existing = props.getProperty(key);
    if (existing && String(existing).trim() !== '') return;
    if (!val) return;
    updates[key] = String(val).trim();
  }

  try { maybeSet('POLL_API_KEY', String(POLL_API_KEY || '').trim()); } catch (e) {}
  try { maybeSet('STUDENT_SYNC_API_KEY', String(typeof STUDENT_SYNC_API_KEY !== 'undefined' ? STUDENT_SYNC_API_KEY : '').trim()); } catch (e) {}
  try { maybeSet('BOOKING_API_KEY', String(typeof BOOKING_API_KEY !== 'undefined' ? BOOKING_API_KEY : '').trim()); } catch (e) {}

  var keys = Object.keys(updates);
  if (keys.length === 0) {
    Logger.log('No Script Properties updated (already set or missing Config.js values).');
    return;
  }
  props.setProperties(updates, false);
  Logger.log('Updated Script Properties: ' + keys.join(', '));
}

function jsonOutput_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Normalize Calendar API dateTime to UTC ISO string so the backend always gets an unambiguous instant.
 * Fixes wrong-date issues when the API returns local or timezone-ambiguous strings.
 * @param {string|Date} val - start.dateTime or end.dateTime from Calendar API
 * @return {string|null} ISO string in UTC (e.g. "2026-03-16T01:00:00.000Z") or null
 */
function toUtcIso_(val) {
  if (val == null) return null;
  var d = (typeof val === 'string') ? new Date(val) : val;
  if (typeof d.getTime !== 'function' || isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * Sets the lesson event color when the server sends body.colorId (Basil = "10" for regular).
 * If colorId is omitted: demo and owner keep the calendar default (no setColor). Regular falls back to "10".
 * Uses Calendar API v3 patch first (reliable on group/shared calendars); falls back to CalendarApp.setColor.
 * @param {string} calId
 * @param {GoogleAppsScript.Calendar.CalendarEvent} event
 * @param {string} colorIdFromBody - optional; from server JSON body.colorId
 * @param {string} lessonKindLower - "demo" | "owner" | "regular" | ...
 */
function applyLessonBookEventColor_(calId, event, colorIdFromBody, lessonKindLower) {
  var kind = String(lessonKindLower || '').trim().toLowerCase();
  var cid = String(colorIdFromBody || '').trim();
  if (!cid) {
    if (kind === 'demo' || kind === 'owner') {
      return;
    }
    cid = '10';
  }
  if (!event || !calId) return;
  var evId = '';
  try {
    evId = event.getId();
  } catch (idErr) {
    return;
  }
  try {
    Calendar.Events.patch({ colorId: cid }, calId, evId);
  } catch (patchErr) {
    try {
      event.setColor(cid);
    } catch (setErr) {
      try {
        logWebhookReceived(
          { postData: { contents: '{}' } },
          'applyLessonBookEventColor_ colorId=' + cid + ' patch:' + String(patchErr) + ' set:' + String(setErr)
        );
      } catch (logE) {}
    }
  }
}

/**
 * Clears custom event color (calendar default). Uses API patch; avoids setColor('1'), which is Lavender in the event palette.
 */
function clearLessonBookEventColor_(calId, event) {
  if (!calId || !event) return;
  var evId = '';
  try {
    evId = event.getId();
  } catch (idErr) {
    return;
  }
  try {
    Calendar.Events.patch({ colorId: null }, calId, evId);
  } catch (patchNullErr) {
    try {
      Calendar.Events.patch({ colorId: '' }, calId, evId);
    } catch (patchEmptyErr) {
      try {
        logWebhookReceived(
          { postData: { contents: '{}' } },
          'clearLessonBookEventColor_ patchNull:' + String(patchNullErr) + ' patchEmpty:' + String(patchEmptyErr)
        );
      } catch (logE) {}
    }
  }
}

/** GET handler — serves polling JSON for react-app sync. */
function doGet() {
  try {
    var e = arguments[0] || {};
    var params = e.parameter || {};
    var providedKey = (params.key || '').toString().trim();
    var expectedKey = getPollingApiKey_();

    if (!expectedKey || providedKey !== expectedKey) {
      return jsonOutput_({ error: 'Unauthorized' });
    }

    // Staff schedule: list events for a given calendar (teacher availability). Used by STAFF_SCHEDULE_GAS_URL.
    var calendarIdParam = (params.calendarId || '').toString().trim();
    if (calendarIdParam) {
      var timeMin = (params.timeMin || '').toString().trim();
      var timeMax = (params.timeMax || '').toString().trim();
      if (!timeMin || !timeMax) {
        // Default: current month in Japan (Asia/Tokyo), not "from today + 31 days"
        var now = new Date();
        var jstMs = now.getTime() + 9 * 60 * 60 * 1000;
        var jstDay = Math.floor(jstMs / (24 * 60 * 60 * 1000));
        var d = new Date(jstDay * 24 * 60 * 60 * 1000);
        var y = d.getUTCFullYear();
        var m = d.getUTCMonth();
        var startOfMonthUtc = Date.UTC(y, m, 1, 0, 0, 0, 0) - 9 * 60 * 60 * 1000;
        var endOfMonthUtc = Date.UTC(y, m + 1, 1, 0, 0, 0, 0) - 9 * 60 * 60 * 1000;
        if (!timeMin) timeMin = new Date(startOfMonthUtc).toISOString();
        if (!timeMax) timeMax = new Date(endOfMonthUtc).toISOString();
      }
      try {
        var listOpts = {
          timeMin: timeMin,
          timeMax: timeMax,
          singleEvents: true,
          orderBy: 'startTime'
        };
        var listResult = Calendar.Events.list(calendarIdParam, listOpts);
        var items = listResult.items || [];
        var events = [];
        for (var i = 0; i < items.length; i++) {
          var ev = items[i];
          var start = ev.start || {};
          var end = ev.end || {};
          var startUtc = toUtcIso_(start.dateTime);
          var endUtc = toUtcIso_(end.dateTime);
          if (startUtc && endUtc) {
            events.push({
              id: ev.id,
              summary: ev.summary || '',
              start: { dateTime: startUtc },
              end: { dateTime: endUtc }
            });
          }
        }
        return jsonOutput_(events);
      } catch (err) {
        return jsonOutput_({ error: 'Calendar fetch failed: ' + String(err) });
      }
    }

    var monthParam = (params.month || '').toString().trim();
    var yearParam = (params.year || '').toString().trim();

    // Backfill: fetch specific month or year directly from Calendar (not cached sheets).
    if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
      var monthResult = getScheduleDataForMonth(monthParam);
      return jsonOutput_({
        data: monthResult.data || [],
        cacheVersion: 0,
        lastUpdated: new Date().toISOString(),
        backfill: { months: monthResult.month ? [monthResult.month] : [] }
      });
    }
    if (yearParam && /^\d{4}$/.test(yearParam)) {
      var yearResult = getScheduleDataForYear(yearParam);
      return jsonOutput_({
        data: yearResult.data || [],
        cacheVersion: 0,
        lastUpdated: new Date().toISOString(),
        backfill: { months: yearResult.months || [] }
      });
    }

    var isFull = String(params.full || '') === '1';
    var fullPayload = getScheduleDataForPolling();

    if (isFull) {
      savePreviousPollKeysFromData_(fullPayload.data || []);
      saveLastPollCacheVersion_(fullPayload.cacheVersion);
      return jsonOutput_(fullPayload);
    }

    // Incremental poll: diff.removed from ScriptProperties key cache; full snapshot in updated.
    var currentKeys = lessonKeysFromData_(fullPayload.data || []);
    var previousKeys = loadPreviousPollKeys_();
    var currentSet = {};
    for (var ki = 0; ki < currentKeys.length; ki++) {
      currentSet[currentKeys[ki]] = true;
    }
    var removed = [];
    for (var pj = 0; pj < previousKeys.length; pj++) {
      if (!currentSet[previousKeys[pj]]) removed.push(previousKeys[pj]);
    }
    var keysChanged = sortedKeysJson_(previousKeys) !== sortedKeysJson_(currentKeys);
    var lastVer = loadLastPollCacheVersion_();
    var verChanged = lastVer === null || lastVer !== fullPayload.cacheVersion;
    var changed = removed.length > 0 || keysChanged || verChanged;

    savePreviousPollKeysFromData_(fullPayload.data || []);
    saveLastPollCacheVersion_(fullPayload.cacheVersion);

    if (!changed) {
      return jsonOutput_({ changed: false });
    }

    return jsonOutput_({
      changed: true,
      diff: {
        added: [],
        updated: fullPayload.data || [],
        removed: removed,
        cacheVersion: fullPayload.cacheVersion,
        lastUpdated: fullPayload.lastUpdated
      }
    });
  } catch (err) {
    return jsonOutput_({ error: String(err) });
  }
}

/**
 * Webhook handler — receives Calendar API push notifications.
 * Apps Script does not expose request headers, so we run sync on every POST.
 * Google POSTs when events change; we refresh lessons_today and return 200.
 */
function doPost(e) {
  logWebhookReceived(e);

  // Student sync / booking path (server -> GAS). Keep webhook path unchanged when body/action is absent.
  try {
    var raw = (e && e.postData && e.postData.contents) ? String(e.postData.contents) : '';
    var body = {};
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch (jsonErr) {
        body = {};
      }
    }
    if (body && body.action === 'lesson_book_create') {
      var providedKey = '';
      if (e && e.parameter && e.parameter.key) providedKey = String(e.parameter.key).trim();
      if (!providedKey && body.key) providedKey = String(body.key).trim();
      var expectedKey = getBookingApiKey_();
      if (!expectedKey || providedKey !== expectedKey) {
        logWebhookReceived(e, 'lesson_book_create unauthorized');
        return jsonOutput_({ ok: false, error: 'Unauthorized' });
      }

      var kind = String(body.lessonKind || body.kind || '').trim().toLowerCase();
      var calId =
        kind === 'owner'
          ? OWNER_CALENDAR_ID
          : kind === 'demo'
            ? DEMO_CALENDAR_ID
            : CALENDAR_ID;
      if (!calId) return jsonOutput_({ ok: false, error: 'Calendar ID is not configured for kind: ' + kind });

      var summary = String(body.title || '').trim();
      if (!summary) return jsonOutput_({ ok: false, error: 'Missing title' });
      var startIso = String(body.start || '').trim();
      var endIso = String(body.end || '').trim();
      if (!startIso || !endIso) return jsonOutput_({ ok: false, error: 'Missing start/end' });
      var startDate = new Date(startIso);
      var endDate = new Date(endIso);
      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        return jsonOutput_({ ok: false, error: 'Invalid start/end datetime' });
      }

      var description = String(body.description || '').trim();
      var location = String(body.location || '').trim();
      var bookingKey = String(body.bookingKey || '').trim();
      var cal = CalendarApp.getCalendarById(calId);
      if (!cal) return jsonOutput_({ ok: false, error: 'Calendar not found: ' + calId });
      var syncMarker = bookingKey ? 'BookingSyncKey: ' + bookingKey : '';
      if (syncMarker && description.indexOf(syncMarker) === -1) {
        description = description ? (description + '\n' + syncMarker) : syncMarker;
      }
      var existing = null;
      if (bookingKey) {
        try {
          var candidates = cal.getEvents(startDate, endDate) || [];
          for (var ci2 = 0; ci2 < candidates.length; ci2++) {
            var desc = '';
            try { desc = String(candidates[ci2].getDescription() || ''); } catch (descErr) {}
            if (desc.indexOf(syncMarker) !== -1) {
              existing = candidates[ci2];
              break;
            }
          }
        } catch (searchErr) {}
      }
      var event = existing;
      if (event) {
        try { event.setTitle(summary); } catch (setTitleErr) {}
        try { event.setDescription(description || ''); } catch (setDescErr) {}
        try { event.setLocation(location || ''); } catch (setLocErr) {}
      } else {
        event = cal.createEvent(summary, startDate, endDate, {
          description: description || '',
          location: location || '',
        });
      }

      applyLessonBookEventColor_(calId, event, body.colorId, kind);

      try {
        cacheMonthlyEventsForBothMonths();
      } catch (cacheErr) {
        logWebhookReceived(e, 'lesson_book_create cacheMonthlyEventsForBothMonths failed: ' + String(cacheErr));
      }
      try {
        fetchAndCacheTodayLessons();
      } catch (todayErr) {}

      return jsonOutput_({
        ok: true,
        actionTaken: existing ? 'existing' : 'created',
        calendarId: calId,
        eventId: event.getId ? event.getId() : null,
      });
    }
    if (body && body.action === 'lesson_book_delete') {
      var providedDelKey = '';
      if (e && e.parameter && e.parameter.key) providedDelKey = String(e.parameter.key).trim();
      if (!providedDelKey && body.key) providedDelKey = String(body.key).trim();
      var expectedDelKey = getBookingApiKey_();
      if (!expectedDelKey || providedDelKey !== expectedDelKey) {
        logWebhookReceived(e, 'lesson_book_delete unauthorized');
        return jsonOutput_({ ok: false, error: 'Unauthorized' });
      }

      var eventIdRaw = String(body.eventId || '').trim();
      if (!eventIdRaw) return jsonOutput_({ ok: false, error: 'Missing eventId' });
      var found = null;
      var foundCalId = null;
      var cals = [CALENDAR_ID, DEMO_CALENDAR_ID, OWNER_CALENDAR_ID].filter(Boolean);
      for (var ci = 0; ci < cals.length; ci++) {
        try {
          var cal2 = CalendarApp.getCalendarById(cals[ci]);
          if (!cal2) continue;
          var ev2 = cal2.getEventById(eventIdRaw);
          if (ev2) {
            found = ev2;
            foundCalId = cals[ci];
            break;
          }
        } catch (ignoreErr) {}
      }
      if (!found) {
        return jsonOutput_({ ok: false, error: 'Calendar event not found', eventId: eventIdRaw });
      }
      found.deleteEvent();

      try { cacheMonthlyEventsForBothMonths(); } catch (cacheErr2) {}
      try { fetchAndCacheTodayLessons(); } catch (todayErr2) {}

      return jsonOutput_({
        ok: true,
        actionTaken: 'deleted',
        calendarId: foundCalId,
        eventId: eventIdRaw,
      });
    }
    if (body && body.action === 'lesson_book_update') {
      var providedUpdKey = '';
      if (e && e.parameter && e.parameter.key) providedUpdKey = String(e.parameter.key).trim();
      if (!providedUpdKey && body.key) providedUpdKey = String(body.key).trim();
      var expectedUpdKey = getBookingApiKey_();
      if (!expectedUpdKey || providedUpdKey !== expectedUpdKey) {
        logWebhookReceived(e, 'lesson_book_update unauthorized');
        return jsonOutput_({ ok: false, error: 'Unauthorized' });
      }

      var eventIdUpd = String(body.eventId || '').trim();
      if (!eventIdUpd) return jsonOutput_({ ok: false, error: 'Missing eventId' });
      var foundUpd = null;
      var foundUpdCalId = null;
      var calsUpd = [CALENDAR_ID, DEMO_CALENDAR_ID, OWNER_CALENDAR_ID].filter(Boolean);
      for (var ui = 0; ui < calsUpd.length; ui++) {
        try {
          var calUpd = CalendarApp.getCalendarById(calsUpd[ui]);
          if (!calUpd) continue;
          var evUpd = calUpd.getEventById(eventIdUpd);
          if (evUpd) {
            foundUpd = evUpd;
            foundUpdCalId = calsUpd[ui];
            break;
          }
        } catch (ignoreUpdErr) {}
      }
      if (!foundUpd) {
        return jsonOutput_({ ok: false, error: 'Calendar event not found', eventId: eventIdUpd });
      }

      var nextTitle = String(body.title || '').trim();
      if (nextTitle) {
        try { foundUpd.setTitle(nextTitle); } catch (titleErr) {}
      }
      if (body.clearColor === true || String(body.clearColor || '').toLowerCase() === 'true') {
        clearLessonBookEventColor_(foundUpdCalId, foundUpd);
      } else {
        var nextColorId = String(body.colorId || '').trim();
        if (nextColorId) {
          var updKind = String(body.lessonKind || body.kind || '').trim().toLowerCase();
          applyLessonBookEventColor_(foundUpdCalId, foundUpd, nextColorId, updKind);
        }
      }

      try { cacheMonthlyEventsForBothMonths(); } catch (cacheErr3) {}
      try { fetchAndCacheTodayLessons(); } catch (todayErr3) {}

      return jsonOutput_({
        ok: true,
        actionTaken: 'updated',
        calendarId: foundUpdCalId,
        eventId: eventIdUpd,
      });
    }
    if (body && body.action === 'student_upsert') {
      logStudentSync_('request_received', 'studentId=' + String(body.studentId || ''));
      var providedKey = '';
      if (e && e.parameter && e.parameter.key) providedKey = String(e.parameter.key).trim();
      if (!providedKey && body.key) providedKey = String(body.key).trim();
      var expectedKey = getStudentSyncApiKey_();
      if (!expectedKey || providedKey !== expectedKey) {
        logStudentSync_(
          'unauthorized',
          'studentId=' + String(body.studentId || '') + ' keyMatch=' + String(!!expectedKey && providedKey === expectedKey)
        );
        return jsonOutput_({ ok: false, error: 'Unauthorized' });
      }
      var syncResult = upsertStudentContact_(body);
      logStudentSync_(
        'request_finished',
        'studentId=' + String(body.studentId || '') + ' ok=' + String(!!syncResult.ok) + ' action=' + String(syncResult.actionTaken || '')
      );
      return jsonOutput_(syncResult);
    }
  } catch (err) {
    logWebhookReceived(e, 'Student sync route error: ' + String(err));
    logStudentSync_('route_error', String(err));
  }

  try {
    cacheMonthlyEventsForBothMonths();
    fetchAndCacheTodayLessons();
  } catch (err) {
    logWebhookReceived(e, 'Sync error: ' + String(err));
  }

  return ContentService.createTextOutput('OK').setMimeType(ContentService.MimeType.TEXT);
}

/**
 * Register Calendar API push notifications for all lesson calendars.
 * Run ONCE after deploying the Web App. Re-run every ~6 days (channels expire).
 * Uses WEBHOOK_URL from the top of this file (paste your deployment URL there).
 *
 * Time-driven triggers pass an event object as the first argument — only a string is treated as URL.
 *
 * @param {string|Object=} firstArg - Optional webhook URL, or trigger event object when scheduled
 */
function registerCalendarWatch(firstArg) {
  var url =
    typeof firstArg === 'string' && firstArg.indexOf('https://') === 0
      ? firstArg
      : WEBHOOK_URL;
  if (!url || typeof url !== 'string' || !url.startsWith('https://') || url.includes('YOUR_DEPLOYMENT_ID')) {
    throw new Error('Set WEBHOOK_URL at the top of Code.js to your deployed Web App URL');
  }

  const expiration = Date.now() + 6 * 24 * 60 * 60 * 1000; // ~6 days

  const calendars = [
    { id: 'greensquare.jp_h8u0oufn8feana384v67o46o78@group.calendar.google.com', name: 'main' },
    { id: 'greensquare.jp_1m1bhvfu9mtts7gq9s9jsj9kbk@group.calendar.google.com', name: 'demo' },
    { id: 'c_403306dccf2039f61a620a4cfc22424c5a6f79e945054e57f30ecc50c90b9207@group.calendar.google.com', name: 'owner' },
  ];

  for (const cal of calendars) {
    try {
      const channel = {
        id: Utilities.getUuid(),
        type: 'web_hook',
        address: url,
        expiration: expiration,
      };
      const result = Calendar.Events.watch(channel, cal.id);
      Logger.log('Registered watch for %s: %s', cal.name, JSON.stringify(result));
    } catch (err) {
      Logger.log('Failed to register watch for %s: %s', cal.name, err);
    }
  }

  Logger.log('Calendar watch registration complete. Re-run in ~6 days.');
}

/**
 * One-time OAuth: run from the Apps Script editor (Run) after `contacts` is listed in appsscript.json.
 * The web app reuses the deploying user's token; without this step, createContact fails with
 * "必要な権限: https://www.googleapis.com/auth/contacts" even when the manifest is correct.
 * After this succeeds: Deploy → Web app → New version (same /exec URL).
 */
function runAuthorizePeopleContactsOnce() {
  People.People.searchContacts({
    query: '___oauth_probe___',
    readMask: 'names,metadata',
    pageSize: 1,
  });
  Logger.log('People API Contacts scope OK. Deploy a new Web app version, then retry student sync.');
}

/**
 * Manual test: run from Editor to sync lessons_today without waiting for webhook.
 * Use this to verify the sync logic works. If this succeeds, the issue is webhook delivery.
 */
function manualSync() {
  cacheMonthlyEventsForBothMonths();
  fetchAndCacheTodayLessons();
  Logger.log('Manual sync complete. Check lessons_today and MonthlySchedule sheets.');
}

function setBookingApiKeyOnce() {
  var key = String(BOOKING_API_KEY || '').trim();
  if (!key) throw new Error('Set BOOKING_API_KEY in Config.js first');
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('BOOKING_API_KEY')) return;
  props.setProperty('BOOKING_API_KEY', key);
}
