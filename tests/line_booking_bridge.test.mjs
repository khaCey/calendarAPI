import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const properties = { BOOKING_API_KEY: 'worker-secret' };

let calendarEvents = [];
let eventById = null;
let listItems = [];
let lockReleaseCount = 0;
let setTimeCalls = [];
let titleUpdates = [];

const defaultCalendar = {
  getId: () => 'private@example.com',
  getName: () => 'Private calendar',
  getTimeZone: () => 'Asia/Tokyo',
  isMyPrimaryCalendar: () => true,
  getEvents: () => calendarEvents,
  getEventById: id => {
    if (!eventById) return null;
    return String(eventById.getId()) === String(id) ? eventById : null;
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
      patch: () => ({}),
      remove: () => {},
      insert: () => ({ id: 'inserted-event-id' }),
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
  Utilities: { getUuid: () => '00000000-0000-4000-8000-000000000000' },
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

function makeMovingEvent({ recurring = false } = {}) {
  let start = new Date('2026-08-20T01:00:00.000Z');
  let end = new Date('2026-08-20T01:50:00.000Z');
  return {
    getId: () => 'lesson-ical-id@google.com',
    getStartTime: () => start,
    getEndTime: () => end,
    getDescription: () => '',
    isRecurringEvent: () => recurring,
    getInstances: () => [],
    setTime: (nextStart, nextEnd) => {
      setTimeCalls.push([nextStart.toISOString(), nextEnd.toISOString()]);
      start = nextStart;
      end = nextEnd;
    },
    setTitle: title => { titleUpdates.push(title); },
    setDescription: () => {},
    setColor: () => {},
  };
}

// Sanitised event list: Worker gets identity, but private metadata is absent.
listItems = [{
  id: 'calendar-api-id',
  iCalUID: 'lesson-ical-id@google.com',
  summary: 'PRIVATE STUDENT NAME',
  description: 'PRIVATE DESCRIPTION',
  location: 'PRIVATE LOCATION',
  attendees: [{ email: 'private@example.com' }],
  start: { dateTime: '2026-08-20T10:00:00+09:00' },
  end: { dateTime: '2026-08-20T10:50:00+09:00' },
}];

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
  seriesMasterId: null,
  occurrenceStartIso: '2026-08-20T01:00:00.000Z',
  start: '2026-08-20T01:00:00.000Z',
  end: '2026-08-20T01:50:00.000Z',
});
assert.equal(response.text.includes('PRIVATE STUDENT NAME'), false);
assert.equal(response.text.includes('PRIVATE DESCRIPTION'), false);
assert.equal(response.text.includes('private@example.com'), false);
console.log('ok - lesson_book_list returns only sanitized identity/time fields');

// Real single-event reschedule.
eventById = makeMovingEvent();
calendarEvents = [];
setTimeCalls = [];
lockReleaseCount = 0;
response = post({
  action: 'lesson_book_update',
  key: 'worker-secret',
  eventId: 'lesson-ical-id@google.com',
  occurrenceStartIso: '2026-08-20T01:00:00.000Z',
  updateScope: 'thisInstanceOnly',
  start: '2026-08-22T15:00:00+09:00',
  end: '2026-08-22T15:50:00+09:00',
});
payload = JSON.parse(response.text);
assert.equal(payload.ok, true);
assert.equal(payload.actionTaken, 'rescheduled');
assert.deepEqual(setTimeCalls, [[
  '2026-08-22T06:00:00.000Z',
  '2026-08-22T06:50:00.000Z',
]]);
assert.equal(lockReleaseCount, 1);
console.log('ok - lesson_book_update moves an available 50-minute lesson');

// Occupied destination is rejected before setTime.
eventById = makeMovingEvent();
setTimeCalls = [];
lockReleaseCount = 0;
calendarEvents = [{
  getId: () => 'other-event@google.com',
  getStartTime: () => new Date('2026-08-22T06:00:00.000Z'),
  getEndTime: () => new Date('2026-08-22T06:50:00.000Z'),
}];
response = post({
  action: 'lesson_book_update',
  key: 'worker-secret',
  eventId: 'lesson-ical-id@google.com',
  occurrenceStartIso: '2026-08-20T01:00:00.000Z',
  updateScope: 'thisInstanceOnly',
  start: '2026-08-22T15:00:00+09:00',
  end: '2026-08-22T15:50:00+09:00',
});
payload = JSON.parse(response.text);
assert.equal(payload.ok, false);
assert.equal(payload.code, 'SLOT_UNAVAILABLE');
assert.equal(setTimeCalls.length, 0);
assert.equal(lockReleaseCount, 1);
console.log('ok - reschedule rejects an occupied destination');

// Metadata-only update still falls through to the original Code.js route.
calendarEvents = [];
eventById = makeMovingEvent();
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
assert.equal(setTimeCalls.length, 0);
console.log('ok - metadata-only lesson_book_update remains backward compatible');

console.log('\n4 bridge tests passed');
