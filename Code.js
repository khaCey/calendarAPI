/**
 * Private Google Calendar booking API — Apps Script entry point.
 * Deploy this code in a separate Apps Script project owned by the Google account
 * whose private primary calendar should hold the sandbox bookings.
 */

/** Echoed on every `lesson_book_*` response so you can confirm the **deployed** Web App matches this source (Deploy → Manage deployments → New version). */
var BOOKING_SCRIPT_REVISION = '2026-08-16-private-calendar-v1';

/** @param {GoogleAppsScript.Events.DoPost} e @param {string=} extra */
function logWebhookReceived(e, extra) {
  try {
    var details = extra || (e && e.postData ? String(e.postData.contents).slice(0, 200) : '') || '';
    Logger.log('POST received: ' + details);
  } catch (_) {}
}

function getBookingApiKey_() {
  try {
    var fromProps = PropertiesService.getScriptProperties().getProperty('BOOKING_API_KEY');
    if (fromProps) return String(fromProps).trim();
  } catch (err) {}
  return String(typeof BOOKING_API_KEY !== 'undefined' ? BOOKING_API_KEY : '').trim();
}

function jsonOutput_(payload) {
  return ContentService
    .createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/** @param {Object} payload */
function withBookingRevision_(payload) {
  var o = payload || {};
  o.scriptRevision = BOOKING_SCRIPT_REVISION;
  return o;
}

/**
 * Normalize Calendar API dateTime to UTC ISO string so the backend always gets an unambiguous instant.
 * Fixes wrong-date issues when the API returns local or timezone-ambiguous strings.
 * @param {string|Date} val - start.dateTime or end.dateTime from Calendar API
 * @return {string|null} ISO string in UTC (e.g. "2026-03-16T01:00:00.000Z") or null
 */
function toUtcIso_(val) {
  if (val == null) return null;
  var d = (typeof val === 'string') ? new Date(val) : val;
  if (typeof d.getTime !== 'function' || isNaN(d.getTime())) return null;
  return d.toISOString();
}

function parsePrivateAvailabilityWindow_(params) {
  var input = params || {};
  var timeMin = String(input.timeMin || '').trim();
  var timeMax = String(input.timeMax || '').trim();
  var date = String(input.date || '').trim();

  if ((!timeMin || !timeMax) && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    var dayStart = new Date(date + 'T00:00:00+09:00');
    if (isNaN(dayStart.getTime())) throw new Error('Invalid date');
    var dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
    timeMin = dayStart.toISOString();
    timeMax = dayEnd.toISOString();
  }

  if (!timeMin || !timeMax) {
    throw new Error('Provide date=YYYY-MM-DD or both timeMin and timeMax');
  }

  var start = new Date(timeMin);
  var end = new Date(timeMax);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    throw new Error('Invalid availability window');
  }
  var durationMs = end.getTime() - start.getTime();
  if (durationMs <= 0) throw new Error('timeMax must be after timeMin');
  if (durationMs > 31 * 24 * 60 * 60 * 1000) {
    throw new Error('Availability window cannot exceed 31 days');
  }

  return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}

function calendarApiBoundaryToIso_(boundary) {
  if (!boundary) return null;
  if (boundary.dateTime) return toUtcIso_(boundary.dateTime);
  if (boundary.date) return toUtcIso_(String(boundary.date) + 'T00:00:00+09:00');
  return null;
}

function mergeBusyWindows_(windows) {
  var sorted = (windows || []).slice().sort(function (a, b) {
    return new Date(a.start).getTime() - new Date(b.start).getTime();
  });
  var merged = [];
  for (var i = 0; i < sorted.length; i++) {
    var next = sorted[i];
    if (!merged.length) {
      merged.push({ start: next.start, end: next.end });
      continue;
    }
    var current = merged[merged.length - 1];
    if (new Date(next.start).getTime() <= new Date(current.end).getTime()) {
      if (new Date(next.end).getTime() > new Date(current.end).getTime()) current.end = next.end;
    } else {
      merged.push({ start: next.start, end: next.end });
    }
  }
  return merged;
}

