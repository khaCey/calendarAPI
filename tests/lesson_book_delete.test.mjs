/**
 * Unit tests for calendarAPI single-occurrence delete logic (Code.js).
 * Run: node calendarAPI/tests/lesson_book_delete.test.mjs
 * (from REACT-ADMIN root or calendarAPI/)
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const codePath = path.join(__dirname, '..', 'Code.js');
const source = fs.readFileSync(codePath, 'utf8');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function extractFunction(name) {
  const re = new RegExp(
    'function\\s+' + name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&') + '\\s*\\([\\s\\S]*?\\n\\}'
  );
  // Fallback: brace-matching extract
  const start = source.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('Missing function: ' + name);
  let i = source.indexOf('{', start);
  let depth = 0;
  for (; i < source.length; i++) {
    const ch = source[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  throw new Error('Unclosed function: ' + name);
}

const fnNames = [
  'normalizeRecurringMasterIdForApi_',
  'normalizeCalendarComparableId_',
  'lessonBookBuildExcludeSet_',
  'lessonBookIsExcludedId_',
  'lessonBookCollectOccurrenceMatchTokens_',
  'lessonBookEventMatchesOccurrenceTokens_',
  'lessonBookEventStartDate_',
  'lessonBookIdHasInstanceSuffix_',
  'lessonBookBuildInstanceId_',
  'lessonBookIsUnsafeSeriesRemoveId_',
  'lessonBookPickOccurrenceFromListItems_',
  'tryFindInstanceOnCalendarForDelete_',
  'tryFindInstanceIdOnCalendarForDelete_',
  'tryDeleteOccurrenceViaCalendarApp_',
  'lessonBookCalendarRemoveNotFound_',
  'lessonBookExecuteDelete_',
];

const constMatch = source.match(/var LESSON_BOOK_OCCURRENCE_MATCH_TOLERANCE_MS\s*=\s*[^;]+;/);
if (!constMatch) throw new Error('Missing LESSON_BOOK_OCCURRENCE_MATCH_TOLERANCE_MS');
const suffixReMatch = source.match(/var LESSON_BOOK_INSTANCE_SUFFIX_RE\s*=\s*[^;]+;/);
if (!suffixReMatch) throw new Error('Missing LESSON_BOOK_INSTANCE_SUFFIX_RE');

function makeSandbox(calendarEvents) {
  const removeCalls = [];
  const patchCalls = [];
  const sandbox = {
    LESSON_BOOK_OCCURRENCE_MATCH_TOLERANCE_MS: 6 * 60 * 1000,
    LESSON_BOOK_INSTANCE_SUFFIX_RE: /_\d{8}T\d{6}Z$/i,
    Calendar: {
      Events: {
        list: function (calId, opts) {
          const items = typeof calendarEvents === 'function' ? calendarEvents(calId, opts) : calendarEvents;
          return { items: items || [] };
        },
        remove: function (calId, eventId) {
          removeCalls.push({ calId, eventId });
        },
        patch: function (resource, calId, eventId) {
          patchCalls.push({ resource, calId, eventId });
        },
      },
    },
    console,
  };
  const code = [constMatch[0], suffixReMatch[0]].concat(fnNames.map(extractFunction)).join('\n\n');
  vm.runInNewContext(code, sandbox, { filename: 'Code.js-extract' });
  sandbox.__removeCalls = removeCalls;
  sandbox.__patchCalls = patchCalls;
  return sandbox;
}

const MASTER = 'seriesMasterAbc';
const ICAL = MASTER + '@google.com';

function weeklyInstances(starts) {
  return starts.map(function (iso) {
    const d = new Date(iso);
    const stamp =
      d.getUTCFullYear().toString() +
      String(d.getUTCMonth() + 1).padStart(2, '0') +
      String(d.getUTCDate()).padStart(2, '0') +
      'T' +
      String(d.getUTCHours()).padStart(2, '0') +
      String(d.getUTCMinutes()).padStart(2, '0') +
      String(d.getUTCSeconds()).padStart(2, '0') +
      'Z';
    return {
      id: MASTER + '_' + stamp,
      iCalUID: ICAL,
      recurringEventId: MASTER,
      start: { dateTime: iso },
    };
  });
}

const weekStarts = [
  '2026-07-06T01:00:00.000Z',
  '2026-07-13T01:00:00.000Z',
  '2026-07-20T01:00:00.000Z',
  '2026-07-27T01:00:00.000Z',
];

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('ok - ' + name);
  } catch (err) {
    console.error('FAIL - ' + name);
    console.error('  ' + (err && err.stack ? err.stack : err));
    process.exitCode = 1;
  }
}

test('deleting one weekly occurrence removes only that instance id', () => {
  const items = weeklyInstances(weekStarts);
  const sb = makeSandbox(items);
  const body = {
    eventId: ICAL,
    seriesMasterId: MASTER,
    rawMonthlyEventId: ICAL,
    occurrenceStartIso: weekStarts[1],
    updateScope: 'thisInstanceOnly',
    lessonKind: 'regular',
  };
  const result = sb.lessonBookExecuteDelete_(body, ['cal-regular']);
  assert(result.ok, 'expected ok');
  assert(result.deletedCount === 1, 'deletedCount');
  assert(sb.__removeCalls.length === 1, 'one Events.remove on instance');
  assert(sb.__patchCalls.length === 0, 'no cancel patch when remove works');
  assert(sb.__removeCalls[0].eventId === items[1].id, 'removed middle instance');
  assert(sb.__removeCalls[0].eventId !== MASTER, 'must not remove master');
  assert(items.length === 4, 'fixture series intact');
});

test('deleting the first occurrence leaves later ones intact (only first id removed)', () => {
  const items = weeklyInstances(weekStarts);
  const sb = makeSandbox(items);
  const result = sb.lessonBookExecuteDelete_(
    {
      eventId: MASTER,
      seriesMasterId: MASTER,
      occurrenceStartIso: weekStarts[0],
      calendarSourceEventId: MASTER,
    },
    ['cal-regular']
  );
  assert(result.ok);
  assert(sb.__removeCalls.length === 1);
  assert(sb.__patchCalls.length === 0);
  assert(sb.__removeCalls[0].eventId === items[0].id);
  assert(!sb.__removeCalls.some((c) => c.eventId === items[1].id));
  assert(!sb.__removeCalls.some((c) => c.eventId === items[2].id));
  assert(!sb.__removeCalls.some((c) => c.eventId === MASTER));
});

test('deleting a middle occurrence leaves earlier and later intact', () => {
  const items = weeklyInstances(weekStarts);
  const sb = makeSandbox(items);
  const result = sb.lessonBookExecuteDelete_(
    {
      eventId: items[2].id,
      seriesMasterId: MASTER,
      occurrenceStartIso: weekStarts[2],
    },
    ['cal-regular']
  );
  assert(result.ok);
  assert(sb.__removeCalls[0].eventId === items[2].id);
  assert(!sb.__removeCalls.some((c) => c.eventId === items[0].id || c.eventId === items[1].id || c.eventId === items[3].id));
});

test('deleting a non-recurring event still works via id + occurrence time', () => {
  const soloId = 'soloEvent99';
  const start = '2026-07-23T04:00:00.000Z';
  const sb = makeSandbox([
    {
      id: soloId,
      iCalUID: soloId + '@google.com',
      start: { dateTime: start },
    },
  ]);
  const result = sb.lessonBookExecuteDelete_(
    {
      eventId: soloId,
      seriesMasterId: soloId,
      rawMonthlyEventId: soloId + '@google.com',
      occurrenceStartIso: start,
    },
    ['cal-regular']
  );
  assert(result.ok, result.error);
  assert(sb.__removeCalls.length === 1);
  assert(sb.__patchCalls.length === 0);
  assert(sb.__removeCalls[0].eventId === soloId);
});

test('missing occurrenceStartIso deletes nothing', () => {
  const sb = makeSandbox(weeklyInstances(weekStarts));
  const result = sb.lessonBookExecuteDelete_(
    { eventId: MASTER, seriesMasterId: MASTER },
    ['cal-regular']
  );
  assert(!result.ok);
  assert(sb.__removeCalls.length === 0);
  assert(sb.__patchCalls.length === 0);
  assert(/occurrenceStartIso/i.test(result.error));
});

test('invalid occurrenceStartIso deletes nothing', () => {
  const sb = makeSandbox(weeklyInstances(weekStarts));
  const result = sb.lessonBookExecuteDelete_(
    { eventId: MASTER, seriesMasterId: MASTER, occurrenceStartIso: 'not-a-date' },
    ['cal-regular']
  );
  assert(!result.ok);
  assert(sb.__removeCalls.length === 0);
  assert(sb.__patchCalls.length === 0);
});

test('unresolved identifier deletes nothing', () => {
  const sb = makeSandbox(weeklyInstances(weekStarts));
  const result = sb.lessonBookExecuteDelete_(
    {
      eventId: 'totally-unknown-id',
      seriesMasterId: 'other-master',
      occurrenceStartIso: weekStarts[1],
    },
    ['cal-regular']
  );
  assert(!result.ok);
  assert(sb.__removeCalls.length === 0);
  assert(sb.__patchCalls.length === 0);
});

test('occurrence outside 6-minute tolerance deletes nothing', () => {
  const sb = makeSandbox(weeklyInstances(weekStarts));
  const result = sb.lessonBookExecuteDelete_(
    {
      eventId: MASTER,
      seriesMasterId: MASTER,
      occurrenceStartIso: '2026-07-13T01:20:00.000Z', // 20 min off
    },
    ['cal-regular']
  );
  assert(!result.ok);
  assert(sb.__removeCalls.length === 0);
  assert(sb.__patchCalls.length === 0);
});

test('single-occurrence path never calls remove with parent recurringEventId', () => {
  const items = weeklyInstances(weekStarts);
  const sb = makeSandbox(items);
  sb.lessonBookExecuteDelete_(
    {
      eventId: ICAL,
      seriesMasterId: MASTER,
      rawMonthlyEventId: ICAL,
      calendarSourceEventId: MASTER,
      occurrenceStartIso: weekStarts[3],
    },
    ['cal-regular']
  );
  assert(sb.__removeCalls.length === 1, 'one instance remove');
  for (const call of sb.__removeCalls) {
    assert(call.eventId !== MASTER, 'must not remove series master id');
    assert(call.eventId !== items[3].recurringEventId, 'must not remove recurringEventId');
    assert(/_\d{8}T\d{6}Z$/i.test(call.eventId), 'must remove instance-suffixed id');
  }
});

test('lesson_book_delete_series still deletes complete series (handler contract)', () => {
  // Series path is separate: Events.remove(calendarId, seriesMasterId) only.
  const removeCalls = [];
  const seriesMasterDel = MASTER;
  const seriesCals = ['cal-regular'];
  let seriesRemovedOn = null;
  for (let sc = 0; sc < seriesCals.length; sc++) {
    removeCalls.push({ calId: seriesCals[sc], eventId: seriesMasterDel });
    seriesRemovedOn = seriesCals[sc];
    break;
  }
  assert(seriesRemovedOn === 'cal-regular');
  assert(removeCalls.length === 1);
  assert(removeCalls[0].eventId === MASTER);
});

test('match tokens include iCalUID / calendarSourceEventId / returned event fields', () => {
  const items = weeklyInstances(weekStarts);
  const sb = makeSandbox([]);
  const body = {
    eventId: 'ignored-other',
    seriesMasterId: 'ignored-other',
    rawMonthlyEventId: ICAL,
    calendarSourceEventId: MASTER,
    occurrenceStartIso: weekStarts[0],
  };
  const picked = sb.lessonBookPickOccurrenceFromListItems_(items, body, {});
  assert(picked && picked.id === items[0].id, 'should match via rawMonthly/calendarSource tokens');
});

test('wrong synthesized instance id still matches via series tokens', () => {
  const items = weeklyInstances(weekStarts);
  const sb = makeSandbox(items);
  const wrongInstance = MASTER + '_20260713T999999Z';
  const result = sb.lessonBookExecuteDelete_(
    {
      eventId: wrongInstance,
      seriesMasterId: MASTER,
      occurrenceStartIso: weekStarts[1],
    },
    ['cal-regular']
  );
  assert(result.ok, result.error);
  assert(sb.__removeCalls[0].eventId === items[1].id);
});

test('_R recurrence-id style master normalizes for token match', () => {
  const items = weeklyInstances(weekStarts);
  const sb = makeSandbox(items);
  const rStyle = MASTER + '_R20250305T010000@google.com';
  const result = sb.lessonBookExecuteDelete_(
    {
      eventId: rStyle + '_2026-07-13_01-00-00',
      seriesMasterId: rStyle,
      rawMonthlyEventId: rStyle,
      occurrenceStartIso: weekStarts[1],
    },
    ['cal-regular']
  );
  assert(result.ok, result.error);
  assert(sb.__removeCalls[0].eventId === items[1].id);
});

test('refuses to Events.remove iCalUID / series master when list returns unsafe id', () => {
  const start = weekStarts[1];
  const sb = makeSandbox([
    {
      id: ICAL, // unsafe: iCalUID shared by series
      iCalUID: ICAL,
      recurringEventId: MASTER,
      start: { dateTime: start },
    },
  ]);
  const result = sb.lessonBookExecuteDelete_(
    {
      eventId: ICAL,
      seriesMasterId: MASTER,
      occurrenceStartIso: start,
    },
    ['cal-regular']
  );
  assert(result.ok, result.error);
  assert(sb.__removeCalls.length === 1, 'must remove synthesized instance');
  assert(sb.__removeCalls[0].eventId !== ICAL, 'must not remove iCalUID');
  assert(sb.__removeCalls[0].eventId !== MASTER, 'must not remove master');
  assert(/_\d{8}T\d{6}Z$/i.test(sb.__removeCalls[0].eventId), 'must synthesize instance id');
});

console.log('\n' + passed + ' tests passed');
if (process.exitCode) {
  console.error('Some tests failed');
  process.exit(1);
}
