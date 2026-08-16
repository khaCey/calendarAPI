import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const properties = { BOOKING_API_KEY: 'worker-secret' };

let listItems = [];
let apiEvents = new Map();
let insertedResources = [];
let patchedCalls = [];
let removedCalls = [];
let lockReleaseCount = 0;
let calendarAppEvent = null;
let titleUpdates = [];

function formatTokyoDay(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    day: 'numeric',
  }).format(date);
}

const defaultCalendar = {
  getId: () => 'primary',
  getName: () => 'Private calendar',
  getTimeZone: () => 'Asia/Tokyo',
  isMyPrimaryCalendar: () => true,
  getEvents: () => [],
  getEventById: id => {
    if (!calendarAppEvent) return null;
    return String(calendarAppEvent.getId()) === String(id) ? calendarAppEvent : null;
  },
};

const context = vm.createContext({
  console,
  Date,
  JSON,
  Object,
  Array,
  String,
  Number,
  Boolean,
  Math,
  RegExp,
  Error,
  PropertiesService: {
    getScriptProperties: () => ({
      getProperty: key => properties[key] ?? null,
    }),
  },
  CalendarApp: {
    getDefaultCalendar: () => defaultCalendar,
    getCalendarById: () => defaultCalendar,
  },
  Session: {
    getScriptTimeZone: () => 'Asia/Tokyo',
  },
  Calendar: {
    Events: {
      list: () => ({ items: listItems }),
      get: (_calendarId, eventId) => {
        const event = apiEvents.get(String(eventId));
        if (!event) throw new Error('not found');
        return structuredClone(event);
      },
      insert: (resource, _calendarId) => {
        const created = {
          ...structuredClone(resource),
          id: `inserted-${insertedResources.length + 1}`,
          iCalUID: `inserted-${insertedResources.length + 1}@google.com`,
          status: 'confirmed',
        };
        insertedResources.push(created);
        apiEvents.set(created.id, created);
        return structuredClone(created);
      },
      patch: (resource, _calendarId, eventId) => {
        const id = String(eventId);
        const current = apiEvents.get(id);
        if (!current) throw new Error('not found');
        const updated = { ...current, ...structuredClone(resource) };
        apiEvents.set(id, updated);
        patchedCalls.push({ eventId: id, resource: structuredClone(resource) });
        return structuredClone(updated);
      },
      remove: (_calendarId, eventId) => {
        removedCalls.push(String(eventId));
        apiEvents.delete(String(eventId));
      },
    },
  },
  ContentService: {
    MimeType: { JSON: 'application/json', TEXT: 'text/plain' },
    createTextOutput: text => ({
      text,
      setMimeType() { return this; },
    }),
  },
  LockService: {
    getScriptLock: () => ({
      tryLock: () => true,
      releaseLock: () => { lockReleaseCount += 1; },
    }),
  },
  Logger: { log: () => {} },
  Utilities: {
    getUuid: () => '00000000-0000-4000-8000-000000000000',
    formatDate: (date, _tz, pattern) => {
      if (pattern === 'd') return formatTokyoDay(date);
      throw new Error(`Unsupported test format: ${pattern}`);
    },
  },
});

for (const file of [
  'Config.js',
  'PrivateCalendar.js',
  'Code.js',
  'Reschedule.js',
  'LineBookingBridge.js',
]) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
}

function post(body) {
  return context.doPost({
    parameter: {},
    postData: { contents: JSON.stringify(body) },
  });
}

function sourceApiEvent(overrides = {}) {
  return {
    id: 'calendar-instance-id',
    iCalUID: 'lesson-ical-id@google.com',
    recurringEventId: 'series-master-id',
    status: 'confirmed',
    summary: 'Keishi (Cafe) 2/4',
    description: 'existing description',
    location: 'Cafe',
    colorId: '10',
    start: { dateTime: '2026-08-20T10:00:00+09:00' },
    end: { dateTime: '2026-08-20T10:50:00+09:00' },
    ...overrides,
  };
}

// Sanitised list includes exact API instance id for Worker encryption, while
// private title/description/location still never leave GAS.
listItems = [sourceApiEvent({ summary: 'PRIVATE STUDENT NAME' })];
let response = post({
  action: 'lesson_book_list',
  key: 'worker-secret',
  date: '2026-08-20',
});
let payload = JSON.parse(response.text);
assert.equal(payload.ok, true);
assert.equal(payload.lessons.length, 1);
assert.deepEqual(JSON.parse(JSON.stringify(payload.lessons[0])), {
  eventId: 'lesson-ical-id@google.com',
  apiEventId: 'calendar-instance-id',
  seriesMasterId: 'series-master-id',
  occurrenceStartIso: '2026-08-20T01:00:00.000Z',
  start: '2026-08-20T01:00:00.000Z',
  end: '2026-08-20T01:50:00.000Z',
  durationMinutes: 50,
  status: 'scheduled',
  canReschedule: true,
  rescheduleDirection: null,
});
assert.equal(response.text.includes('PRIVATE STUDENT NAME'), false);
assert.equal(response.text.includes('existing description'), false);
assert.equal(response.text.includes('Cafe'), false);
console.log('ok - lesson list exposes only encrypted-token inputs and state');

