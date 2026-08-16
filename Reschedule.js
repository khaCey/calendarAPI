/**
 * Shared validation helpers for lesson rescheduling.
 *
 * IMPORTANT:
 * This file intentionally does NOT wrap doPost and does NOT call event.setTime().
 * The LINE reschedule route lives in LineBookingBridge.js and uses the same
 * Calendar identity resolver as the existing Student Admin lesson_book_update
 * path: eventId + occurrenceStartIso + seriesMasterId + thisInstanceOnly.
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
