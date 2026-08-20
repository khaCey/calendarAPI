/**
 * One-time authorization helper for the standalone Student Number Tag API.
 *
 * Run this manually from the Apps Script editor after clasp push / scope changes.
 * It performs a READ-ONLY Calendar.Events.list call so Google can prompt the
 * script owner to approve the manifest's calendar.events OAuth scope.
 *
 * This function never creates, updates, patches, moves, or deletes an event.
 */
function authorizeStudentNumberTagApi() {
  var calendarId = String(CALENDAR_ID || '').trim();
  if (!calendarId) throw new Error('CALENDAR_ID is not configured');

  var now = new Date();
  var result = Calendar.Events.list(calendarId, {
    timeMin: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    timeMax: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    singleEvents: true,
    showDeleted: false,
    maxResults: 1,
    timeZone: 'Asia/Tokyo'
  });

  Logger.log('Student Number Tag API Calendar authorization OK. Read-only test returned %s event(s).', (result.items || []).length);
  return {
    ok: true,
    readOnlyTest: true,
    eventCount: (result.items || []).length
  };
}
