/**
 * Green Square standalone schedule-sync / student-number API.
 *
 * The existing production calendarAPI is intentionally not used here.
 * Normal preview/read data comes from the Sheet mirror. Direct Calendar access is
 * reserved for background mirror synchronization and the exact tagging action.
 *
 * The only Calendar mutation exposed here is a description-only patch for:
 *   [GS_STUDENT_IDS:123,456]
 */

var STUDENT_NUMBER_TAG_API_REVISION = '2026-08-21-v3-mirror';
var GS_STUDENT_IDS_TAG_RE_ = /\[GS_STUDENT_IDS\s*:\s*([^\]]+)\]/gi;
var GS_INSTANCE_SUFFIX_RE_ = /_\d{8}T\d{6}Z$/i;
var GS_DB_SUFFIX_RE_ = /_\d{4}-\d{2}-\d{2}(?:_\d{2}-\d{2}-\d{2})?$/;
var GS_MATCH_TOLERANCE_MS_ = 6 * 60 * 1000;

function jsonOutput_(payload) {
  var out = payload || {};
  out.apiRevision = STUDENT_NUMBER_TAG_API_REVISION;
  return ContentService
    .createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function getStudentNumberTagApiKey_() {
  try {
    var props = PropertiesService.getScriptProperties();
    var dedicated = props.getProperty('STUDENT_NUMBER_TAG_API_KEY');
    if (dedicated && String(dedicated).trim()) return String(dedicated).trim();
    var bookingFallback = props.getProperty('BOOKING_API_KEY');
    if (bookingFallback && String(bookingFallback).trim()) return String(bookingFallback).trim();
  } catch (err) {}
  try {
    if (typeof STUDENT_NUMBER_TAG_API_KEY !== 'undefined' && STUDENT_NUMBER_TAG_API_KEY) {
      return String(STUDENT_NUMBER_TAG_API_KEY).trim();
    }
  } catch (ignore) {}
  return '';
}

function providedApiKey_(e, body) {
  var key = '';
  try {
    if (e && e.parameter && e.parameter.key) key = String(e.parameter.key).trim();
  } catch (ignore) {}
  if (!key && body && body.key) key = String(body.key).trim();
  return key;
}

function isAuthorized_(e, body) {
  var expected = getStudentNumberTagApiKey_();
  return !!expected && providedApiKey_(e, body) === expected;
}

function uniqueStrings_(values) {
  var out = [];
  var seen = {};
  var list = values || [];
  for (var i = 0; i < list.length; i++) {
    var value = String(list[i] == null ? '' : list[i]).trim();
    if (!value || seen[value]) continue;
    seen[value] = true;
    out.push(value);
  }
  return out;
}

function normalizeStudentIds_(body) {
  var raw = [];
  if (body && Array.isArray(body.studentIds)) raw = body.studentIds;
  else if (body && body.studentId != null && body.studentId !== '') raw = [body.studentId];

  var out = [];
  var seen = {};
  for (var i = 0; i < raw.length; i++) {
    var id = String(raw[i] == null ? '' : raw[i]).trim();
    if (!id) continue;
    if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('Invalid student ID: ' + id);
    if (!seen[id]) {
      seen[id] = true;
      out.push(id);
    }
  }
  out.sort(function (a, b) {
    return a.localeCompare(b, undefined, { numeric: true });
  });
  return out;
}

function splitStudentIds_(value) {
  return uniqueStrings_(
    String(value || '')
      .split(',')
      .map(function (id) { return String(id).trim(); })
      .filter(Boolean)
  );
}

/** Transitional parser: canonical tag + legacy StudentId/StudentIds lines. */
function parseStudentIdsFromDescription_(description) {
  var text = String(description || '');
  var ids = [];
  var match;

  GS_STUDENT_IDS_TAG_RE_.lastIndex = 0;
  while ((match = GS_STUDENT_IDS_TAG_RE_.exec(text)) !== null) {
    ids = ids.concat(splitStudentIds_(match[1]));
  }

  var legacyMany = /^\s*StudentIds\s*:\s*(.+)$/gim;
  while ((match = legacyMany.exec(text)) !== null) {
    ids = ids.concat(splitStudentIds_(match[1]));
  }

  var legacyOne = /^\s*StudentId\s*:\s*([^\s,]+)\s*$/gim;
  while ((match = legacyOne.exec(text)) !== null) {
    ids.push(String(match[1]).trim());
  }

  return uniqueStrings_(ids).sort(function (a, b) {
    return a.localeCompare(b, undefined, { numeric: true });
  });
}

function sameStringSet_(left, right) {
  var a = uniqueStrings_(left).sort();
  var b = uniqueStrings_(right).sort();
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function canonicalStudentTag_(studentIds) {
  return '[GS_STUDENT_IDS:' + studentIds.join(',') + ']';
}

function hasExactCanonicalStudentTag_(description, studentIds) {
  return String(description || '').indexOf(canonicalStudentTag_(studentIds)) !== -1;
}

/** Replace only the canonical GS tag. Preserve all other description content. */
function upsertCanonicalStudentTag_(description, studentIds) {
  var text = String(description || '');
  GS_STUDENT_IDS_TAG_RE_.lastIndex = 0;
  var without = text.replace(GS_STUDENT_IDS_TAG_RE_, '').replace(/[ \t]+\n/g, '\n');
  without = without.replace(/\n{3,}/g, '\n\n').trim();
  var tag = canonicalStudentTag_(studentIds);
  return without ? without + '\n\n' + tag : tag;
}

function stripGoogleUidSuffix_(id) {
  return String(id || '').trim().replace(/@google\.com$/i, '');
}

function stripDbDisambiguationSuffix_(id) {
  return String(id || '').trim().replace(GS_DB_SUFFIX_RE_, '');
}

function normalizeMasterId_(id) {
  return stripGoogleUidSuffix_(stripDbDisambiguationSuffix_(id)).replace(GS_INSTANCE_SUFFIX_RE_, '');
}

function calendarIdsForKind_(kind) {
  var normalized = String(kind || '').trim().toLowerCase();
  var preferred = normalized === 'demo'
    ? DEMO_CALENDAR_ID
    : normalized === 'owner'
      ? OWNER_CALENDAR_ID
      : CALENDAR_ID;
  return uniqueStrings_([preferred, CALENDAR_ID, DEMO_CALENDAR_ID, OWNER_CALENDAR_ID]);
}

function candidateEventIds_(body) {
  var raw = [
    body && body.eventId,
    body && body.calendarSourceEventId,
    body && body.seriesMasterId,
    body && body.rawMonthlyEventId
  ];
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var value = String(raw[i] || '').trim();
    if (!value) continue;
    out.push(value);
    out.push(stripGoogleUidSuffix_(value));
    out.push(stripDbDisambiguationSuffix_(value));
    out.push(stripGoogleUidSuffix_(stripDbDisambiguationSuffix_(value)));
  }
  return uniqueStrings_(out);
}

function eventStartMs_(event) {
  if (!event || !event.start) return null;
  var value = event.start.dateTime || (event.start.date ? String(event.start.date) + 'T00:00:00+09:00' : '');
  if (!value) return null;
  var d = new Date(value);
  return isNaN(d.getTime()) ? null : d.getTime();
}

function eventIdentityMatches_(event, candidates) {
  if (!event) return false;
  var tokens = {};
  var list = candidates || [];
  for (var i = 0; i < list.length; i++) {
    var token = String(list[i] || '').trim();
    if (!token) continue;
    tokens[token] = true;
    tokens[stripGoogleUidSuffix_(token)] = true;
    tokens[normalizeMasterId_(token)] = true;
  }

  var ids = [event.id, event.iCalUID, event.recurringEventId];
  for (var j = 0; j < ids.length; j++) {
    var id = String(ids[j] || '').trim();
    if (!id) continue;
    if (tokens[id] || tokens[stripGoogleUidSuffix_(id)] || tokens[normalizeMasterId_(id)]) return true;
  }
  return false;
}

function listOccurrenceNear_(calendarId, body, candidates) {
  var occurrenceIso = String((body && body.occurrenceStartIso) || '').trim();
  if (!occurrenceIso) return null;
  var target = new Date(occurrenceIso);
  if (isNaN(target.getTime())) return null;

  var windowMs = 12 * 60 * 60 * 1000;
  var result = Calendar.Events.list(calendarId, {
    timeMin: new Date(target.getTime() - windowMs).toISOString(),
    timeMax: new Date(target.getTime() + windowMs).toISOString(),
    singleEvents: true,
    showDeleted: false,
    maxResults: 2500,
    timeZone: 'Asia/Tokyo'
  });

  var items = result.items || [];
  var best = null;
  var bestDiff = Infinity;
  for (var i = 0; i < items.length; i++) {
    var event = items[i];
    if (!eventIdentityMatches_(event, candidates)) continue;
    var startMs = eventStartMs_(event);
    if (startMs == null) continue;
    var diff = Math.abs(startMs - target.getTime());
    if (diff < bestDiff) {
      bestDiff = diff;
      best = event;
    }
  }

  if (!best || bestDiff > GS_MATCH_TOLERANCE_MS_) return null;
  return best;
}

function tryGetEvent_(calendarId, eventId) {
  if (!calendarId || !eventId) return null;
  try {
    return Calendar.Events.get(calendarId, eventId);
  } catch (err) {
    return null;
  }
}

/** Resolve one exact existing event/occurrence for the tagging action. */
function resolveTagTarget_(body) {
  var candidates = candidateEventIds_(body);
  if (!candidates.length) return { ok: false, code: 'MISSING_EVENT_ID', error: 'Missing event identifier' };

  var calendars = calendarIdsForKind_(body && (body.lessonKind || body.kind));
  for (var ci = 0; ci < calendars.length; ci++) {
    var calendarId = calendars[ci];

    for (var ei = 0; ei < candidates.length; ei++) {
      var event = tryGetEvent_(calendarId, candidates[ei]);
      if (!event) continue;

      if (event.recurrence && event.recurrence.length) {
        var occurrence = listOccurrenceNear_(calendarId, body, candidates.concat([event.id, event.iCalUID]));
        if (!occurrence) {
          return {
            ok: false,
            code: 'AMBIGUOUS_RECURRING_EVENT',
            error: 'Recurring series found but exact occurrence could not be resolved'
          };
        }
        return { ok: true, calendarId: calendarId, event: occurrence };
      }

      return { ok: true, calendarId: calendarId, event: event };
    }

    var nearby = listOccurrenceNear_(calendarId, body, candidates);
    if (nearby) return { ok: true, calendarId: calendarId, event: nearby };
  }

  return { ok: false, code: 'EVENT_NOT_FOUND', error: 'Calendar event not found' };
}

function verifyExactPatchedEvent_(calendarId, eventId, requestedIds) {
  var exact;
  try {
    exact = Calendar.Events.get(calendarId, eventId);
  } catch (verifyErr) {
    return {
      ok: false,
      code: 'EXACT_VERIFY_READ_FAILED',
      error: 'Could not re-read the exact Calendar event after patch: ' + String(verifyErr && verifyErr.message ? verifyErr.message : verifyErr),
      eventId: String(eventId || '')
    };
  }

  var description = String((exact && exact.description) || '');
  var observedIds = parseStudentIdsFromDescription_(description);
  var canonicalPresent = hasExactCanonicalStudentTag_(description, requestedIds);
  var idsMatch = sameStringSet_(observedIds, requestedIds);

  if (!canonicalPresent || !idsMatch) {
    return {
      ok: false,
      code: 'EXACT_DESCRIPTION_VERIFY_FAILED',
      error: 'Exact Calendar event did not contain the requested canonical student tag after patch',
      eventId: String((exact && exact.id) || eventId || ''),
      requestedStudentIds: requestedIds,
      observedStudentIds: observedIds,
      canonicalPresent: canonicalPresent
    };
  }

  return {
    ok: true,
    eventId: String((exact && exact.id) || eventId || ''),
    description: description,
    studentIds: observedIds,
    exactEvent: exact
  };
}

function persistVerifiedTagToMirror_(calendarId, body, verifyResult) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return upsertVerifiedEventIntoCalendarMirror_(
      calendarId,
      String((body && (body.lessonKind || body.kind)) || 'regular').toLowerCase(),
      verifyResult.exactEvent
    );
  } finally {
    lock.releaseLock();
  }
}

