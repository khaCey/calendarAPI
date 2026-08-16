import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const properties = { BOOKING_API_KEY: 'worker-secret' };

let calendarEvents = [];
let eventById = null;
let lockReleaseCount = 0;
let lockAvailable = true;

const defaultCalendar = {
  getId: () => 'private@example.com',
  getName: () => 'Private calendar',
  getTimeZone: () => 'Asia/Tokyo',
  isMyPrimaryCalendar: () => true,
  getEvents: () => calendarEvents,
  getEventById: id => {
    if (!eventById) return null;
    const eventId = eventById.getId ? String(eventById.getId()) : '';
    return eventId === id ? eventById : null;
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
      setProperty: (key, value) => { properties[key] = value; },
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
      list: () => ({ items: [] }),
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
      tryLock: () => lockAvailable,
      releaseLock: () => { lockReleaseCount += 1; },
    }),
  },
  Logger: { log: () => {} },
  Utilities: { getUuid: () => '00000000-0000-4000-8000-000000000000' },
});

for (const file of ['Config.js', 'PrivateCalendar.js', 'Code.js', 'Reschedule.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
}

function post(body) {
  const response = context.doPost({
    parameter: {},
    postData: { contents: JSON.stringify(body) },
  });
  return JSON.parse(response.text);
}

function makeEvent({
  id = 'lesson-event-id',
  start = '2026-08-20T01:00:00.000Z',
  end = '2026-08-20T01:50:00.000Z',
  recurring = false,
  instances = [],
} = {}) {
  let currentStart = new Date(start);
  let currentEnd = new Date(end);
  let title = 'Original title';
  let description = '';
  let setTimeCalls = 0;

  return {
    getId: () => id,
    getStartTime: () => new Date(currentStart),
    getEndTime: () => new Date(currentEnd),
    isRecurringEvent: () => recurring,
    getInstances: () => instances,
    getEventSeries: () => ({ getId: () => id }),
    setTime: (nextStart, nextEnd) => {
      setTimeCalls += 1;
      currentStart = new Date(nextStart);
      currentEnd = new Date(nextEnd);
    },
    setTitle: value => { title = String(value); },
    getTitle: () => title,
    getDescription: () => description,
    setDescription: value => { description = String(value); },
    setColor: () => {},
    stats: () => ({
      setTimeCalls,
      start: currentStart.toISOString(),
      end: currentEnd.toISOString(),
      title,
      description,
    }),
  };
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function reset() {
  calendarEvents = [];
  eventById = null;
  lockReleaseCount = 0;
  lockAvailable = true;
}

test('metadata-only lesson_book_update still uses the original update path', () => {
  reset();
  const event = makeEvent();
  eventById = event;

  const payload = post({
    action: 'lesson_book_update',
    key: 'worker-secret',
    eventId: 'lesson-event-id',
    title: 'Updated metadata only',
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.actionTaken, 'updated');
  assert.equal(event.stats().setTimeCalls, 0);
  assert.equal(event.stats().title, 'Updated metadata only');
});

test('reschedule rejects a duration other than 50 minutes', () => {
  reset();
  const event = makeEvent();
  eventById = event;

  const payload = post({
    action: 'lesson_book_update',
    key: 'worker-secret',
    eventId: 'lesson-event-id',
    updateScope: 'thisInstanceOnly',
    start: '2026-08-21T10:00:00+09:00',
    end: '2026-08-21T11:00:00+09:00',
  });

  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'INVALID_RESCHEDULE_WINDOW');
  assert.equal(event.stats().setTimeCalls, 0);
});

test('reschedule moves one normal lesson and returns the new time', () => {
  reset();
  const event = makeEvent();
  eventById = event;

  const payload = post({
    action: 'lesson_book_update',
    key: 'worker-secret',
    eventId: 'lesson-event-id',
    updateScope: 'thisInstanceOnly',
    start: '2026-08-21T14:00:00+09:00',
    end: '2026-08-21T14:50:00+09:00',
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.actionTaken, 'rescheduled');
  assert.equal(payload.eventId, 'lesson-event-id');
  assert.equal(payload.start, '2026-08-21T05:00:00.000Z');
  assert.equal(payload.end, '2026-08-21T05:50:00.000Z');
  assert.equal(event.stats().setTimeCalls, 1);
  assert.equal(event.stats().start, '2026-08-21T05:00:00.000Z');
  assert.equal(event.stats().end, '2026-08-21T05:50:00.000Z');
  assert.equal(lockReleaseCount, 1);
});

test('reschedule rejects an occupied destination and does not move the lesson', () => {
  reset();
  const event = makeEvent();
  const conflict = makeEvent({
    id: 'other-event-id',
    start: '2026-08-21T05:20:00.000Z',
    end: '2026-08-21T06:10:00.000Z',
  });
  eventById = event;
  calendarEvents = [conflict];

  const payload = post({
    action: 'lesson_book_update',
    key: 'worker-secret',
    eventId: 'lesson-event-id',
    updateScope: 'thisInstanceOnly',
    start: '2026-08-21T14:00:00+09:00',
    end: '2026-08-21T14:50:00+09:00',
  });

  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'SLOT_UNAVAILABLE');
  assert.equal(event.stats().setTimeCalls, 0);
  assert.equal(lockReleaseCount, 1);
});

test('reschedule rejects when the booking lock cannot be acquired', () => {
  reset();
  const event = makeEvent();
  eventById = event;
  lockAvailable = false;

  const payload = post({
    action: 'lesson_book_update',
    key: 'worker-secret',
    eventId: 'lesson-event-id',
    updateScope: 'thisInstanceOnly',
    start: '2026-08-21T14:00:00+09:00',
    end: '2026-08-21T14:50:00+09:00',
  });

  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'BOOKING_BUSY');
  assert.equal(event.stats().setTimeCalls, 0);
  assert.equal(lockReleaseCount, 0);
});

test('recurring lesson requires occurrenceStartIso', () => {
  reset();
  const event = makeEvent({ recurring: true });
  eventById = event;

  const payload = post({
    action: 'lesson_book_update',
    key: 'worker-secret',
    eventId: 'lesson-event-id',
    updateScope: 'thisInstanceOnly',
    start: '2026-08-21T14:00:00+09:00',
    end: '2026-08-21T14:50:00+09:00',
  });

  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'MISSING_OCCURRENCE_START');
  assert.equal(event.stats().setTimeCalls, 0);
});

test('recurring lesson moves only the resolved occurrence', () => {
  reset();
  const instance = makeEvent({
    id: 'lesson-event-id_20260820T010000Z',
    start: '2026-08-20T01:00:00.000Z',
    end: '2026-08-20T01:50:00.000Z',
    recurring: true,
  });
  const master = makeEvent({
    id: 'lesson-event-id',
    recurring: true,
    instances: [instance],
  });
  eventById = master;

  const payload = post({
    action: 'lesson_book_update',
    key: 'worker-secret',
    eventId: 'lesson-event-id',
    seriesMasterId: 'lesson-event-id',
    occurrenceStartIso: '2026-08-20T01:00:00.000Z',
    updateScope: 'thisInstanceOnly',
    start: '2026-08-22T15:00:00+09:00',
    end: '2026-08-22T15:50:00+09:00',
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.actionTaken, 'rescheduled');
  assert.equal(payload.eventId, 'lesson-event-id_20260820T010000Z');
  assert.equal(master.stats().setTimeCalls, 0);
  assert.equal(instance.stats().setTimeCalls, 1);
  assert.equal(instance.stats().start, '2026-08-22T06:00:00.000Z');
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

console.log(`\n${passed} reschedule tests passed`);
