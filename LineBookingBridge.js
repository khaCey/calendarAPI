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
BOOKING_SCRIPT_REVISION = '2026-08-17-private-calendar-reschedule-instance-v3';

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
 * Return only the identifiers/times the trusted Worker needs. The exact API
 * instance id is included for server-to-server mutation; the Worker encrypts it
 * before anything is returned to browser JavaScript.
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
      if (new Date(end).getTime() - new Date(start).getTime() !== 50 * 60 * 1000) continue;

      var eventId = String(event.iCalUID || event.id || '').trim();
      var apiEventId = String(event.id || '').trim();
      if (!eventId || !apiEventId) continue;

      var direction = lineBookingRescheduleDirection_(event.summary || '');
      var sourceRescheduled = direction === 'to';

      lessons.push({
        eventId: eventId,
        apiEventId: apiEventId,
        seriesMasterId: String(event.recurringEventId || '').trim() || null,
        occurrenceStartIso: start,
        start: start,
        end: end,
        status: sourceRescheduled ? 'rescheduled' : 'scheduled',
        canReschedule: !sourceRescheduled,
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

function lineBookingRollbackInsertedApiEvent_(calendarId, eventId) {
  if (!calendarId || !eventId) return;
  try { Calendar.Events.remove(calendarId, eventId); } catch (err) {}
}

/**
 * Patch the exact source API instance in place and create a new destination.
 * No setTime(), deleteEvent(), or source Events.remove() is used here.
 */
function createLineReschedulePairByApi_(calendarId, sourceApiEventId, body, moveWindow) {
  var source;
  try {
    source = Calendar.Events.get(calendarId, sourceApiEventId);
  } catch (getErr) {
    return {
      ok: false,
      error: 'Calendar source occurrence not found',
      code: 'RESCHEDULE_EVENT_NOT_FOUND'
    };
  }

  if (!source || source.status === 'cancelled') {
    return {
      ok: false,
      error: 'Calendar source occurrence not found',
      code: 'RESCHEDULE_EVENT_NOT_FOUND'
    };
  }

  var sourceStartIso = calendarApiBoundaryToIso_(source.start);
  var sourceEndIso = calendarApiBoundaryToIso_(source.end);
  var sourceStart = sourceStartIso ? new Date(sourceStartIso) : null;
  var sourceEnd = sourceEndIso ? new Date(sourceEndIso) : null;
  if (!sourceStart || !sourceEnd || isNaN(sourceStart.getTime()) || isNaN(sourceEnd.getTime())) {
    return {
      ok: false,
      error: 'Could not read source lesson time',
      code: 'RESCHEDULE_EVENT_NOT_FOUND'
    };
  }

  var expectedOccurrenceStart = String(body.occurrenceStartIso || '').trim();
  if (expectedOccurrenceStart) {
    var expectedDate = new Date(expectedOccurrenceStart);
    if (
      isNaN(expectedDate.getTime()) ||
      Math.abs(expectedDate.getTime() - sourceStart.getTime()) > 3 * 60 * 1000
    ) {
      return {
        ok: false,
        error: 'Lesson reference is stale. Reload lessons and try again.',
        code: 'STALE_LESSON_REFERENCE'
      };
    }
  }

  var sourceTitle = String(source.summary || '').trim();
  if (lineBookingRescheduleDirection_(sourceTitle) === 'to') {
    return {
      ok: false,
      error: 'Source lesson is already rescheduled',
      code: 'ALREADY_RESCHEDULED'
    };
  }

  var baseTitle = stripLineRescheduleMarker_(sourceTitle);
  var fromLabel = lineBookingOrdinalDayFromDate_(sourceStart);
  var toLabel = lineBookingOrdinalDayFromDate_(moveWindow.startDate);
  var sourceRescheduledTitle = applyLineRescheduleMarker_(baseTitle, 'to', toLabel);
  var destinationTitle = applyLineRescheduleMarker_(baseTitle, 'from', fromLabel);

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
    if (lineBookingApiConflict_(calendarId, sourceApiEventId, moveWindow)) {
      return {
        ok: false,
        error: 'Slot unavailable',
        code: 'SLOT_UNAVAILABLE'
      };
    }

    var destinationResource = {
      summary: destinationTitle,
      start: {
        dateTime: moveWindow.startIso,
        timeZone: 'Asia/Tokyo'
      },
      end: {
        dateTime: moveWindow.endIso,
        timeZone: 'Asia/Tokyo'
      }
    };

    if (source.description) destinationResource.description = String(source.description);
    if (source.location) destinationResource.location = String(source.location);
    if (source.colorId && String(source.colorId) !== '8') {
      destinationResource.colorId = String(source.colorId);
    } else {
      var kind = String(body.lessonKind || body.kind || 'regular').trim().toLowerCase();
      if (kind === 'regular') destinationResource.colorId = '10';
    }

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

    if (body.mergeStudentAdminDescription && typeof body.mergeStudentAdminDescription === 'object') {
      sourcePatch.description = mergeStudentAdminDescriptionIntoEvent_(
        String(source.description || ''),
        body.mergeStudentAdminDescription
      );
    }

    try {
      Calendar.Events.patch(sourcePatch, calendarId, sourceApiEventId);
    } catch (patchErr) {
      lineBookingRollbackInsertedApiEvent_(calendarId, destination && destination.id);
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
      sourceEventId: String(source.iCalUID || source.id || ''),
      sourceApiEventId: String(source.id || sourceApiEventId),
      destinationEventId: destination && destination.id ? String(destination.id) : null,
      sourceStart: sourceStart.toISOString(),
      sourceEnd: sourceEnd.toISOString(),
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

  var apiEventId = String(body.apiEventId || '').trim();
  if (!apiEventId) {
    return jsonOutput_(withBookingRevision_({
      ok: false,
      error: 'Missing exact Calendar occurrence id. Reload lessons and try again.',
      code: 'STALE_LESSON_REFERENCE'
    }));
  }

  var moveWindow = parseLessonBookMoveWindow_(body);
  if (moveWindow === null) return greenSquareOriginalDoPost_(e);
  if (!moveWindow.ok) return jsonOutput_(withBookingRevision_(moveWindow));

  var kind = String(body.lessonKind || body.kind || '').trim().toLowerCase();
  var calendarIds = getConfiguredCalendarIdsForSearch_(kind);
  var foundCalendarId = null;

  for (var i = 0; i < calendarIds.length; i++) {
    try {
      var candidate = Calendar.Events.get(calendarIds[i], apiEventId);
      if (candidate && candidate.status !== 'cancelled') {
        foundCalendarId = calendarIds[i];
        break;
      }
    } catch (getErr) {}
  }

  if (!foundCalendarId) {
    return jsonOutput_(withBookingRevision_({
      ok: false,
      error: 'Calendar source occurrence not found',
      code: 'RESCHEDULE_EVENT_NOT_FOUND'
    }));
  }

  return jsonOutput_(withBookingRevision_(
    createLineReschedulePairByApi_(foundCalendarId, apiEventId, body, moveWindow)
  ));
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