function mirrorFailureResult_(calendarAction, eventId, requestedIds, verifyResult, err) {
  return {
    ok: false,
    code: 'MIRROR_WRITE_FAILED',
    error: 'Calendar tag was verified, but the Sheet mirror could not be updated: ' + String(err && err.message ? err.message : err),
    calendarActionTaken: calendarAction,
    calendarVerified: true,
    calendarTagged: calendarAction === 'tagged',
    mirrorUpdated: false,
    eventId: eventId,
    studentIds: requestedIds,
    description: verifyResult && verifyResult.description ? verifyResult.description : ''
  };
}

function updateStudentNumberTag_(body) {
  var requestedIds;
  try {
    requestedIds = normalizeStudentIds_(body);
  } catch (err) {
    return { ok: false, code: 'INVALID_STUDENT_IDS', error: String(err.message || err) };
  }
  if (!requestedIds.length) {
    return { ok: false, code: 'MISSING_STUDENT_IDS', error: 'studentIds is required' };
  }

  // Fail before Calendar mutation if the new mirror is not configured/writable.
  try {
    setupCalendarMirrorSpreadsheet();
  } catch (mirrorPrepErr) {
    return {
      ok: false,
      code: 'MIRROR_NOT_READY',
      error: 'Calendar mirror is not ready: ' + String(mirrorPrepErr && mirrorPrepErr.message ? mirrorPrepErr.message : mirrorPrepErr)
    };
  }

  var resolved = resolveTagTarget_(body);
  if (!resolved.ok) return resolved;

  var event = resolved.event || {};
  var exactEventId = String(event.id || '');
  if (!exactEventId) {
    return { ok: false, code: 'MISSING_RESOLVED_EVENT_ID', error: 'Resolved Calendar event has no event ID' };
  }

  var description = String(event.description || '');
  var existingIds = parseStudentIdsFromDescription_(description);

  if (existingIds.length && !sameStringSet_(existingIds, requestedIds)) {
    return {
      ok: false,
      code: 'STUDENT_ID_MISMATCH',
      error: 'Existing Calendar student IDs do not match requested IDs',
      eventId: exactEventId,
      existingStudentIds: existingIds,
      requestedStudentIds: requestedIds
    };
  }

  var nextDescription = upsertCanonicalStudentTag_(description, requestedIds);
  if (nextDescription === description) {
    var alreadyVerify = verifyExactPatchedEvent_(resolved.calendarId, exactEventId, requestedIds);
    if (!alreadyVerify.ok) return alreadyVerify;

    var alreadyMirror;
    try {
      alreadyMirror = persistVerifiedTagToMirror_(resolved.calendarId, body, alreadyVerify);
    } catch (mirrorErr) {
      return mirrorFailureResult_('already_tagged', exactEventId, requestedIds, alreadyVerify, mirrorErr);
    }

    return {
      ok: true,
      verified: true,
      mirrorUpdated: true,
      mirror: alreadyMirror,
      action: 'student_number_tag_update',
      actionTaken: 'already_tagged',
      eventId: exactEventId,
      studentIds: requestedIds,
      description: alreadyVerify.description
    };
  }

  var patched;
  try {
    patched = Calendar.Events.patch(
      { description: nextDescription },
      resolved.calendarId,
      exactEventId
    );
  } catch (patchErr) {
    return {
      ok: false,
      code: 'DESCRIPTION_PATCH_FAILED',
      error: 'Calendar description patch failed: ' + String(patchErr && patchErr.message ? patchErr.message : patchErr),
      eventId: exactEventId
    };
  }

  var patchedId = String((patched && patched.id) || exactEventId);
  if (patchedId !== exactEventId) {
    return {
      ok: false,
      code: 'PATCH_EVENT_ID_CHANGED',
      error: 'Calendar patch returned a different event ID; refusing to report success',
      eventId: exactEventId,
      patchedEventId: patchedId
    };
  }

  var verify = verifyExactPatchedEvent_(resolved.calendarId, exactEventId, requestedIds);
  if (!verify.ok) return verify;

  var mirrorResult;
  try {
    mirrorResult = persistVerifiedTagToMirror_(resolved.calendarId, body, verify);
  } catch (mirrorWriteErr) {
    return mirrorFailureResult_('tagged', exactEventId, requestedIds, verify, mirrorWriteErr);
  }

  return {
    ok: true,
    verified: true,
    mirrorUpdated: true,
    mirror: mirrorResult,
    action: 'student_number_tag_update',
    actionTaken: 'tagged',
    eventId: exactEventId,
    studentIds: requestedIds,
    description: verify.description
  };
}

