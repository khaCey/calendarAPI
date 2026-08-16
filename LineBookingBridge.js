/**
 * LINE booking bridge for the private-calendar backend.
 *
 * Adds two server-to-server operations without changing the legacy Code.js
 * router implementation:
 *   - lesson_book_list   -> sanitised lesson references for the Worker
 *   - lesson_book_update with start/end -> safe single-occurrence reschedule
 *
 * Existing actions continue through the original doPost unchanged.
 */

var greenSquareOriginalDoPost_ = doPost;

function parseLineBookingRequestBody_(e) {
  var raw = (e && e.postData && e.postData.contents) ? String(e.postData.contents) : '';
  if (!raw) return {};
  try {
    var parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {};
  }
}

function lineBookingProvidedApiKey_(e, body) {
  var key = '';
  if (e && e.parameter && e.parameter.key) key = String(e.parameter.key).trim();
  if (!key && body && body.key) key = String(body.key).trim();
  return key;
}

function lineBookingAuthorised_(e, body) {
  var expected = getBookingApiKey_();
  return !!expected && lineBookingProvidedApiKey_(e, body) === expected;
}

/**
 * Return individual Calendar events with only the identifiers/times required by
 * the trusted Cloudflare Worker. No title, description, attendees, location or
 * other private event metadata is returned.
 */
function getPrivateCalendarLessonReferences_(window) {
  var calendarId = getMainCalendarId_();
  var pageToken = null;
  var lessons = [];

  do {
    var options = {
      timeMin: window.timeMin,
      timeMax: window.timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      showDeleted: false,
      maxResults: 2500,
      timeZone: 'Asia/Tokyo'
    };
    if (pageToken) options.pageToken = pageToken;

    var result = Calendar.Events.list(calendarId, options);
    var items = result.items || [];

    for (var i = 0; i < items.length; i++) {
      var event = items[i] || {};
      if (event.status === 'cancelled' || event.transparency === 'transparent') continue;

      var start = calendarApiBoundaryToIso_(event.start);
      var end = calendarApiBoundaryToIso_(event.end);
      if (!start || !end || new Date(start).getTime() >= new Date(end).getTime()) continue;

      // CalendarApp.getEventById() expects the iCal UID. Fall back to API id for
      // legacy/non-standard resources where iCalUID is unavailable.
      var eventId = String(event.iCalUID || event.id || '').trim();
      if (!eventId) continue;

      lessons.push({
        eventId: eventId,
        seriesMasterId: String(event.recurringEventId || '').trim() || null,
        occurrenceStartIso: start,
        start: start,
        end: end
      });
    }

    pageToken = result.nextPageToken || null;
  } while (pageToken);

  return lessons;
}

function handleLineLessonList_(e, body) {
  if (!lineBookingAuthorised_(e, body)) {
    return jsonOutput_(withBookingRevision_({ ok: false, error: 'Unauthorized' }));
  }

  try {
    var window = parsePrivateAvailabilityWindow_(body);
    return jsonOutput_(withBookingRevision_({
      ok: true,
      timeZone: getPrivateCalendarTimeZone_(),
      window: window,
      lessons: getPrivateCalendarLessonReferences_(window)
    }));
  } catch (err) {
    return jsonOutput_(withBookingRevision_({
      ok: false,
      error: String(err && err.message ? err.message : err),
      code: 'REQUEST_ERROR'
    }));
  }
}

function applyLineRescheduleMetadata_(calendarId, event, body) {
  var nextTitle = String(body.title || '').trim();
  if (nextTitle) {
    try { event.setTitle(nextTitle); } catch (titleErr) {}
  }

  if (body.clearColor === true || String(body.clearColor || '').toLowerCase() === 'true') {
    clearLessonBookEventColor_(calendarId, event);
  } else {
    var nextColorId = String(body.colorId || '').trim();
    if (nextColorId) {
      var kind = String(body.lessonKind || body.kind || '').trim().toLowerCase();
      applyLessonBookEventColor_(calendarId, event, nextColorId, kind);
    }
  }

  if (body.mergeStudentAdminDescription && typeof body.mergeStudentAdminDescription === 'object') {
    try {
      var existingDesc = '';
      try { existingDesc = String(event.getDescription() || ''); } catch (getDescErr) {}
      var merged = mergeStudentAdminDescriptionIntoEvent_(existingDesc, body.mergeStudentAdminDescription);
      try { event.setDescription(merged); } catch (setDescErr) {}
    } catch (mergeErr) {}
  }
}

function handleLineLessonReschedule_(e, body) {
  if (!lineBookingAuthorised_(e, body)) {
    return jsonOutput_(withBookingRevision_({ ok: false, error: 'Unauthorized' }));
  }

  var eventId = String(body.eventId || '').trim();
  if (!eventId) {
    return jsonOutput_(withBookingRevision_({
      ok: false,
      error: 'Missing eventId',
      code: 'RESCHEDULE_EVENT_NOT_FOUND'
    }));
  }

  // Supplying start/end is the explicit opt-in for this bridge. Metadata-only
  // lesson_book_update requests are deliberately left to the legacy router.
  var moveWindow = parseLessonBookMoveWindow_(body);
  if (moveWindow === null) return greenSquareOriginalDoPost_(e);
  if (!moveWindow.ok) return jsonOutput_(withBookingRevision_(moveWindow));

  var kind = String(body.lessonKind || body.kind || '').trim().toLowerCase();
  var calendarIds = getConfiguredCalendarIdsForSearch_(kind);
  var found = null;
  var foundCalendarId = null;

  for (var i = 0; i < calendarIds.length; i++) {
    try {
      var cal = openCalendarByConfiguredId_(calendarIds[i]);
      if (!cal) continue;
      var candidate = resolveLessonBookCalendarEvent_(cal, body);
      if (candidate) {
        found = candidate;
        foundCalendarId = calendarIds[i];
        break;
      }
    } catch (resolveErr) {}
  }

  if (!found) {
    return jsonOutput_(withBookingRevision_({
      ok: false,
      error: 'Calendar event not found',
      code: 'RESCHEDULE_EVENT_NOT_FOUND',
      eventId: eventId
    }));
  }

  var moveResult = applyLessonBookTimeUpdate_(foundCalendarId, found, body);
  if (!moveResult.ok) return jsonOutput_(withBookingRevision_(moveResult));

  applyLineRescheduleMetadata_(foundCalendarId, found, body);

  var resolvedId = eventId;
  try { resolvedId = found.getId ? String(found.getId()) : eventId; } catch (idErr) {}

  return jsonOutput_(withBookingRevision_({
    ok: true,
    actionTaken: moveResult.moved ? 'rescheduled' : 'updated',
    calendarId: foundCalendarId,
    eventId: resolvedId,
    start: moveResult.start || null,
    end: moveResult.end || null
  }));
}

// Apps Script compiles global function declarations before evaluating top-level
// statements, so this assignment wraps the existing Code.js entry point while
// retaining it for every action not handled here.
doPost = function (e) {
  var body = parseLineBookingRequestBody_(e);
  var action = String(body.action || '').trim().toLowerCase();

  if (action === 'lesson_book_list') {
    return handleLineLessonList_(e, body);
  }

  if (action === 'lesson_book_update' && (body.start != null || body.end != null)) {
    return handleLineLessonReschedule_(e, body);
  }

  return greenSquareOriginalDoPost_(e);
};
