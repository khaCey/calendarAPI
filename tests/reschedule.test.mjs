import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const properties = { BOOKING_API_KEY: 'worker-secret' };

let calendarEvents = [];
let eventById = null;
let createdEvents = [];
let lockReleaseCount = 0;
let lockAvailable = true;

function makeEvent({
  id = 'lesson-event-id',
  title = 'Keishi (Cafe) 1/4',
  start = '2026-08-20T01:00:00.000Z',
  end = '2026-08-20T01:50:00.000Z',
  recurring = false,
  instances = [],
  color = '10',
  description = 'StudentId: 1\nBookingSyncKey: source-key',
  location = 'Cafe',
} = {}) {
  const currentStart = new Date(start);
  const currentEnd = new Date(end);
  let currentTitle = title;
  let currentColor = color;
  let currentDescription = description;
  let currentLocation = location;
  let setTimeCalls = 0;
  let deleted = false;

  return {
    getId: () => id,
    getStartTime: () => new Date(currentStart),
    getEndTime: () => new Date(currentEnd),
    isRecurringEvent: () => recurring,
    getInstances: () => instances,
    getEventSeries: () => ({ getId: () => id }),
    setTime: () => { setTimeCalls += 1; },
    setTitle: value => { currentTitle = String(value); },
    getTitle: () => currentTitle,
    getDescription: () => currentDescription,
    setDescription: value => { currentDescription = String(value); },
    getLocation: () => currentLocation,
    setLocation: value => { currentLocation = String(value); },
    getColor: () => currentColor,
    setColor: value => { currentColor = String(value); },
    deleteEvent: () => { deleted = true; },
    stats: () => ({
      id,
      setTimeCalls,
      start: currentStart.toISOString(),
      end: currentEnd.toISOString(),
      title: currentTitle,
      color: currentColor,
      description: currentDescription,
      location: currentLocation,
      deleted,
    }),
  };
}

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
  createEvent: (title, start, end, options = {}) => {
    const event = makeEvent({
      id: `destination-${createdEvents.length + 1}`,
      title,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      description: options.description || '',
      location: options.location || '',
      color: '',
    });
    createdEvents.push(event);
    return event;
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
  Utilities: {
    getUuid: () => '00000000-0000-4000-8000-000000000000',
    formatDate: date => String(new Date(date).getUTCDate()),
  },
});

for (const file of ['Config.js', 'PrivateCalendar.js', 'Code.js', 'Reschedule.js', 'LineBookingBridge.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
}

function post(body) {
  const response = context.doPost({
    parameter: {},
    postData: { contents: JSON.stringify(body) },
  });
  return JSON.parse(response.text);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function reset() {
  calendarEvents = [];
  eventById = null;
  createdEvents = [];
  lockReleaseCount = 0;
  lockAvailable = true;
}

test('metadata-only lesson_book_update still delegates to the original Admin path', () => {
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
  assert.equal(createdEvents.length, 0);
});

test('reschedule rejects a duration other than 50 minutes', () => {
  reset();
  const event = makeEvent();
  eventById = event;

  const payload = post({
    action: 'lesson_book_update',
    key: 'worker-secret',
    eventId: 'lesson-event-id',
    occurrenceStartIso: '2026-08-20T01:00:00.000Z',
    updateScope: 'thisInstanceOnly',
    start: '2026-08-21T10:00:00+09:00',
    end: '2026-08-21T11:00:00+09:00',
  });

  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'INVALID_RESCHEDULE_WINDOW');
  assert.equal(event.stats().setTimeCalls, 0);
  assert.equal(createdEvents.length, 0);
});

test('reschedule keeps source time, greys source, and creates a separate destination', () => {
  reset();
  const event = makeEvent();
  eventById = event;

  const payload = post({
    action: 'lesson_book_update',
    key: 'worker-secret',
    eventId: 'lesson-event-id',
    occurrenceStartIso: '2026-08-20T01:00:00.000Z',
    updateScope: 'thisInstanceOnly',
    start: '2026-08-21T14:00:00+09:00',
    end: '2026-08-21T14:50:00+09:00',
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.actionTaken, 'rescheduled');
  assert.equal(payload.start, '2026-08-21T05:00:00.000Z');
  assert.equal(payload.end, '2026-08-21T05:50:00.000Z');

  const source = event.stats();
  assert.equal(source.setTimeCalls, 0);
  assert.equal(source.start, '2026-08-20T01:00:00.000Z');
  assert.equal(source.end, '2026-08-20T01:50:00.000Z');
  assert.match(source.title, /Moved to 21st$/);
  assert.equal(source.color, '8');

  assert.equal(createdEvents.length, 1);
  const destination = createdEvents[0].stats();
  assert.equal(destination.start, '2026-08-21T05:00:00.000Z');
  assert.equal(destination.end, '2026-08-21T05:50:00.000Z');
  assert.match(destination.title, /Moved from 20th$/);
  assert.equal(destination.color, '10');
  assert.match(destination.description, /BookingSyncKey: LINE-RESCHEDULE-/);
  assert.doesNotMatch(destination.description, /BookingSyncKey: source-key/);
  assert.equal(lockReleaseCount, 1);
});

test('occupied destination is rejected without changing the source', () => {
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
    occurrenceStartIso: '2026-08-20T01:00:00.000Z',
    updateScope: 'thisInstanceOnly',
    start: '2026-08-21T14:00:00+09:00',
    end: '2026-08-21T14:50:00+09:00',
  });

  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'SLOT_UNAVAILABLE');
  assert.equal(event.stats().title, 'Keishi (Cafe) 1/4');
  assert.equal(event.stats().color, '10');
  assert.equal(event.stats().setTimeCalls, 0);
  assert.equal(createdEvents.length, 0);
});