// Non-50-minute Calendar records must still be visible. They are read-only.
listItems = [sourceApiEvent({
  id: 'sixty-minute-id',
  iCalUID: 'sixty-minute@google.com',
  end: { dateTime: '2026-08-20T11:00:00+09:00' },
})];
response = post({
  action: 'lesson_book_list',
  key: 'worker-secret',
  date: '2026-08-20',
});
payload = JSON.parse(response.text);
assert.equal(payload.ok, true);
assert.equal(payload.lessons.length, 1);
assert.equal(payload.lessons[0].durationMinutes, 60);
assert.equal(payload.lessons[0].canReschedule, false);
console.log('ok - non-50-minute Calendar record remains visible as read-only');

// Green Square-style reschedule: exact old API instance remains at the old
// start/end, gets Graphite + Moved-to, and a separate destination is inserted.
const source = sourceApiEvent();
apiEvents = new Map([[source.id, structuredClone(source)]]);
listItems = [];
insertedResources = [];
patchedCalls = [];
removedCalls = [];
lockReleaseCount = 0;
response = post({
  action: 'lesson_book_update',
  key: 'worker-secret',
  eventId: 'lesson-ical-id@google.com',
  apiEventId: 'calendar-instance-id',
  seriesMasterId: 'series-master-id',
  occurrenceStartIso: '2026-08-20T01:00:00.000Z',
  updateScope: 'thisInstanceOnly',
  start: '2026-08-22T15:00:00+09:00',
  end: '2026-08-22T15:50:00+09:00',
});
payload = JSON.parse(response.text);
assert.equal(payload.ok, true);
assert.equal(payload.actionTaken, 'rescheduled');
assert.equal(insertedResources.length, 1);
assert.equal(insertedResources[0].summary, 'Keishi (Cafe) 2/4 · Moved from 20th');
assert.equal(insertedResources[0].start.dateTime, '2026-08-22T06:00:00.000Z');
assert.equal(insertedResources[0].end.dateTime, '2026-08-22T06:50:00.000Z');
assert.deepEqual(patchedCalls, [{
  eventId: 'calendar-instance-id',
  resource: {
    summary: 'Keishi (Cafe) 2/4 · Moved to 22nd',
    colorId: '8',
  },
}]);
assert.deepEqual(removedCalls, []);
const preserved = apiEvents.get('calendar-instance-id');
assert.equal(preserved.start.dateTime, '2026-08-20T10:00:00+09:00');
assert.equal(preserved.end.dateTime, '2026-08-20T10:50:00+09:00');
assert.equal(preserved.summary, 'Keishi (Cafe) 2/4 · Moved to 22nd');
assert.equal(preserved.colorId, '8');
assert.equal(lockReleaseCount, 1);
console.log('ok - exact source occurrence is patched in place and never removed');

// Old Moved-to event is returned as rescheduled, and availability ignores it.
listItems = [{ ...structuredClone(preserved) }];
response = post({
  action: 'lesson_book_list',
  key: 'worker-secret',
  date: '2026-08-20',
});
payload = JSON.parse(response.text);
assert.equal(payload.lessons[0].status, 'rescheduled');
assert.equal(payload.lessons[0].canReschedule, false);
assert.equal(payload.lessons[0].rescheduleDirection, 'to');
response = post({
  action: 'availability',
  key: 'worker-secret',
  date: '2026-08-20',
});
payload = JSON.parse(response.text);
assert.deepEqual(payload.busy, []);
console.log('ok - preserved source is history only and releases its old slot');

// Destination conflicts are rejected without patching/removing the source.
apiEvents = new Map([[source.id, structuredClone(source)]]);
listItems = [{
  id: 'occupied-id',
  iCalUID: 'occupied@google.com',
  status: 'confirmed',
  summary: 'Other lesson',
  start: { dateTime: '2026-08-22T15:00:00+09:00' },
  end: { dateTime: '2026-08-22T15:50:00+09:00' },
}];
insertedResources = [];
patchedCalls = [];
removedCalls = [];
response = post({
  action: 'lesson_book_update',
  key: 'worker-secret',
  eventId: 'lesson-ical-id@google.com',
  apiEventId: 'calendar-instance-id',
  occurrenceStartIso: '2026-08-20T01:00:00.000Z',
  updateScope: 'thisInstanceOnly',
  start: '2026-08-22T15:00:00+09:00',
  end: '2026-08-22T15:50:00+09:00',
});
payload = JSON.parse(response.text);
assert.equal(payload.ok, false);
assert.equal(payload.code, 'SLOT_UNAVAILABLE');
assert.equal(insertedResources.length, 0);
assert.equal(patchedCalls.length, 0);
assert.equal(removedCalls.length, 0);
console.log('ok - conflict leaves source untouched');

// Metadata-only update still falls through to legacy Code.js behavior.
calendarAppEvent = {
  getId: () => 'lesson-ical-id@google.com',
  getTitle: () => 'Original',
  getDescription: () => '',
  setTitle: next => titleUpdates.push(String(next)),
  setDescription: () => {},
  setColor: () => {},
};
titleUpdates = [];
response = post({
  action: 'lesson_book_update',
  key: 'worker-secret',
  eventId: 'lesson-ical-id@google.com',
  title: 'Updated title only',
});
payload = JSON.parse(response.text);
assert.equal(payload.ok, true);
assert.equal(payload.actionTaken, 'updated');
assert.deepEqual(titleUpdates, ['Updated title only']);
console.log('ok - metadata-only lesson_book_update remains backward compatible');

console.log('\n6 bridge tests passed');
