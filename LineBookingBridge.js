/**
 * LINE booking bridge for the private-calendar backend.
 *
 * Adds server-to-server operations without changing the legacy Code.js router:
 *   - availability       -> busy windows excluding old rescheduled source slots
 *   - lesson_book_list   -> sanitised lesson references for the Worker
 *   - lesson_book_update with start/end -> Green Square-style reschedule
 *
 * Rescheduling mirrors the original Green Square convention:
 *   - the source occurrence stays at the original date/time
 *   - the source becomes Graphite and gets "Moved to <day>"
 *   - a separate destination event is inserted with "Moved from <day>"
 *
 * The exact Calendar API instance id is used for the source patch. This is
 * important for recurring events: patching the concrete instance creates an
 * exception at the original slot instead of moving/removing the occurrence.
 */

var greenSquareOriginalDoPost_ = doPost;
BOOKING_SCRIPT_REVISION = '2026-08-17-private-calendar-lesson-list-v4';

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

function lineBookingOrdinalSuffix_(day) {
  var n = Number(day);
  var mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return 'th';
  var mod10 = n % 10;
  if (mod10 === 1) return 'st';
  if (mod10 === 2) return 'nd';
  if (mod10 === 3) return 'rd';
  return 'th';
}

function lineBookingOrdinalDayFromDate_(date) {
  if (!date || typeof date.getTime !== 'function' || isNaN(date.getTime())) return '???';
  var dayText = Utilities.formatDate(date, 'Asia/Tokyo', 'd');
  var day = parseInt(dayText, 10);
  if (!Number.isFinite(day) || day < 1 || day > 31) return '???';
  return String(day) + lineBookingOrdinalSuffix_(day);
}

var LINE_RESCHEDULE_TITLE_MARKER_RE_ = /Moved\s+(to|from)\s+(\?{3}|\d{1,2}(?:st|nd|rd|th))/i;

function lineBookingRescheduleDirection_(title) {
  var match = String(title || '').match(LINE_RESCHEDULE_TITLE_MARKER_RE_);
  if (!match) return '';
  return String(match[1] || '').toLowerCase() === 'from' ? 'from' : 'to';
}

function stripLineRescheduleMarker_(title) {
  var value = String(title || '').trim();
  if (!value) return '';
  value = value.replace(/^\s*Moved\s+(?:to|from)\s+(?:\?{3}|\d{1,2}(?:st|nd|rd|th))\s*[·•-]\s*/i, '');
  value = value.replace(/\s*[·•-]\s*Moved\s+(?:to|from)\s+(?:\?{3}|\d{1,2}(?:st|nd|rd|th))\s*$/i, '');
  return value.replace(/\s{2,}/g, ' ').trim();
}

function applyLineRescheduleMarker_(baseTitle, direction, dayLabel) {
  var base = stripLineRescheduleMarker_(baseTitle);
  var dir = String(direction || '').toLowerCase() === 'from' ? 'from' : 'to';
  var label = String(dayLabel || '').trim() || '???';
  var marker = 'Moved ' + dir + ' ' + label;
  return base ? (base + ' · ' + marker) : marker;
}

/** Old "Moved to" source events remain visible for history but do not block. */
function getLineBookingAvailabilityBusyWindows_(window) {
  var calendarId = getMainCalendarId_();
  var pageToken = null;
  var busy = [];

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
      if (lineBookingRescheduleDirection_(event.summary || '') === 'to') continue;

      var start = calendarApiBoundaryToIso_(event.start);
      var end = calendarApiBoundaryToIso_(event.end);
      if (start && end && new Date(start).getTime() < new Date(end).getTime()) {
        busy.push({ start: start, end: end });
      }
    }

    pageToken = result.nextPageToken || null;
  } while (pageToken);

  return mergeBusyWindows_(busy);
}

function handleLineAvailability_(e, body) {
  if (!lineBookingAuthorised_(e, body)) {
    return jsonOutput_(withBookingRevision_({ ok: false, error: 'Unauthorized' }));
  }

  try {
    var window = parsePrivateAvailabilityWindow_(body);
    return jsonOutput_(withBookingRevision_({
      ok: true,
      timeZone: getPrivateCalendarTimeZone_(),
      window: window,
      busy: getLineBookingAvailabilityBusyWindows_(window)
    }));
  } catch (err) {
    return jsonOutput_(withBookingRevision_({
      ok: false,
      error: String(err && err.message ? err.message : err),
      code: 'REQUEST_ERROR'
    }));
  }
}

