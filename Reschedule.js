/**
 * Reschedule.js — safe time-move helpers for lesson_book_update.
 *
 * A lesson time update is opt-in: metadata-only lesson_book_update requests keep
 * their existing behaviour. Supplying both body.start and body.end requests a
 * move of exactly one 50-minute lesson occurrence.
 */

function parseLessonBookMoveWindow_(body) {
  var input = body || {};
  var startIso = String(input.start || '').trim();
  var endIso = String(input.end || '').trim();

  if (!startIso && !endIso) return null;
  if (!startIso || !endIso) {
    return {
      ok: false,
      error: 'Provide both start and end when rescheduling a lesson',
      code: 'INVALID_RESCHEDULE_WINDOW'
    };
  }

  var startDate = new Date(startIso);
  var endDate = new Date(endIso);
  if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
    return {
      ok: false,
      error: 'Invalid start/end datetime',
      code: 'INVALID_RESCHEDULE_WINDOW'
    };
  }
  if (endDate.getTime() <= startDate.getTime()) {
    return {
      ok: false,
      error: 'End must be after start',
      code: 'INVALID_RESCHEDULE_WINDOW'
    };
  }
  if (endDate.getTime() - startDate.getTime() !== 50 * 60 * 1000) {
    return {
      ok: false,
      error: 'Bookings must be exactly 50 minutes',
      code: 'INVALID_RESCHEDULE_WINDOW'
    };
  }

  var scope = String(input.updateScope || 'thisInstanceOnly').trim().toLowerCase();
  if (scope !== 'thisinstanceonly') {
    return {
      ok: false,
      error: 'Rescheduling requires updateScope thisInstanceOnly',
      code: 'INVALID_RESCHEDULE_SCOPE'
    };
  }

  return {
    ok: true,
    startDate: startDate,
    endDate: endDate,
    startIso: startDate.toISOString(),
    endIso: endDate.toISOString()
  };
}

function lessonBookSafeEventTime_(event, methodName) {
  try {
    if (!event || typeof event[methodName] !== 'function') return null;
    var value = event[methodName]();
    if (!value || typeof value.getTime !== 'function' || isNaN(value.getTime())) return null;
    return value;
  } catch (err) {
    return null;
  }
}

function lessonBookSafeEventId_(event) {
  try {
    if (!event || typeof event.getId !== 'function') return '';
    return String(event.getId() || '').trim();
  } catch (err) {
    return '';
  }
}

/**
 * True only when two CalendarApp event objects represent the same occurrence.
 * Recurring instances can share a series-like id, so identity is confirmed by
 * the original start/end as well as id instead of id alone.
 */
function lessonBookSameOccurrence_(left, right) {
  if (!left || !right) return false;
  if (left === right) return true;

  var leftId = lessonBookSafeEventId_(left);
  var rightId = lessonBookSafeEventId_(right);
  if (!leftId || !rightId || leftId !== rightId) return false;

  var leftStart = lessonBookSafeEventTime_(left, 'getStartTime');
  var rightStart = lessonBookSafeEventTime_(right, 'getStartTime');
  var leftEnd = lessonBookSafeEventTime_(left, 'getEndTime');
  var rightEnd = lessonBookSafeEventTime_(right, 'getEndTime');

  if (!leftStart || !rightStart || !leftEnd || !rightEnd) return false;
  return (
    leftStart.getTime() === rightStart.getTime() &&
    leftEnd.getTime() === rightEnd.getTime()
  );
}

function inspectLessonBookMoveDestination_(calendar, startDate, endDate, movingEvent) {
  var candidates = calendar.getEvents(startDate, endDate) || [];
  for (var i = 0; i < candidates.length; i++) {
    var candidate = candidates[i];
    if (lessonBookSameOccurrence_(candidate, movingEvent)) continue;
    if (calendarEventOverlaps_(candidate, startDate, endDate)) {
      return { conflict: candidate };
    }
  }
  return { conflict: null };
}

function lessonBookEventNeedsOccurrenceHint_(event) {
  try {
    return !!(event && event.isRecurringEvent && event.isRecurringEvent());
  } catch (err) {
    return false;
  }
}

/**
 * Move a resolved CalendarApp event while holding the same script lock used by
 * lesson creation. The destination is rechecked inside the lock immediately
 * before setTime().
 *
 * @return {{ok:boolean,moved?:boolean,start?:string,end?:string,error?:string,code?:string}}
 */
function applyLessonBookTimeUpdate_(calendarId, event, body) {
  var move = parseLessonBookMoveWindow_(body);
  if (move === null) return { ok: true, moved: false };
  if (!move.ok) return move;

  if (!calendarId || !event) {
    return {
      ok: false,
      error: 'Calendar event not found',
      code: 'RESCHEDULE_EVENT_NOT_FOUND'
    };
  }

  var occurrenceStartIso = String((body && body.occurrenceStartIso) || '').trim();
  if (lessonBookEventNeedsOccurrenceHint_(event) && !occurrenceStartIso) {
    return {
      ok: false,
      error: 'occurrenceStartIso is required to reschedule a recurring lesson',
      code: 'MISSING_OCCURRENCE_START'
    };
  }

  var calendar = openCalendarByConfiguredId_(calendarId);
  if (!calendar) {
    return {
      ok: false,
      error: 'Calendar not found: ' + calendarId,
      code: 'RESCHEDULE_CALENDAR_NOT_FOUND'
    };
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    return {
      ok: false,
      error: 'Booking system is busy. Please try again.',
      code: 'BOOKING_BUSY'
    };
  }

  try {
    var inspection = inspectLessonBookMoveDestination_(
      calendar,
      move.startDate,
      move.endDate,
      event
    );
    if (inspection.conflict) {
      return {
        ok: false,
        error: 'Slot unavailable',
        code: 'SLOT_UNAVAILABLE'
      };
    }

    try {
      event.setTime(move.startDate, move.endDate);
    } catch (setTimeErr) {
      return {
        ok: false,
        error: 'Calendar event time update failed: ' + String(
          setTimeErr && setTimeErr.message ? setTimeErr.message : setTimeErr
        ),
        code: 'RESCHEDULE_UPDATE_FAILED'
      };
    }

    return {
      ok: true,
      moved: true,
      start: move.startIso,
      end: move.endIso
    };
  } finally {
    lock.releaseLock();
  }
}
