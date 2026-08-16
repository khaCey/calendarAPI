/**
 * LINE booking bridge for the private-calendar backend.
 *
 * Adds server-to-server operations without changing the legacy Code.js router:
 *   - availability       -> busy windows excluding old rescheduled source slots
 *   - lesson_book_list   -> sanitised lesson references for the Worker
 *   - lesson_book_update with start/end -> Green Square-style reschedule
 *
 * Identity deliberately mirrors Student Admin:
 *   eventId + occurrenceStartIso + seriesMasterId + updateScope=thisInstanceOnly
 * are passed to the existing resolveLessonBookCalendarEvent_() helper.
 *
 * No apiEventId is required from LINE or the Worker.
 *
 * Reschedule result:
 *   - source stays at its original date/time
 *   - source title becomes "... · Moved to <day>"
 *   - source becomes Graphite (8)
 *   - a separate destination event is created as "... · Moved from <day>"
 */

var greenSquareOriginalDoPost_ = doPost;
BOOKING_SCRIPT_REVISION = '2026-08-17-private-calendar-admin-reschedule-v5';

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

function lineBookingSafeTitle_(event) {
  try { return String(event && event.getTitle ? event.getTitle() : '').trim(); }
  catch (err) { return ''; }
}

function lineBookingSafeDescription_(event) {
  try { return String(event && event.getDescription ? event.getDescription() : ''); }
  catch (err) { return ''; }
}

function lineBookingSafeLocation_(event) {
  try { return String(event && event.getLocation ? event.getLocation() : ''); }
  catch (err) { return ''; }
}

function lineBookingSafeColor_(event) {
  try { return String(event && event.getColor ? event.getColor() : '').trim(); }
  catch (err) { return ''; }
}

function lineBookingSafeId_(event) {
  try { return String(event && event.getId ? event.getId() : '').trim(); }
  catch (err) { return ''; }
}

function lineBookingSafeTime_(event, methodName) {
  try {
    if (!event || typeof event[methodName] !== 'function') return null;
    var value = event[methodName]();
    if (!value || typeof value.getTime !== 'function' || isNaN(value.getTime())) return null;
    return value;
  } catch (err) {
    return null;
  }
}

function lineBookingSameOccurrence_(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;

  var leftId = normalizeCalendarComparableId_(lineBookingSafeId_(left));
  var rightId = normalizeCalendarComparableId_(lineBookingSafeId_(right));
  if (leftId && rightId && leftId !== rightId) return false;

  var leftStart = lineBookingSafeTime_(left, 'getStartTime');
  var rightStart = lineBookingSafeTime_(right, 'getStartTime');
  if (!leftStart || !rightStart) return false;
  return leftStart.getTime() === rightStart.getTime();
}

function lineBookingDestinationConflict_(calendar, sourceEvent, startDate, endDate) {
  var events = calendar.getEvents(startDate, endDate) || [];
  for (var i = 0; i < events.length; i++) {
    var candidate = events[i];
    if (lineBookingSameOccurrence_(candidate, sourceEvent)) continue;
    if (lineBookingRescheduleDirection_(lineBookingSafeTitle_(candidate)) === 'to') continue;
    if (calendarEventOverlaps_(candidate, startDate, endDate)) return candidate;
  }
  return null;
}