test('reschedule rejects when booking lock cannot be acquired', () => {
  reset();
  const event = makeEvent();
  eventById = event;
  lockAvailable = false;

  const payload = post({
    action: 'lesson_book_update',
    key: 'worker-secret',
    eventId: 'lesson-event-id',
    occurrenceStartIso: '2026-08-20T01:00:00.000Z',
    updateScope: 'thisInstanceOnly',
    start: '2026-08-21T14:00:00+09:00',
    end: '2026-08-21T14:50:00+09:00',
  });

  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'BOOKING_BUSY');
  assert.equal(event.stats().setTimeCalls, 0);
  assert.equal(createdEvents.length, 0);
  assert.equal(lockReleaseCount, 0);
});

test('already-rescheduled source cannot be rescheduled again', () => {
  reset();
  const event = makeEvent({ title: 'Keishi (Cafe) 1/4 · Moved to 22nd', color: '8' });
  eventById = event;

  const payload = post({
    action: 'lesson_book_update',
    key: 'worker-secret',
    eventId: 'lesson-event-id',
    occurrenceStartIso: '2026-08-20T01:00:00.000Z',
    updateScope: 'thisInstanceOnly',
    start: '2026-08-23T14:00:00+09:00',
    end: '2026-08-23T14:50:00+09:00',
  });

  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'ALREADY_RESCHEDULED');
  assert.equal(createdEvents.length, 0);
});

test('recurring lesson resolves and marks only the selected occurrence', () => {
  reset();
  const instance = makeEvent({
    id: 'series-id_20260820T010000Z',
    start: '2026-08-20T01:00:00.000Z',
    end: '2026-08-20T01:50:00.000Z',
    recurring: true,
  });
  const master = makeEvent({
    id: 'series-id',
    recurring: true,
    instances: [instance],
  });
  eventById = master;

  const payload = post({
    action: 'lesson_book_update',
    key: 'worker-secret',
    eventId: 'series-id',
    seriesMasterId: 'series-id',
    occurrenceStartIso: '2026-08-20T01:00:00.000Z',
    updateScope: 'thisInstanceOnly',
    start: '2026-08-22T15:00:00+09:00',
    end: '2026-08-22T15:50:00+09:00',
  });

  assert.equal(payload.ok, true);
  assert.equal(master.stats().title, 'Keishi (Cafe) 1/4');
  assert.equal(master.stats().color, '10');
  assert.equal(master.stats().setTimeCalls, 0);

  assert.match(instance.stats().title, /Moved to 22nd$/);
  assert.equal(instance.stats().color, '8');
  assert.equal(instance.stats().start, '2026-08-20T01:00:00.000Z');
  assert.equal(instance.stats().setTimeCalls, 0);
  assert.equal(createdEvents.length, 1);
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
