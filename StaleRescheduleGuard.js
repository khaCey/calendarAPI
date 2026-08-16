/**
 * Reject replay/stale reschedule references.
 *
 * The Worker token contains the lesson start time that was current when the
 * lesson list was fetched. Before moving an event, require that the resolved
 * Calendar occurrence still starts at that instant. Once a lesson is moved,
 * its old token can no longer move it again.
 */

var lessonBookApplyTimeUpdateBeforeStaleGuard_ = applyLessonBookTimeUpdate_;

applyLessonBookTimeUpdate_ = function (calendarId, event, body) {
  var occurrenceStartIso = String((body && body.occurrenceStartIso) || '').trim();

  if (occurrenceStartIso) {
    var expectedStart = new Date(occurrenceStartIso);
    var currentStart = lessonBookSafeEventTime_(event, 'getStartTime');

    if (
      isNaN(expectedStart.getTime()) ||
      !currentStart ||
      Math.abs(currentStart.getTime() - expectedStart.getTime()) > 3 * 60 * 1000
    ) {
      return {
        ok: false,
        error: 'Lesson has changed since it was loaded. Refresh and try again.',
        code: 'STALE_LESSON_REFERENCE'
      };
    }
  }

  return lessonBookApplyTimeUpdateBeforeStaleGuard_(calendarId, event, body);
};
