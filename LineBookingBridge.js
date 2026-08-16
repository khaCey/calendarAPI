/**
 * LINE booking bridge for the private-calendar backend.
 *
 * Adds two server-to-server operations without changing the legacy Code.js
 * router implementation:
 *   - lesson_book_list   -> sanitised lesson references for the Worker
 *   - lesson_book_update with start/end -> Green Square-style reschedule
 *
 * A reschedule keeps the source lesson in its original Calendar slot, marks it
 * as "Moved to <day>" + Graphite, and creates a separate destination lesson
 * titled "Moved from <day>". This mirrors the original Green Square workflow
 * instead of physically moving the old Calendar event.
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

/**
 * Return individual 50-minute Calendar events with only the identifiers/times
 * required by the trusted Cloudflare Worker. Private title text is inspected
 * server-side only to derive reschedule state and is never returned.
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
      if (!eventId) continue;

      var direction = lineBookingRescheduleDirection_(event.summary || '');
      var sourceRescheduled = direction === 'to';

      lessons.push({
        eventId: eventId,
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

function lineBookingReadEventField_(event, methodName) {
  try {
    if (!event || typeof event[methodName] !== 'function') return '';
    return String(event[methodName]() || '');
  } catch (err) {
    return '';
  }
}

function rollbackLineRescheduleDestination_(event) {
  if (!event) return;
  try {
    if (typeof event.deleteEvent === 'function') event.deleteEvent();
  } catch (err) {}
}

/**
 * Green Square-style reschedule:
 *   source slot: stays put, "Moved to <day>", Graphite
 *   destination: new event, "Moved from <day>", normal/original colour
 */
function createLineReschedulePair_(calendarId, sourceEvent, body, moveWindow) {
  var calendar = openCalendarByConfiguredId_(calendarId);
  if (!calendar) {
    return {
      ok: false,
      error: 'Calendar not found: ' + calendarId,
      code: 'RESCHEDULE_CALENDAR_NOT_FOUND'
    };
  }

  var sourceStart = lessonBookSafeEventTime_(sourceEvent, 'getStartTime');
  var sourceEnd = lessonBookSafeEventTime_(sourceEvent, 'getEndTime');
  if (!sourceStart || !sourceEnd) {
    return {
      ok: false,
      error: 'Could not read source lesson time',
      code: 'RESCHEDULE_EVENT_NOT_FOUND'
    };
  }

  var sourceTitle = lineBookingReadEventField_(sourceEvent, 'getTitle');
  var existingDirection = lineBookingRescheduleDirection_(sourceTitle);
  if (existingDirection === 'to') {
    return {
      ok: false,
      error: 'Source lesson is already rescheduled',
      code: 'ALREADY_RESCHEDULED'
    };
  }

  var sourceDescription = lineBookingReadEventField_(sourceEvent, 'getDescription');
  var sourceLocation = lineBookingReadEventField_(sourceEvent, 'getLocation');
  var sourceColor = lineBookingReadEventField_(sourceEvent, 'getColor');
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

  var destinationEvent = null;
  try {
    var inspection = inspectLessonBookMoveDestination_(
      calendar,
      moveWindow.startDate,
      moveWindow.endDate,
      sourceEvent
    );
    if (inspection.conflict) {
      return {
        ok: false,
        error: 'Slot unavailable',
        code: 'SLOT_UNAVAILABLE'
      };
    }

    try {
      destinationEvent = calendar.createEvent(
        destinationTitle,
        moveWindow.startDate,
        moveWindow.endDate,
        {
          description: sourceDescription || '',
          location: sourceLocation || ''
        }
      );
    } catch (createErr) {
      return {
        ok: false,
        error: 'Destination lesson creation failed: ' + String(
          createErr && createErr.message ? createErr.message : createErr
        ),
        code: 'RESCHEDULE_CREATE_FAILED'
      };
    }

    try {
      if (sourceColor && sourceColor !== '8') {
        try { destinationEvent.setColor(sourceColor); } catch (destColorErr) {}
      } else if (!sourceColor) {
        var kind = String(body.lessonKind || body.kind || 'regular').trim().toLowerCase();
        applyLessonBookEventColor_(calendarId, destinationEvent, '', kind);
      }

      sourceEvent.setTitle(sourceRescheduledTitle);
      try { sourceEvent.setColor('8'); } catch (sourceColorErr) {
        applyLessonBookEventColor_(calendarId, sourceEvent, '8', 'regular');
      }

      if (body.mergeStudentAdminDescription && typeof body.mergeStudentAdminDescription === 'object') {
        try {
          var mergedSourceDesc = mergeStudentAdminDescriptionIntoEvent_(
            sourceDescription,
            body.mergeStudentAdminDescription
          );
          sourceEvent.setDescription(mergedSourceDesc);
        } catch (mergeErr) {}
      }
    } catch (sourceUpdateErr) {
      rollbackLineRescheduleDestination_(destinationEvent);
      try { sourceEvent.setTitle(sourceTitle); } catch (restoreTitleErr) {}
      if (sourceColor) {
        try { sourceEvent.setColor(sourceColor); } catch (restoreColorErr) {}
      }
      return {
        ok: false,
        error: 'Source lesson reschedule marker failed: ' + String(
          sourceUpdateErr && sourceUpdateErr.message ? sourceUpdateErr.message : sourceUpdateErr
        ),
        code: 'RESCHEDULE_SOURCE_UPDATE_FAILED'
      };
    }

    var destinationId = '';
    try { destinationId = String(destinationEvent.getId ? destinationEvent.getId() : ''); } catch (destIdErr) {}

    return {
      ok: true,
      actionTaken: 'rescheduled',
      sourceEventId: lessonBookSafeEventId_(sourceEvent),
      destinationEventId: destinationId || null,
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

  var pairResult = createLineReschedulePair_(foundCalendarId, found, body, moveWindow);
  return jsonOutput_(withBookingRevision_(pairResult));
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