function doGet(e) {
  var params = (e && e.parameter) || {};
  if (!isAuthorized_(e, params)) return jsonOutput_({ ok: false, error: 'Unauthorized' });
  return jsonOutput_({
    ok: true,
    mode: 'schedule-sync-and-student-tags',
    readActions: ['calendar_mirror_read_month'],
    syncActions: ['calendar_mirror_sync_month'],
    writeActions: ['student_number_tag_update'],
    directCalendarPreview: false,
    mutationScope: 'calendar-event-description-only',
    exactPostWriteVerification: true,
    mirrorRequiredForTagSuccess: true
  });
}

function doPost(e) {
  try {
    var raw = e && e.postData && e.postData.contents ? String(e.postData.contents) : '';
    var body = raw ? JSON.parse(raw) : {};

    if (!isAuthorized_(e, body)) {
      return jsonOutput_({ ok: false, error: 'Unauthorized' });
    }

    var action = String(body.action || '').trim().toLowerCase();

    if (action === 'calendar_mirror_read_month') {
      return jsonOutput_(readCalendarMirrorMonth(body.month));
    }
    if (action === 'calendar_mirror_sync_month') {
      return jsonOutput_(syncMonthToCalendarMirror(body.month));
    }
    if (action === 'student_number_tag_preview') {
      return jsonOutput_({
        ok: false,
        code: 'DIRECT_CALENDAR_PREVIEW_DISABLED',
        error: 'Direct Calendar preview is disabled. Read the Sheet mirror instead.'
      });
    }
    if (action === 'student_number_tag_update') {
      return jsonOutput_(updateStudentNumberTag_(body));
    }

    return jsonOutput_({
      ok: false,
      code: 'UNSUPPORTED_ACTION',
      error: 'Supported actions: calendar_mirror_read_month, calendar_mirror_sync_month, student_number_tag_update.'
    });
  } catch (err) {
    return jsonOutput_({
      ok: false,
      code: 'REQUEST_ERROR',
      error: String(err && err.message ? err.message : err)
    });
  }
}
