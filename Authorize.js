/**
 * One-time authorization helper for the standalone Student Number Tag API.
 *
 * Run this manually from the Apps Script editor after clasp push / scope changes.
 * It explicitly requires the calendar.events OAuth scope before doing a
 * harmless read-only check. If that scope has not been granted, Apps Script
 * stops here and shows the authorization flow.
 *
 * This function never creates, updates, patches, moves, or deletes an event.
 */
function authorizeStudentNumberTagApi() {
  var requiredScope = 'https://www.googleapis.com/auth/calendar.events';

  // Important: a normal read can succeed with an older/partial grant.
  // Explicitly require the write-capable scope used by Calendar.Events.patch.
  ScriptApp.requireScopes(ScriptApp.AuthMode.FULL, [requiredScope]);

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

  Logger.log(
    'Student Number Tag API authorization OK. Required scope granted: %s. Read-only verification returned %s event(s).',
    requiredScope,
    (result.items || []).length
  );

  return {
    ok: true,
    requiredScope: requiredScope,
    eventCount: (result.items || []).length
  };
}

/**
 * Use only if Google keeps an old partial authorization grant.
 * Run this once, then run authorizeStudentNumberTagApi() again and approve
 * the Calendar permission when prompted.
 *
 * This does not alter Calendar data. It only invalidates this script user's
 * existing Apps Script authorization token.
 */
function resetStudentNumberTagAuthorization() {
  ScriptApp.invalidateAuth();
  Logger.log('Authorization invalidated. Now run authorizeStudentNumberTagApi() and approve the requested Calendar permission.');
  return { ok: true, authorizationInvalidated: true };
}