/**
 * Return every timed Calendar record in the requested lesson window.
 *
 * Do NOT filter the list to exactly 50 minutes. Older/manual Calendar records
 * can have a different duration and still need to remain visible in lesson
 * history. A non-50-minute record is simply read-only in the LINE app.
 *
 * Private Calendar text is inspected server-side only to derive reschedule
 * state; the title/description/attendees/location are never returned.
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
      if (!start || !end) continue;

      var startMs = new Date(start).getTime();
      var endMs = new Date(end).getTime();
      if (!isFinite(startMs) || !isFinite(endMs) || startMs >= endMs) continue;

      var eventId = String(event.iCalUID || event.id || '').trim();
      var apiEventId = String(event.id || '').trim();
      if (!eventId) continue;

      var durationMinutes = Math.round((endMs - startMs) / (60 * 1000));
      var direction = lineBookingRescheduleDirection_(event.summary || '');
      var sourceRescheduled = direction === 'to';
      var exactFiftyMinutes = durationMinutes === 50;

      lessons.push({
        eventId: eventId,
        apiEventId: apiEventId || null,
        seriesMasterId: String(event.recurringEventId || '').trim() || null,
        occurrenceStartIso: start,
        start: start,
        end: end,
        durationMinutes: durationMinutes,
        status: sourceRescheduled ? 'rescheduled' : 'scheduled',
        canReschedule: !sourceRescheduled && exactFiftyMinutes && !!apiEventId,
        rescheduleDirection: direction || null
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

function lineBookingApiConflict_(calendarId, sourceApiEventId, moveWindow) {
  var options = {
    timeMin: moveWindow.startIso,
    timeMax: moveWindow.endIso,
    singleEvents: true,
    orderBy: 'startTime',
    showDeleted: false,
    maxResults: 2500,
    timeZone: 'Asia/Tokyo'
  };

  var result = Calendar.Events.list(calendarId, options);
  var items = result.items || [];
  for (var i = 0; i < items.length; i++) {
    var event = items[i] || {};
    if (String(event.id || '') === String(sourceApiEventId || '')) continue;
    if (event.status === 'cancelled' || event.transparency === 'transparent') continue;
    if (lineBookingRescheduleDirection_(event.summary || '') === 'to') continue;

    var start = calendarApiBoundaryToIso_(event.start);
    var end = calendarApiBoundaryToIso_(event.end);
    if (!start || !end) continue;
    if (
      new Date(start).getTime() < moveWindow.endDate.getTime() &&
      new Date(end).getTime() > moveWindow.startDate.getTime()
    ) {
      return event;
    }
  }
  return null;
}

function lineBookingGetApiEvent_(calendarId, apiEventId) {
  try {
    return Calendar.Events.get(calendarId, apiEventId);
  } catch (err) {
    return null;
  }
}

function lineBookingCopyOptionalApiFields_(source, destination) {
  var src = source || {};
  var dest = destination || {};
  if (src.description) dest.description = src.description;
  if (src.location) dest.location = src.location;
  if (src.colorId) dest.colorId = src.colorId;
  return dest;
}

/**
 * Patch the exact old Calendar API occurrence in place and insert the new one.
 * The old occurrence's start/end are never changed and it is never removed.
 */