function lineBookingDestinationDescription_(sourceDescription) {
  var lines = String(sourceDescription || '').split(/\r?\n/);
  var kept = [];
  for (var i = 0; i < lines.length; i++) {
    var line = String(lines[i] || '');
    if (/^\s*BookingSyncKey\s*:/i.test(line)) continue;
    kept.push(line);
  }
  while (kept.length && !String(kept[kept.length - 1]).trim()) kept.pop();
  kept.push('Source: LINE reschedule');
  kept.push('BookingSyncKey: LINE-RESCHEDULE-' + Utilities.getUuid());
  return kept.join('\n');
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
 * Return timed Calendar records without exposing title/description/attendees.
 * The identity fields are server-to-server only; the Worker encrypts them into
 * an opaque lesson token before anything is returned to browser JavaScript.
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
      if (!eventId) continue;

      var durationMinutes = Math.round((endMs - startMs) / (60 * 1000));
      var direction = lineBookingRescheduleDirection_(event.summary || '');
      var sourceRescheduled = direction === 'to';

      lessons.push({
        eventId: eventId,
        // CalendarApp resolves recurring instances most reliably from iCalUID + occurrence time.
        seriesMasterId: event.recurringEventId ? eventId : null,
        occurrenceStartIso: start,
        start: start,
        end: end,
        durationMinutes: durationMinutes,
        status: sourceRescheduled ? 'rescheduled' : 'scheduled',
        canReschedule: !sourceRescheduled && durationMinutes === 50,
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

/**
 * Resolve exactly the way Student Admin's lesson_book_update path does.
 */
function resolveLineBookingSource_(body) {
  var kind = String(body.lessonKind || body.kind || '').trim().toLowerCase();
  var calendarIds = getConfiguredCalendarIdsForSearch_(kind);

  for (var i = 0; i < calendarIds.length; i++) {
    try {
      var calendar = openCalendarByConfiguredId_(calendarIds[i]);
      if (!calendar) continue;
      var event = resolveLessonBookCalendarEvent_(calendar, body);
      if (event) {
        return {
          calendarId: calendarIds[i],
          calendar: calendar,
          event: event
        };
      }
    } catch (err) {}
  }

  return null;
}

function createLineReschedulePairLikeAdmin_(resolved, body, moveWindow) {
  var calendarId = resolved.calendarId;
  var calendar = resolved.calendar;
  var source = resolved.event;

  var occurrenceStartIso = String(body.occurrenceStartIso || '').trim();
  if (!occurrenceStartIso) {
    return {
      ok: false,
      error: 'Missing occurrenceStartIso for reschedule',
      code: 'MISSING_OCCURRENCE_START'
    };
  }

  var expectedStart = new Date(occurrenceStartIso);
  var sourceStart = lineBookingSafeTime_(source, 'getStartTime');
  var sourceEnd = lineBookingSafeTime_(source, 'getEndTime');
  if (!sourceStart || !sourceEnd || isNaN(expectedStart.getTime())) {
    return {
      ok: false,
      error: 'Calendar event occurrence not found',
      code: 'RESCHEDULE_EVENT_NOT_FOUND'
    };
  }

  if (Math.abs(sourceStart.getTime() - expectedStart.getTime()) > 3 * 60 * 1000) {
    return {
      ok: false,
      error: 'Lesson reference is stale',
      code: 'STALE_LESSON_REFERENCE'
    };
  }

  var sourceTitle = lineBookingSafeTitle_(source);
  if (lineBookingRescheduleDirection_(sourceTitle) === 'to') {
    return {
      ok: false,
      error: 'Source lesson is already rescheduled',
      code: 'ALREADY_RESCHEDULED'
    };
  }

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

  var sourceDescription = lineBookingSafeDescription_(source);
  var sourceLocation = lineBookingSafeLocation_(source);
  var sourceColor = lineBookingSafeColor_(source);

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
    if (lineBookingDestinationConflict_(calendar, source, moveWindow.startDate, moveWindow.endDate)) {
      return {
        ok: false,
        error: 'Slot unavailable',
        code: 'SLOT_UNAVAILABLE'
      };
    }

    try {
      destination = calendar.createEvent(
        destinationTitle,
        moveWindow.startDate,
        moveWindow.endDate,
        {
          description: lineBookingDestinationDescription_(sourceDescription),
          location: sourceLocation || ''
        }
      );
      if (sourceColor && destination && typeof destination.setColor === 'function') {
        try { destination.setColor(sourceColor); } catch (destinationColorErr) {}
      }
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
      // Same source mutation as Admin: metadata only. Never setTime/delete source.
      source.setTitle(sourceRescheduledTitle);
      try {
        source.setColor('8');
      } catch (setSourceColorErr) {
        applyLessonBookEventColor_(calendarId, source, '8', String(body.lessonKind || '').toLowerCase());
      }

      if (sourceDescription) {
        try {
          source.setDescription(
            mergeStudentAdminDescriptionIntoEvent_(
              sourceDescription,
              { awaiting_reschedule_date: false }
            )
          );
        } catch (sourceDescriptionErr) {}
      }
    } catch (sourceUpdateErr) {
      try {
        if (destination && typeof destination.deleteEvent === 'function') destination.deleteEvent();
      } catch (rollbackErr) {}
      return {
        ok: false,
        error: 'Source lesson reschedule marker failed: ' + String(
          sourceUpdateErr && sourceUpdateErr.message ? sourceUpdateErr.message : sourceUpdateErr
        ),
        code: 'RESCHEDULE_SOURCE_UPDATE_FAILED'
      };
    }

    return {
      ok: true,
      actionTaken: 'rescheduled',
      calendarId: calendarId,
      sourceEventId: lineBookingSafeId_(source) || String(body.eventId || ''),
      destinationEventId: lineBookingSafeId_(destination) || null,
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

  var occurrenceStartIso = String(body.occurrenceStartIso || '').trim();
  if (!occurrenceStartIso) {
    return jsonOutput_(withBookingRevision_({
      ok: false,
      error: 'Missing occurrenceStartIso for reschedule',
      code: 'MISSING_OCCURRENCE_START'
    }));
  }

  var moveWindow = parseLessonBookMoveWindow_(body);
  if (moveWindow === null) return greenSquareOriginalDoPost_(e);
  if (!moveWindow.ok) return jsonOutput_(withBookingRevision_(moveWindow));

  var resolved = resolveLineBookingSource_(body);
  if (!resolved) {
    return jsonOutput_(withBookingRevision_({
      ok: false,
      error: 'Calendar event occurrence not found',
      code: 'RESCHEDULE_EVENT_NOT_FOUND',
      eventId: eventId
    }));
  }

  return jsonOutput_(withBookingRevision_(
    createLineReschedulePairLikeAdmin_(resolved, body, moveWindow)
  ));
}

// One wrapper only. Reschedule.js no longer wraps doPost.
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