/** Return busy intervals only. Event titles, descriptions, attendees and IDs stay private. */
function getPrivateCalendarBusyWindows_(window) {
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

function calendarEventOverlaps_(event, requestedStart, requestedEnd) {
  if (!event || !requestedStart || !requestedEnd) return false;
  try {
    var eventStart = event.getStartTime();
    var eventEnd = event.getEndTime();
    return eventStart.getTime() < requestedEnd.getTime() && eventEnd.getTime() > requestedStart.getTime();
  } catch (err) {
    return false;
  }
}

function inspectBookingWindow_(calendar, startDate, endDate, syncMarker) {
  var result = { existing: null, conflict: null };
  var candidates = calendar.getEvents(startDate, endDate) || [];
  for (var i = 0; i < candidates.length; i++) {
    var event = candidates[i];
    var description = '';
    try { description = String(event.getDescription() || ''); } catch (descErr) {}
    if (syncMarker && description.indexOf(syncMarker) !== -1) {
      result.existing = event;
      return result;
    }
    if (!result.conflict && calendarEventOverlaps_(event, startDate, endDate)) {
      result.conflict = event;
    }
  }
  return result;
}

/**
 * Sets the lesson event color when the server sends body.colorId (Basil = "10" for regular).
 * If colorId is omitted: demo and owner keep the calendar default (no setColor). Regular falls back to "10".
 * Uses Calendar API v3 patch first (reliable on group/shared calendars); falls back to CalendarApp.setColor.
 * @param {string} calId
 * @param {GoogleAppsScript.Calendar.CalendarEvent} event
 * @param {string} colorIdFromBody - optional; from server JSON body.colorId
 * @param {string} lessonKindLower - "demo" | "owner" | "regular" | ...
 */
function applyLessonBookEventColor_(calId, event, colorIdFromBody, lessonKindLower) {
  var kind = String(lessonKindLower || '').trim().toLowerCase();
  var cid = String(colorIdFromBody || '').trim();
  if (!cid) {
    if (kind === 'demo' || kind === 'owner') {
      return;
    }
    cid = '10';
  }
  if (!event || !calId) return;
  var evId = '';
  try {
    evId = event.getId();
  } catch (idErr) {
    return;
  }
  try {
    Calendar.Events.patch({ colorId: cid }, calId, evId);
  } catch (patchErr) {
    try {
      event.setColor(cid);
    } catch (setErr) {
      try {
        logWebhookReceived(
          { postData: { contents: '{}' } },
          'applyLessonBookEventColor_ colorId=' + cid + ' patch:' + String(patchErr) + ' set:' + String(setErr)
        );
      } catch (logE) {}
    }
  }
}

/**
 * Clears custom event color (calendar default). Uses API patch; avoids setColor('1'), which is Lavender in the event palette.
 */
function clearLessonBookEventColor_(calId, event) {
  if (!calId || !event) return;
  var evId = '';
  try {
    evId = event.getId();
  } catch (idErr) {
    return;
  }
  try {
    Calendar.Events.patch({ colorId: null }, calId, evId);
  } catch (patchNullErr) {
    try {
      Calendar.Events.patch({ colorId: '' }, calId, evId);
    } catch (patchEmptyErr) {
      try {
        logWebhookReceived(
          { postData: { contents: '{}' } },
          'clearLessonBookEventColor_ patchNull:' + String(patchNullErr) + ' patchEmpty:' + String(patchEmptyErr)
        );
      } catch (logE) {}
    }
  }
}

/** Same marker as server/lib/studentAdminCalendarDescription.js (poll / DB sync). */
var STUDENT_ADMIN_DESC_BLOCK_ = '---student-admin---';

function stripStudentAdminDescriptionBlock_(desc) {
  var s = String(desc || '');
  var idx = s.indexOf(STUDENT_ADMIN_DESC_BLOCK_);
  if (idx < 0) return s;
  return s.substring(0, idx).replace(/\s+$/, '');
}

/**
 * Merge Student Admin metadata into event description (preserves text above the block).
 * @param {string} existingDesc
 * @param {{ awaiting_reschedule_date?: boolean }} merge
 * @returns {string}
 */
function mergeStudentAdminDescriptionIntoEvent_(existingDesc, merge) {
  if (!merge || typeof merge !== 'object') return String(existingDesc || '');
  var ar = merge.awaiting_reschedule_date;
  if (ar !== true && ar !== false) return String(existingDesc || '');
  var base = stripStudentAdminDescriptionBlock_(existingDesc).trim();
  var tail = STUDENT_ADMIN_DESC_BLOCK_ + '\nawaiting_reschedule_date=' + (ar ? '1' : '0');
  if (!base) return tail;
  return base + '\n\n' + tail;
}

/** GET handler — returns only health or sanitised private-calendar availability. */
function doGet() {
  try {
    var e = arguments[0] || {};
    var params = e.parameter || {};
    var action = String(params.action || '').trim().toLowerCase();
    var providedKey = String(params.key || '').trim();
    var expectedKey = getBookingApiKey_();

    if (!expectedKey || providedKey !== expectedKey) {
      return jsonOutput_(withBookingRevision_({ ok: false, error: 'Unauthorized' }));
    }

    if (action === 'health') {
      return jsonOutput_(withBookingRevision_({
        ok: true,
        mode: 'private-calendar',
        timeZone: getPrivateCalendarTimeZone_()
      }));
    }

    if (action === 'availability') {
      var window = parsePrivateAvailabilityWindow_(params);
      return jsonOutput_(withBookingRevision_({
        ok: true,
        timeZone: getPrivateCalendarTimeZone_(),
        window: window,
        busy: getPrivateCalendarBusyWindows_(window)
      }));
    }

    return jsonOutput_(withBookingRevision_({
      ok: false,
      error: 'Unsupported action. Use action=health or action=availability.'
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
 * Pick the recurring instance whose start is closest to occurrenceStartIso (within 3 minutes).
 * @param {GoogleAppsScript.Calendar.CalendarEvent} masterEv
 * @param {string} occurrenceStartIso
 * @return {GoogleAppsScript.Calendar.CalendarEvent|null}
 */
function pickBestRecurringInstance_(masterEv, occurrenceStartIso) {
  var target = new Date(occurrenceStartIso);
  if (isNaN(target.getTime()) || !masterEv) return null;
  var winStart = new Date(target.getTime() - 12 * 60 * 60 * 1000);
  var winEnd = new Date(target.getTime() + 12 * 60 * 60 * 1000);
  var instances;
  try {
    instances = masterEv.getInstances(winStart, winEnd);
  } catch (e) {
    return null;
  }
  if (!instances || instances.length === 0) return null;
  var best = null;
  var bestDiff = Infinity;
  for (var i = 0; i < instances.length; i++) {
    var st;
    try {
      st = instances[i].getStartTime();
    } catch (e2) {
      continue;
    }
    var d = Math.abs(st.getTime() - target.getTime());
    if (d < bestDiff) {
      bestDiff = d;
      best = instances[i];
    }
  }
  if (best && bestDiff <= 3 * 60 * 1000) return best;
  return null;
}

/**
 * Strip Google recurring instance suffix so we can compare to Calendar API recurringEventId (series master).
 * @param {string} id
 * @return {string}
 */
function normalizeRecurringMasterIdForApi_(id) {
  var s = normalizeCalendarComparableId_(id);
  if (!s) return '';
  // Google instance suffix: …_YYYYMMDDTHHMMSSZ
  s = s.replace(/_\d{8}T\d{6}Z$/i, '');
  // Recurrence-id / "this and following" style: …_RYYYYMMDDTHHMMSS (optional Z)
  s = s.replace(/_R\d{8}T\d{6}Z?$/i, '');
  return s;
}

/**
 * Calendar ids can appear as API id or iCalUID-like "...@google.com".
 * Keep both normalized forms in exclude checks so we never remove freshly created lessons.
 * @param {string} id
 * @return {string}
 */
function normalizeCalendarComparableId_(id) {
  var s = String(id || '').trim();
  if (!s) return '';
  return s.replace(/@google\.com$/i, '');
}

/**
 * Candidate Calendar API event ids to try with Events.remove (deduped).
 * @param {Object} body
 * @return {string[]}
 */
function lessonBookBuildExcludeSet_(body) {
  var set = {};
  var raw = body.excludeEventIds;
  if (!raw || typeof raw.length !== 'number') return set;
  for (var i = 0; i < raw.length; i++) {
    var s = String(raw[i] || '').trim();
    if (!s) continue;
    set[s] = true;
    var cmp = normalizeCalendarComparableId_(s);
    if (cmp) set[cmp] = true;
    var base = normalizeRecurringMasterIdForApi_(s);
    if (base) set[base] = true;
    var baseCmp = normalizeCalendarComparableId_(base);
    if (baseCmp) set[baseCmp] = true;
  }
  return set;
}

function lessonBookIsExcludedId_(id, excludeSet) {
  if (!id || !excludeSet) return false;
  var s = String(id).trim();
  if (excludeSet[s]) return true;
  var cmp = normalizeCalendarComparableId_(s);
  if (cmp && excludeSet[cmp]) return true;
  var base = normalizeRecurringMasterIdForApi_(s);
  if (base && excludeSet[base]) return true;
  var baseCmp = normalizeCalendarComparableId_(base);
  return !!(baseCmp && excludeSet[baseCmp]);
}

/** Max start-time delta when matching a single occurrence (ms). */
var LESSON_BOOK_OCCURRENCE_MATCH_TOLERANCE_MS = 6 * 60 * 1000;

/**
 * Build comparable id tokens from the delete payload for safe occurrence matching.
 * Includes eventId, rawMonthlyEventId, calendarSourceEventId, seriesMasterId and normalized forms.
 * @param {Object} body
 * @return {Object.<string, boolean>}
 */
function lessonBookCollectOccurrenceMatchTokens_(body) {
  var tokens = {};
  function add(id) {
    var s = String(id || '').trim();
    if (!s) return;
    tokens[s] = true;
    var cmp = normalizeCalendarComparableId_(s);
    if (cmp) tokens[cmp] = true;
    var base = normalizeRecurringMasterIdForApi_(s);
    if (base) tokens[base] = true;
    var baseCmp = normalizeCalendarComparableId_(base);
    if (baseCmp) tokens[baseCmp] = true;
  }
  add(body.eventId);
  add(body.rawMonthlyEventId);
  add(body.calendarSourceEventId);
  add(body.seriesMasterId);
  return tokens;
}

/**
 * True when a Calendar API event matches any payload identifier token.
 * Matching may use recurringEventId / iCalUID for identity; callers must still remove only ev.id.
 * @param {Object} ev
 * @param {Object.<string, boolean>} tokens
 * @return {boolean}
 */
function lessonBookEventMatchesOccurrenceTokens_(ev, tokens) {
  if (!ev || !tokens) return false;
  function hit(id) {
    var s = String(id || '').trim();
    if (!s) return false;
    if (tokens[s]) return true;
    var cmp = normalizeCalendarComparableId_(s);
    if (cmp && tokens[cmp]) return true;
    var base = normalizeRecurringMasterIdForApi_(s);
    if (base && tokens[base]) return true;
    var baseCmp = normalizeCalendarComparableId_(base);
    return !!(baseCmp && tokens[baseCmp]);
  }
  return hit(ev.id) || hit(ev.iCalUID) || hit(ev.recurringEventId);
}

/**
 * Parse start instant from a Calendar API event resource.
 * @param {Object} ev
 * @return {Date|null}
 */
function lessonBookEventStartDate_(ev) {
  if (!ev || !ev.start) return null;
  var st = null;
  if (ev.start.dateTime) st = new Date(ev.start.dateTime);
  else if (ev.start.date) st = new Date(String(ev.start.date) + 'T12:00:00');
  if (!st || isNaN(st.getTime())) return null;
  return st;
}

/** Google Calendar recurring instance ids end with _YYYYMMDDTHHMMSSZ */
var LESSON_BOOK_INSTANCE_SUFFIX_RE = /_\d{8}T\d{6}Z$/i;

/**
 * @param {string} id
 * @return {boolean}
 */
function lessonBookIdHasInstanceSuffix_(id) {
  return LESSON_BOOK_INSTANCE_SUFFIX_RE.test(String(id || '').trim());
}

/**
 * Build Google instance id from series master + occurrence instant.
 * @param {string} masterId
 * @param {string} occurrenceStartIso
 * @return {string}
 */
function lessonBookBuildInstanceId_(masterId, occurrenceStartIso) {
  var master = normalizeRecurringMasterIdForApi_(normalizeCalendarComparableId_(masterId));
  var t = new Date(occurrenceStartIso);
  if (!master || isNaN(t.getTime())) return '';
  var y = t.getUTCFullYear();
  var mo = String(t.getUTCMonth() + 1);
  if (mo.length < 2) mo = '0' + mo;
  var day = String(t.getUTCDate());
  if (day.length < 2) day = '0' + day;
  var h = String(t.getUTCHours());
  if (h.length < 2) h = '0' + h;
  var mi = String(t.getUTCMinutes());
  if (mi.length < 2) mi = '0' + mi;
  var s = String(t.getUTCSeconds());
  if (s.length < 2) s = '0' + s;
  return master + '_' + y + mo + day + 'T' + h + mi + s + 'Z';
}

/**
 * True if this id is unsafe to Events.remove for a single-occurrence delete.
 * Recurring events must use an instance-suffixed id; bare masters / iCalUIDs of series are refused.
 * Non-recurring events (no recurringEventId) may use their normal Calendar event id.
 * @param {string} id
 * @param {string=} recurringEventId
 * @return {boolean}
 */
function lessonBookIsUnsafeSeriesRemoveId_(id, recurringEventId) {
  var sid = String(id || '').trim();
  if (!sid) return true;
  var rid = String(recurringEventId || '').trim();
  if (!rid) {
    // Non-recurring: still refuse deleting via a Google instance-looking master confusion — allow normal ids.
    return false;
  }
  if (sid === rid) return true;
  var idNorm = normalizeRecurringMasterIdForApi_(normalizeCalendarComparableId_(sid));
  var ridNorm = normalizeRecurringMasterIdForApi_(normalizeCalendarComparableId_(rid));
  if (idNorm === ridNorm && !lessonBookIdHasInstanceSuffix_(sid)) return true;
  if (!lessonBookIdHasInstanceSuffix_(sid)) return true;
  if (sid.indexOf('@') >= 0 && !lessonBookIdHasInstanceSuffix_(sid)) return true;
  return false;
}

/**
 * Pick the single expanded occurrence from Events.list items nearest to occurrenceStartIso.
 * Returns only a safe unique instance id (never recurringEventId / series master / bare iCalUID).
 * @param {Object[]} items
 * @param {Object} body
 * @param {Object.<string, boolean>=} excludeSet
 * @return {{ id: string, recurringEventId: string, startIso: string, diffMs: number }|null}
 */
function lessonBookPickOccurrenceFromListItems_(items, body, excludeSet) {
  var occIso = String(body.occurrenceStartIso || '').trim();
  if (!occIso) return null;
  var target = new Date(occIso);
  if (isNaN(target.getTime())) return null;

  var tokens = lessonBookCollectOccurrenceMatchTokens_(body);
  if (!Object.keys(tokens).length) return null;

  var seriesMasterHint = normalizeRecurringMasterIdForApi_(
    normalizeCalendarComparableId_(
      String(body.seriesMasterId || body.calendarSourceEventId || body.eventId || '').trim()
    )
  );
  var eventIdHint = String(body.eventId || '').trim();
  var preferExactInstance = lessonBookIdHasInstanceSuffix_(eventIdHint);

  var best = null;
  var bestDiff = Infinity;
  var list = items || [];

  function considerListItem_(ev, requireExact) {
    if (!ev || !ev.id) return;
    if (ev.recurrence && ev.recurrence.length) return;
    if (lessonBookIsExcludedId_(ev.id, excludeSet)) return;
    if (requireExact) {
      if (String(ev.id) !== eventIdHint) return;
    } else if (!lessonBookEventMatchesOccurrenceTokens_(ev, tokens)) {
      return;
    }
    var st = lessonBookEventStartDate_(ev);
    if (!st) return;
    var d = Math.abs(st.getTime() - target.getTime());
    if (d < bestDiff) {
      bestDiff = d;
      best = ev;
    }
  }

  // Prefer exact instance id when the payload already has one, then fall back to token match
  // (synthesized suffixes often disagree with Google's real instance id / timezone stamp).
  if (preferExactInstance) {
    for (var ix = 0; ix < list.length; ix++) considerListItem_(list[ix], true);
  }
  if (!best || bestDiff > LESSON_BOOK_OCCURRENCE_MATCH_TOLERANCE_MS) {
    best = null;
    bestDiff = Infinity;
    for (var iy = 0; iy < list.length; iy++) considerListItem_(list[iy], false);
  }

  if (!best || bestDiff > LESSON_BOOK_OCCURRENCE_MATCH_TOLERANCE_MS) return null;

  var rid = String(best.recurringEventId || '').trim();
  var removeId = String(best.id);
  // Recurring: never remove with master/iCalUID — require or synthesize instance-suffixed id.
  if (rid && lessonBookIsUnsafeSeriesRemoveId_(removeId, rid)) {
    var built = lessonBookBuildInstanceId_(rid || seriesMasterHint, occIso);
    if (!built || lessonBookIsUnsafeSeriesRemoveId_(built, rid)) return null;
    removeId = built;
  }

  return {
    id: removeId,
    recurringEventId: rid,
    startIso: best.start && best.start.dateTime ? String(best.start.dateTime) : occIso,
    diffMs: bestDiff,
  };
}

/**
 * Resolve one Calendar API instance via Events.list(singleEvents:true) around occurrenceStartIso.
 * @param {string} calId
 * @param {Object} body
 * @return {{ id: string, recurringEventId: string, startIso: string, diffMs: number }|null}
 */
function tryFindInstanceOnCalendarForDelete_(calId, body) {
  var occIso = String(body.occurrenceStartIso || '').trim();
  if (!calId || !occIso) return null;
  var t = new Date(occIso);
  if (isNaN(t.getTime())) return null;

  var winMs = 3 * 60 * 60 * 1000;
  var timeMin = new Date(t.getTime() - winMs).toISOString();
  var timeMax = new Date(t.getTime() + winMs).toISOString();
  var resp;
  try {
    resp = Calendar.Events.list(calId, {
      timeMin: timeMin,
      timeMax: timeMax,
      singleEvents: true,
      maxResults: 100,
    });
  } catch (ex) {
    return null;
  }

  return lessonBookPickOccurrenceFromListItems_(
    resp && resp.items ? resp.items : [],
    body,
    lessonBookBuildExcludeSet_(body)
  );
}

/** @deprecated Use tryFindInstanceOnCalendarForDelete_; kept as id-only wrapper. */
function tryFindInstanceIdOnCalendarForDelete_(calId, body) {
  var picked = tryFindInstanceOnCalendarForDelete_(calId, body);
  return picked ? picked.id : null;
}

/**
 * Delete exactly one selected occurrence. Never removes series masters / recurringEventId / iCalUID.
 * Requires a resolvable occurrenceStartIso + matching identifier; otherwise deletes nothing.
 * @param {Object} body
 * @param {string[]} cals
 * @return {{ ok: boolean, calendarId: string|null, eventId: string, deletedCount: number, error?: string }}
 */
/**
 * CalendarApp fallback: delete one occurrence via getEvents + deleteEvent.
 * On a recurring instance returned by getEvents, deleteEvent removes only that occurrence.
 * @param {string} calId
 * @param {Object} body
 * @return {{ id: string, recurringEventId: string, startIso: string, diffMs: number }|null}
 */
function tryDeleteOccurrenceViaCalendarApp_(calId, body) {
  var occIso = String(body.occurrenceStartIso || '').trim();
  if (!calId || !occIso) return null;
  var t = new Date(occIso);
  if (isNaN(t.getTime())) return null;
  if (typeof CalendarApp === 'undefined') return null;

  var cal;
  try {
    cal = openCalendarByConfiguredId_(calId);
  } catch (e0) {
    return null;
  }
  if (!cal) return null;

  var winStart = new Date(t.getTime() - 30 * 60 * 1000);
  var winEnd = new Date(t.getTime() + 90 * 60 * 1000);
  var events;
  try {
    events = cal.getEvents(winStart, winEnd);
  } catch (e1) {
    return null;
  }

  var tokens = lessonBookCollectOccurrenceMatchTokens_(body);
  if (!Object.keys(tokens).length) return null;
  var excludeSet = lessonBookBuildExcludeSet_(body);

  var best = null;
  var bestDiff = Infinity;
  for (var i = 0; i < (events || []).length; i++) {
    var ev = events[i];
    var id = '';
    var seriesId = '';
    try {
      id = String(ev.getId() || '');
    } catch (e2) {
      continue;
    }
    if (!id || lessonBookIsExcludedId_(id, excludeSet)) continue;
    try {
      if (ev.isRecurringEvent && ev.isRecurringEvent()) {
        seriesId = String(ev.getEventSeries().getId() || '');
      }
    } catch (e3) {}
    var fake = { id: id, iCalUID: id, recurringEventId: seriesId };
    if (!lessonBookEventMatchesOccurrenceTokens_(fake, tokens)) continue;
    var st;
    try {
      st = ev.getStartTime();
    } catch (e4) {
      continue;
    }
    if (!st || isNaN(st.getTime())) continue;
    var d = Math.abs(st.getTime() - t.getTime());
    if (d < bestDiff) {
      bestDiff = d;
      best = ev;
    }
  }

  if (!best || bestDiff > LESSON_BOOK_OCCURRENCE_MATCH_TOLERANCE_MS) return null;

  try {
    // Instance from getEvents: deletes only this occurrence (not the series).
    best.deleteEvent();
    var deletedId = '';
    try {
      deletedId = String(best.getId() || '');
    } catch (e5) {
      deletedId = 'calendarapp-instance';
    }
    return {
      id: deletedId || 'calendarapp-instance',
      recurringEventId: 'calendarapp',
      startIso: occIso,
      diffMs: bestDiff,
      viaCalendarApp: true,
    };
  } catch (e6) {
    return null;
  }
}

function lessonBookExecuteDelete_(body, cals) {
  var occDel = String(body.occurrenceStartIso || '').trim();
  if (!occDel) {
    return { ok: false, calendarId: null, eventId: '', deletedCount: 0, error: 'Missing occurrenceStartIso for delete' };
  }
  var target = new Date(occDel);
  if (isNaN(target.getTime())) {
    return { ok: false, calendarId: null, eventId: '', deletedCount: 0, error: 'Invalid occurrenceStartIso for delete' };
  }

  var tokens = lessonBookCollectOccurrenceMatchTokens_(body);
  if (!Object.keys(tokens).length) {
    return { ok: false, calendarId: null, eventId: '', deletedCount: 0, error: 'Missing event identifiers for delete' };
  }

  var excludeSet = lessonBookBuildExcludeSet_(body);

  for (var lix = 0; lix < (cals || []).length; lix++) {
    var calId = cals[lix];
    var picked = tryFindInstanceOnCalendarForDelete_(calId, body);
    if (!picked || !picked.id) {
      // Advanced Calendar list miss → CalendarApp instance delete (still one occurrence only).
      var appDel = tryDeleteOccurrenceViaCalendarApp_(calId, body);
      if (appDel && appDel.id) {
        return {
          ok: true,
          calendarId: calId,
          eventId: appDel.id,
          deletedCount: 1,
          actionTaken: 'deleted',
        };
      }
      continue;
    }
    if (lessonBookIsExcludedId_(picked.id, excludeSet)) continue;

    var instanceId = String(picked.id);
    if (lessonBookIsUnsafeSeriesRemoveId_(instanceId, picked.recurringEventId)) {
      return {
        ok: false,
        calendarId: null,
        eventId: '',
        deletedCount: 0,
        error: 'Refusing to delete series master / non-instance id from lesson_book_delete',
      };
    }

    try {
      // Safe instance-suffixed id only: Events.remove deletes that occurrence (not the series).
      // Prefer remove over status=cancelled so the slot disappears in Calendar UI.
      Calendar.Events.remove(calId, instanceId);
      return {
        ok: true,
        calendarId: calId,
        eventId: instanceId,
        deletedCount: 1,
        actionTaken: picked.recurringEventId ? 'cancelled_instance' : 'deleted',
      };
    } catch (rmErr) {
      if (lessonBookCalendarRemoveNotFound_(rmErr)) {
        return {
          ok: true,
          calendarId: calId,
          eventId: instanceId,
          deletedCount: 1,
          actionTaken: 'already_deleted',
        };
      }
      // Last resort for recurring: cancel instance, then CalendarApp.
      if (picked.recurringEventId) {
        try {
          Calendar.Events.patch({ status: 'cancelled' }, calId, instanceId);
          return {
            ok: true,
            calendarId: calId,
            eventId: instanceId,
            deletedCount: 1,
            actionTaken: 'cancelled_instance',
          };
        } catch (patchErr) {
          var appDel2 = tryDeleteOccurrenceViaCalendarApp_(calId, body);
          if (appDel2 && appDel2.id) {
            return {
              ok: true,
              calendarId: calId,
              eventId: appDel2.id,
              deletedCount: 1,
              actionTaken: 'deleted',
            };
          }
          return {
            ok: false,
            calendarId: null,
            eventId: '',
            deletedCount: 0,
            error:
              'Calendar API remove failed: ' +
              String(rmErr && rmErr.message ? rmErr.message : rmErr) +
              '; patch: ' +
              String(patchErr && patchErr.message ? patchErr.message : patchErr),
          };
        }
      }
      return {
        ok: false,
        calendarId: null,
        eventId: '',
        deletedCount: 0,
        error: 'Calendar API remove failed: ' + String(rmErr && rmErr.message ? rmErr.message : rmErr),
      };
    }
  }

  return {
    ok: false,
    calendarId: null,
    eventId: '',
    deletedCount: 0,
    error: 'Calendar event occurrence not found',
  };
}

function lessonBookCalendarRemoveNotFound_(err) {
  var msg = String((err && err.message) || err || '').toLowerCase();
  return (
    msg.indexOf('not found') >= 0 ||
    msg.indexOf('404') >= 0 ||
    msg.indexOf('deleted') >= 0 ||
    msg.indexOf('no longer exists') >= 0
  );
}

/**
 * Calendar API v3 delete by event id. Does not call Events.get first — get often 404s for valid ids on
 * shared calendars while remove works. Prefer tryFindInstanceIdOnCalendarForDelete_ to target one instance when possible.
 * @param {string} calId
 * @param {string} evId
 * @param {Object} body
 * @return {string} error message or '' on success
 */
function lessonBookDeleteOneEventViaApiById_(calId, evId, body) {
  if (!calId || !evId) return 'Missing calendar or event id';
  try {
    Calendar.Events.remove(calId, evId);
    return '';
  } catch (removeErr) {
    return 'Calendar API remove failed: ' + String(removeErr.message || removeErr);
  }
}

/**
 * Delete via Calendar API v3 (same stack as Events.patch in this project). CalendarApp.deleteEvent()
 * on shared calendars / recurring instances has been unreliable and can remove the entire series.
 * thisInstanceOnly: resolveLessonBookCalendarEvent_ picks one instance when occurrenceStartIso is provided.
 * @param {string} calId
 * @param {GoogleAppsScript.Calendar.CalendarEvent} ev
 * @param {Object} body
 * @return {string} error message or '' on success
 */
function lessonBookDeleteOneEventViaApi_(calId, ev, body) {
  if (!calId || !ev) return 'Missing calendar or event';
  var evId = '';
  try {
    evId = String(ev.getId ? ev.getId() : '');
  } catch (e1) {
    return 'Could not read event id';
  }
  if (!evId) return 'Empty event id';
  return lessonBookDeleteOneEventViaApiById_(calId, evId, body);
}

/**
 * For lesson_book_update / lesson_book_delete: resolve CalendarEvent, including one occurrence of a recurring series.
 * Uses body.eventId first; when updateScope is thisInstanceOnly and the event is the series master, uses
 * occurrenceStartIso (+ optional seriesMasterId) with getInstances().
 *
 * @param {GoogleAppsScript.Calendar.Calendar} cal
 * @param {Object} body - POST JSON (eventId, seriesMasterId, occurrenceStartIso, updateScope)
 * @return {GoogleAppsScript.Calendar.CalendarEvent|null}
 */
function resolveLessonBookCalendarEvent_(cal, body) {
  var eventIdRaw = String(body.eventId || '').trim();
  var seriesMasterId = String(body.seriesMasterId || '').trim();
  var occurrenceStartIso = String(body.occurrenceStartIso || '').trim();
  var updateScope = String(body.updateScope || 'thisInstanceOnly').trim().toLowerCase();
  var thisInstanceOnly = updateScope === 'thisinstanceonly';

  var ev = null;
  if (eventIdRaw) {
    try {
      ev = cal.getEventById(eventIdRaw);
    } catch (ignore) {}
  }

  if (ev && thisInstanceOnly && occurrenceStartIso) {
    try {
      var idStr = '';
      try {
        idStr = String(ev.getId ? ev.getId() : '');
      } catch (e1) {}
      var isInstanceId = idStr && /_\d{8}T\d{6}Z$/i.test(idStr);
      var isRecurring = false;
      try {
        isRecurring = ev.isRecurringEvent && ev.isRecurringEvent();
      } catch (e2) {}
      if (isRecurring && !isInstanceId) {
        var picked = pickBestRecurringInstance_(ev, occurrenceStartIso);
        if (picked) ev = picked;
      }
    } catch (recErr) {}
  }

  if (!ev && thisInstanceOnly && seriesMasterId && occurrenceStartIso) {
    try {
      var master = cal.getEventById(seriesMasterId);
      if (master) {
        var isRec2 = false;
        try {
          isRec2 = master.isRecurringEvent && master.isRecurringEvent();
        } catch (e3) {}
        if (isRec2) {
          ev = pickBestRecurringInstance_(master, occurrenceStartIso);
        } else {
          ev = master;
        }
      }
    } catch (ignore2) {}
  }

  return ev;
}

/**
 * Webhook handler — receives Calendar API push notifications.
 * Apps Script does not expose request headers, so we run sync on every POST.
 * Google POSTs when events change; we refresh lessons_today and return 200.
 */
function doPost(e) {
  logWebhookReceived(e);

  // Student sync / booking path (server -> GAS). Keep webhook path unchanged when body/action is absent.
  try {
    var raw = (e && e.postData && e.postData.contents) ? String(e.postData.contents) : '';
    var body = {};
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch (jsonErr) {
        body = {};
      }
    }
    if (body && (body.action === 'health' || body.action === 'availability')) {
      var providedReadKey = '';
      if (e && e.parameter && e.parameter.key) providedReadKey = String(e.parameter.key).trim();
      if (!providedReadKey && body.key) providedReadKey = String(body.key).trim();
      var expectedReadKey = getBookingApiKey_();
      if (!expectedReadKey || providedReadKey !== expectedReadKey) {
        return jsonOutput_(withBookingRevision_({ ok: false, error: 'Unauthorized' }));
      }
      if (body.action === 'health') {
        return jsonOutput_(withBookingRevision_({
          ok: true,
          mode: 'private-calendar',
          timeZone: getPrivateCalendarTimeZone_()
        }));
      }
      var readWindow = parsePrivateAvailabilityWindow_(body);
      return jsonOutput_(withBookingRevision_({
        ok: true,
        timeZone: getPrivateCalendarTimeZone_(),
        window: readWindow,
        busy: getPrivateCalendarBusyWindows_(readWindow)
      }));
    }
    if (body && body.action === 'lesson_book_create') {
      var providedKey = '';
      if (e && e.parameter && e.parameter.key) providedKey = String(e.parameter.key).trim();
      if (!providedKey && body.key) providedKey = String(body.key).trim();
      var expectedKey = getBookingApiKey_();
      if (!expectedKey || providedKey !== expectedKey) {
        logWebhookReceived(e, 'lesson_book_create unauthorized');
        return jsonOutput_({ ok: false, error: 'Unauthorized' });
      }

      var kind = String(body.lessonKind || body.kind || '').trim().toLowerCase();
      var calId = getCalendarIdForKind_(kind);
      if (!calId) return jsonOutput_({ ok: false, error: 'Calendar ID is not configured for kind: ' + kind });

      var summary = String(body.title || '').trim();
      if (!summary) return jsonOutput_({ ok: false, error: 'Missing title' });
      var startIso = String(body.start || '').trim();
      var endIso = String(body.end || '').trim();
      if (!startIso || !endIso) return jsonOutput_({ ok: false, error: 'Missing start/end' });
      var startDate = new Date(startIso);
      var endDate = new Date(endIso);
      if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
        return jsonOutput_({ ok: false, error: 'Invalid start/end datetime' });
      }
      if (endDate.getTime() <= startDate.getTime()) {
        return jsonOutput_({ ok: false, error: 'End must be after start' });
      }
      if (endDate.getTime() - startDate.getTime() !== 50 * 60 * 1000) {
        return jsonOutput_({ ok: false, error: 'Bookings must be exactly 50 minutes' });
      }

      var description = String(body.description || '').trim();
      var location = String(body.location || '').trim();
      var bookingKey = String(body.bookingKey || '').trim();
      if (!bookingKey) return jsonOutput_({ ok: false, error: 'Missing bookingKey' });
      var cal = openCalendarByConfiguredId_(calId);
      if (!cal) return jsonOutput_({ ok: false, error: 'Calendar not found: ' + calId });
      var syncMarker = bookingKey ? 'BookingSyncKey: ' + bookingKey : '';
      if (syncMarker && description.indexOf(syncMarker) === -1) {
        description = description ? (description + '\n' + syncMarker) : syncMarker;
      }
      var lock = LockService.getScriptLock();
      if (!lock.tryLock(10000)) {
        return jsonOutput_(withBookingRevision_({
          ok: false,
          error: 'Booking system is busy. Please try again.',
          code: 'BOOKING_BUSY'
        }));
      }

      var existing = null;
      var event = null;
      try {
        var inspection = inspectBookingWindow_(cal, startDate, endDate, syncMarker);
        existing = inspection.existing;
        if (!existing && inspection.conflict) {
          return jsonOutput_(withBookingRevision_({
            ok: false,
            error: 'Slot unavailable',
            code: 'SLOT_UNAVAILABLE'
          }));
        }

        event = existing;
        if (event) {
          try { event.setTitle(summary); } catch (setTitleErr) {}
          try { event.setDescription(description || ''); } catch (setDescErr) {}
          try { event.setLocation(location || ''); } catch (setLocErr) {}
        } else {
          event = cal.createEvent(summary, startDate, endDate, {
            description: description || '',
            location: location || '',
          });
        }
      } finally {
        lock.releaseLock();
      }

      applyLessonBookEventColor_(calId, event, body.colorId, kind);

      return jsonOutput_(withBookingRevision_({
        ok: true,
        actionTaken: existing ? 'existing' : 'created',
        calendarId: calId,
        eventId: event.getId ? event.getId() : null,
      }));
    }
    if (body && body.action === 'lesson_book_delete') {
      var providedDelKey = '';
      if (e && e.parameter && e.parameter.key) providedDelKey = String(e.parameter.key).trim();
      if (!providedDelKey && body.key) providedDelKey = String(body.key).trim();
      var expectedDelKey = getBookingApiKey_();
      if (!expectedDelKey || providedDelKey !== expectedDelKey) {
        logWebhookReceived(e, 'lesson_book_delete unauthorized');
        return jsonOutput_(withBookingRevision_({ ok: false, error: 'Unauthorized' }));
      }

      var eventIdRaw = String(body.eventId || '').trim();
      if (!eventIdRaw) return jsonOutput_(withBookingRevision_({ ok: false, error: 'Missing eventId' }));
      var updateScopeDel = String(body.updateScope || '').trim().toLowerCase();
      if (updateScopeDel !== 'thisinstanceonly') {
        return jsonOutput_(
          withBookingRevision_({
            ok: false,
            error:
              'lesson_book_delete requires updateScope thisInstanceOnly; use lesson_book_delete_series for whole-series deletion',
          })
        );
      }
      var occDel = String(body.occurrenceStartIso || '').trim();
      var kindDel = String(body.lessonKind || body.kind || '').trim().toLowerCase();
      var cals = getConfiguredCalendarIdsForSearch_(kindDel);

      if (!occDel) {
        return jsonOutput_(withBookingRevision_({ ok: false, error: 'Missing occurrenceStartIso for delete' }));
      }

      var delResult = lessonBookExecuteDelete_(body, cals);
      if (!delResult.ok) {
        logWebhookReceived(e, 'lesson_book_delete: ' + String(delResult.error || 'no events removed') + ' for ' + eventIdRaw);
        return jsonOutput_(
          withBookingRevision_({
            ok: false,
            error: delResult.error || 'Calendar event not found',
            eventId: eventIdRaw,
          })
        );
      }

      return jsonOutput_(
        withBookingRevision_({
          ok: true,
          actionTaken: 'deleted',
          calendarId: delResult.calendarId,
          eventId: delResult.eventId,
          deletedCount: delResult.deletedCount,
        })
      );
    }
    if (body && body.action === 'lesson_book_update') {
      var providedUpdKey = '';
      if (e && e.parameter && e.parameter.key) providedUpdKey = String(e.parameter.key).trim();
      if (!providedUpdKey && body.key) providedUpdKey = String(body.key).trim();
      var expectedUpdKey = getBookingApiKey_();
      if (!expectedUpdKey || providedUpdKey !== expectedUpdKey) {
        logWebhookReceived(e, 'lesson_book_update unauthorized');
        return jsonOutput_({ ok: false, error: 'Unauthorized' });
      }

      var eventIdUpd = String(body.eventId || '').trim();
      if (!eventIdUpd) return jsonOutput_({ ok: false, error: 'Missing eventId' });
      var foundUpd = null;
      var foundUpdCalId = null;
      var updateKind = String(body.lessonKind || body.kind || '').trim().toLowerCase();
      var calsUpd = getConfiguredCalendarIdsForSearch_(updateKind);
      for (var ui = 0; ui < calsUpd.length; ui++) {
        try {
          var calUpd = openCalendarByConfiguredId_(calsUpd[ui]);
          if (!calUpd) continue;
          var evUpd = resolveLessonBookCalendarEvent_(calUpd, body);
          if (evUpd) {
            foundUpd = evUpd;
            foundUpdCalId = calsUpd[ui];
            break;
          }
        } catch (ignoreUpdErr) {}
      }
      if (!foundUpd) {
        return jsonOutput_({ ok: false, error: 'Calendar event not found', eventId: eventIdUpd });
      }

      var resolvedId = eventIdUpd;
      try {
        resolvedId = foundUpd.getId ? String(foundUpd.getId()) : eventIdUpd;
      } catch (ridErr) {}

      var nextTitle = String(body.title || '').trim();
      if (nextTitle) {
        try { foundUpd.setTitle(nextTitle); } catch (titleErr) {}
      }
      if (body.clearColor === true || String(body.clearColor || '').toLowerCase() === 'true') {
        clearLessonBookEventColor_(foundUpdCalId, foundUpd);
      } else {
        var nextColorId = String(body.colorId || '').trim();
        if (nextColorId) {
          var updKind = String(body.lessonKind || body.kind || '').trim().toLowerCase();
          applyLessonBookEventColor_(foundUpdCalId, foundUpd, nextColorId, updKind);
        }
      }

      if (body.mergeStudentAdminDescription && typeof body.mergeStudentAdminDescription === 'object') {
        try {
          var existingDescUpd = '';
          try {
            existingDescUpd = String(foundUpd.getDescription() || '');
          } catch (gdUpd) {}
          var mergedDesc = mergeStudentAdminDescriptionIntoEvent_(existingDescUpd, body.mergeStudentAdminDescription);
          try {
            foundUpd.setDescription(mergedDesc);
          } catch (sdUpd) {}
        } catch (mergeUpdErr) {}
      }

      return jsonOutput_({
        ok: true,
        actionTaken: 'updated',
        calendarId: foundUpdCalId,
        eventId: resolvedId,
      });
    }
    if (body && body.action === 'lesson_book_delete_series') {
      var providedSeriesKey = '';
      if (e && e.parameter && e.parameter.key) providedSeriesKey = String(e.parameter.key).trim();
      if (!providedSeriesKey && body.key) providedSeriesKey = String(body.key).trim();
      var expectedSeriesKey = getBookingApiKey_();
      if (!expectedSeriesKey || providedSeriesKey !== expectedSeriesKey) {
        logWebhookReceived(e, 'lesson_book_delete_series unauthorized');
        return jsonOutput_(withBookingRevision_({ ok: false, error: 'Unauthorized' }));
      }

      var seriesMasterDel = String(body.seriesMasterId || '').trim();
      if (!seriesMasterDel) {
        return jsonOutput_(withBookingRevision_({ ok: false, error: 'Missing seriesMasterId' }));
      }
      var kindSeries = String(body.lessonKind || body.kind || '').trim().toLowerCase();
      var calIdSeries = getCalendarIdForKind_(kindSeries);
      if (!calIdSeries) {
        return jsonOutput_(withBookingRevision_({ ok: false, error: 'Calendar ID is not configured for kind: ' + kindSeries }));
      }

      var seriesCals = getConfiguredCalendarIdsForSearch_(kindSeries);
      var seriesRemovedOn = null;
      var seriesRmErr = null;
      for (var sc = 0; sc < seriesCals.length; sc++) {
        try {
          Calendar.Events.remove(seriesCals[sc], seriesMasterDel);
          seriesRemovedOn = seriesCals[sc];
          seriesRmErr = null;
          break;
        } catch (rmSeriesErr) {
          seriesRmErr = rmSeriesErr;
          if (lessonBookCalendarRemoveNotFound_(rmSeriesErr)) {
            seriesRemovedOn = 'already_gone';
            seriesRmErr = null;
            break;
          }
        }
      }
      if (!seriesRemovedOn) {
        logWebhookReceived(e, 'lesson_book_delete_series failed: ' + String(seriesRmErr));
        return jsonOutput_(
          withBookingRevision_({
            ok: false,
            error: 'Calendar API remove series failed: ' + String(seriesRmErr && seriesRmErr.message ? seriesRmErr.message : seriesRmErr),
          })
        );
      }

      return jsonOutput_(
        withBookingRevision_({
          ok: true,
          actionTaken: seriesRemovedOn === 'already_gone' ? 'already_deleted' : 'series_deleted',
          calendarId: seriesRemovedOn === 'already_gone' ? calIdSeries : seriesRemovedOn,
          eventId: seriesMasterDel,
        })
      );
    }
    if (body && body.action === 'reserved_hold_recurring_create') {
      var providedHoldKey = '';
      if (e && e.parameter && e.parameter.key) providedHoldKey = String(e.parameter.key).trim();
      if (!providedHoldKey && body.key) providedHoldKey = String(body.key).trim();
      var expectedHoldKey = getBookingApiKey_();
      if (!expectedHoldKey || providedHoldKey !== expectedHoldKey) {
        logWebhookReceived(e, 'reserved_hold_recurring_create unauthorized');
        return jsonOutput_(withBookingRevision_({ ok: false, error: 'Unauthorized' }));
      }

      var kindHold = String(body.lessonKind || body.kind || '').trim().toLowerCase();
      var calIdHold = getCalendarIdForKind_(kindHold);
      if (!calIdHold) {
        return jsonOutput_(withBookingRevision_({ ok: false, error: 'Calendar ID is not configured for kind: ' + kindHold }));
      }

      var summaryHold = String(body.title || '').trim();
      if (!summaryHold) return jsonOutput_(withBookingRevision_({ ok: false, error: 'Missing title' }));
      var startLocalHold = String(body.startLocal || '').trim();
      var endLocalHold = String(body.endLocal || '').trim();
      var tzHold = String(body.timeZone || 'Asia/Tokyo').trim();
      if (!startLocalHold || !endLocalHold) {
        return jsonOutput_(withBookingRevision_({ ok: false, error: 'Missing startLocal/endLocal' }));
      }

      var recurrenceHold = body.recurrence;
      if (!recurrenceHold || (typeof recurrenceHold.length === 'number' && recurrenceHold.length === 0)) {
        return jsonOutput_(withBookingRevision_({ ok: false, error: 'Missing recurrence' }));
      }

      var resourceHold = {
        summary: summaryHold,
        description: String(body.description || ''),
        start: { dateTime: startLocalHold, timeZone: tzHold },
        end: { dateTime: endLocalHold, timeZone: tzHold },
        recurrence: recurrenceHold,
      };
      var colorHold = String(body.colorId != null ? body.colorId : '5').trim();
      if (colorHold) resourceHold.colorId = colorHold;

      var createdHold;
      try {
        createdHold = Calendar.Events.insert(resourceHold, calIdHold);
      } catch (insErr) {
        logWebhookReceived(e, 'reserved_hold_recurring_create insert failed: ' + String(insErr));
        return jsonOutput_(
          withBookingRevision_({
            ok: false,
            error: 'Calendar API insert failed: ' + String(insErr.message || insErr),
          })
        );
      }

      var newHoldId = createdHold && createdHold.id ? String(createdHold.id) : '';
      return jsonOutput_(
        withBookingRevision_({
          ok: true,
          actionTaken: 'created',
          calendarId: calIdHold,
          eventId: newHoldId,
        })
      );
    }
    return jsonOutput_(withBookingRevision_({
      ok: false,
      error: 'Unsupported action'
    }));
  } catch (err) {
    logWebhookReceived(e, 'API route error: ' + String(err));
    return jsonOutput_(withBookingRevision_({
      ok: false,
      error: String(err && err.message ? err.message : err),
      code: 'INTERNAL_ERROR'
    }));
  }
}

/**
 * Run once in a new Apps Script project to grant calendar access and confirm
 * that "primary" resolves to the deploying account's private default calendar.
 */
function authorisePrivateCalendarOnce() {
  var configuredId = getMainCalendarId_();
  var calendar = openCalendarByConfiguredId_(configuredId);
  if (!calendar) throw new Error('Configured private calendar could not be opened');
  Logger.log(JSON.stringify({
    configuredId: configuredId,
    calendarId: calendar.getId(),
    calendarName: calendar.getName(),
    timeZone: calendar.getTimeZone(),
    isPrimary: calendar.isMyPrimaryCalendar()
  }));
}

function createBookingApiKeyOnce() {
  var props = PropertiesService.getScriptProperties();
  var existing = String(props.getProperty('BOOKING_API_KEY') || '').trim();
  if (existing) {
    Logger.log('BOOKING_API_KEY is already configured. It was not changed.');
    return null;
  }
  var key = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  props.setProperty('BOOKING_API_KEY', key);
  Logger.log('BOOKING_API_KEY=' + key);
  return key;
}