function createLineReschedulePairByApi_(calendarId, body, moveWindow) {
  var apiEventId = String(body.apiEventId || '').trim();
  if (!apiEventId) {
    return {
      ok: false,
      error: 'Missing exact Calendar API occurrence id',
      code: 'MISSING_API_EVENT_ID'
    };
  }

  var source = lineBookingGetApiEvent_(calendarId, apiEventId);
  if (!source || source.status === 'cancelled') {
    return {
      ok: false,
      error: 'Calendar event occurrence not found',
      code: 'RESCHEDULE_EVENT_NOT_FOUND'
    };
  }

  var sourceStartIso = calendarApiBoundaryToIso_(source.start);
  var sourceEndIso = calendarApiBoundaryToIso_(source.end);
  if (!sourceStartIso || !sourceEndIso) {
    return {
      ok: false,
      error: 'Could not read source lesson time',
      code: 'RESCHEDULE_EVENT_NOT_FOUND'
    };
  }

  var requestedOccurrenceIso = String(body.occurrenceStartIso || '').trim();
  if (
    requestedOccurrenceIso &&
    Math.abs(new Date(requestedOccurrenceIso).getTime() - new Date(sourceStartIso).getTime()) > 3 * 60 * 1000
  ) {
    return {
      ok: false,
      error: 'Lesson reference is stale',
      code: 'STALE_LESSON_REFERENCE'
    };
  }

  var sourceTitle = String(source.summary || '').trim();
  if (lineBookingRescheduleDirection_(sourceTitle) === 'to') {
    return {
      ok: false,
      error: 'Source lesson is already rescheduled',
      code: 'ALREADY_RESCHEDULED'
    };
  }

  var sourceStart = new Date(sourceStartIso);
  var baseTitle = stripLineRescheduleMarker_(sourceTitle);
  var sourceRescheduledTitle = applyLineRescheduleMarker_(
    baseTitle,
    'to',
    lineBookingOrdinalDayFromDate_(moveWindow.startDate)
  );
  var destinationTitle = applyLineRescheduleMarker_(
    baseTitle,
    'from',
    lineBookingOrdinalDayFromDate_(sourceStart)
  );

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return {
      ok: false,
      error: 'Booking system is busy. Please try again.',
      code: 'BOOKING_BUSY'
    };
  }

  var destination = null;
  try {
    if (lineBookingApiConflict_(calendarId, apiEventId, moveWindow)) {
      return {
        ok: false,
        error: 'Slot unavailable',
        code: 'SLOT_UNAVAILABLE'
      };
    }

    var destinationResource = lineBookingCopyOptionalApiFields_(source, {
      summary: destinationTitle,
      start: { dateTime: moveWindow.startIso, timeZone: 'Asia/Tokyo' },
      end: { dateTime: moveWindow.endIso, timeZone: 'Asia/Tokyo' }
    });

    try {
      destination = Calendar.Events.insert(destinationResource, calendarId);
    } catch (insertErr) {
      return {
        ok: false,
        error: 'Destination lesson creation failed: ' + String(
          insertErr && insertErr.message ? insertErr.message : insertErr
        ),
        code: 'RESCHEDULE_CREATE_FAILED'
      };
    }

    var sourcePatch = {
      summary: sourceRescheduledTitle,
      colorId: '8'
    };

    try {
      Calendar.Events.patch(sourcePatch, calendarId, apiEventId);
    } catch (patchErr) {
      try {
        if (destination && destination.id) Calendar.Events.remove(calendarId, destination.id);
      } catch (rollbackErr) {}
      return {
        ok: false,
        error: 'Source lesson reschedule marker failed: ' + String(
          patchErr && patchErr.message ? patchErr.message : patchErr
        ),
        code: 'RESCHEDULE_SOURCE_UPDATE_FAILED'
      };
    }

    return {
      ok: true,
      actionTaken: 'rescheduled',
      sourceEventId: String(source.iCalUID || body.eventId || ''),
      sourceApiEventId: apiEventId,
      destinationEventId: destination && destination.id ? String(destination.id) : null,
      sourceStart: sourceStartIso,
      sourceEnd: sourceEndIso,
      start: moveWindow.startIso,
      end: moveWindow.endIso
    };
  } finally {
    lock.releaseLock();
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

  var moveWindow = parseLessonBookMoveWindow_(body);
  if (moveWindow === null) return greenSquareOriginalDoPost_(e);
  if (!moveWindow.ok) return jsonOutput_(withBookingRevision_(moveWindow));

  var kind = String(body.lessonKind || body.kind || '').trim().toLowerCase();
  var calendarIds = getConfiguredCalendarIdsForSearch_(kind);
  var apiEventId = String(body.apiEventId || '').trim();
  if (!apiEventId) {
    return jsonOutput_(withBookingRevision_({
      ok: false,
      error: 'Missing exact Calendar API occurrence id',
      code: 'MISSING_API_EVENT_ID'
    }));
  }

  for (var i = 0; i < calendarIds.length; i++) {
    var source = lineBookingGetApiEvent_(calendarIds[i], apiEventId);
    if (!source) continue;
    return jsonOutput_(withBookingRevision_(
      createLineReschedulePairByApi_(calendarIds[i], body, moveWindow)
    ));
  }

  return jsonOutput_(withBookingRevision_({
    ok: false,
    error: 'Calendar event occurrence not found',
    code: 'RESCHEDULE_EVENT_NOT_FOUND',
    eventId: eventId
  }));
}

// Apps Script compiles global function declarations before evaluating top-level
// statements, so this assignment wraps the existing Code.js entry point while
// retaining it for every action not handled here.
doPost = function (e) {
  var body = parseLineBookingRequestBody_(e);
  var action = String(body.action || '').trim().toLowerCase();

  if (action === 'availability') {
    return handleLineAvailability_(e, body);
  }

  if (action === 'lesson_book_list') {
    return handleLineLessonList_(e, body);
  }

  if (action === 'lesson_book_update' && (body.start != null || body.end != null)) {
    return handleLineLessonReschedule_(e, body);
  }

  return greenSquareOriginalDoPost_(e);
};
