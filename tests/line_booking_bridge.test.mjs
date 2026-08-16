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
let createdEvents = [];
let titleUpdates = [];
let colorUpdates = [];

function formatTokyoDay(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Tokyo',
    day: 'numeric',
  }).format(date);
}

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
  createEvent: (title, start, end, options = {}) => {
    let color = '';
    const created = {
      title,
      start,
      end,
      options,
      deleted: false,
      getId: () => `created-${createdEvents.length + 1}@google.com`,
      getStartTime: () => start,
      getEndTime: () => end,
      getTitle: () => title,
      getDescription: () => String(options.description || ''),
      getLocation: () => String(options.location || ''),
      getColor: () => color,
      setColor: next => { color = String(next || ''); },
      deleteEvent: () => { created.deleted = true; },
    };
    createdEvents.push(created);
    return created;
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

function makeSourceEvent({ recurring = false, title = 'Keishi (Cafe) 2/4' } = {}) {
  const start = new Date('2026-08-20T01:00:00.000Z');
  const end = new Date('2026-08-20T01:50:00.000Z');
  let currentTitle = title;
  let currentColor = '10';
  let description = 'existing description';
  return {
    getId: () => 'lesson-ical-id@google.com',
    getStartTime: () => start,
    getEndTime: () => end,
    getTitle: () => currentTitle,
    getDescription: () => description,
    getLocation: () => 'Cafe',
    getColor: () => currentColor,
    isRecurringEvent: () => recurring,
    getInstances: () => [],
    setTitle: next => {
      currentTitle = String(next);
      titleUpdates.push(currentTitle);
    },
    setDescription: next => { description = String(next || ''); },
    setColor: next => {
      currentColor = String(next || '');
      colorUpdates.push(currentColor);
    },
  };
}

// Sanitised event list exposes state but never private Calendar text.
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
  status: 'scheduled',
  canReschedule: true,
  rescheduleDirection: null,
});
assert.equal(response.text.includes('PRIVATE STUDENT NAME'), false);
assert.equal(response.text.includes('PRIVATE DESCRIPTION'), false);
assert.equal(response.text.includes('private@example.com'), false);
console.log('ok - lesson_book_list returns sanitized identity/time/state fields');

// Source "Moved to" event is surfaced as rescheduled and not reschedulable.
listItems = [{
  id: 'old-api-id',
  iCalUID: 'old-ical-id@google.com',
  summary: 'Keishi (Cafe) 2/4 · Moved to 22nd',
  start: { dateTime: '2026-08-20T10:00:00+09:00' },
  end: { dateTime: '2026-08-20T10:50:00+09:00' },
}];
response = post({
  action: 'lesson_book_list',
  key: 'worker-secret',
  date: '2026-08-20',
});
payload = JSON.parse(response.text);
assert.equal(payload.lessons[0].status, 'rescheduled');
assert.equal(payload.lessons[0].canReschedule, false);
assert.equal(payload.lessons[0].rescheduleDirection, 'to');
assert.equal(response.text.includes('Moved to 22nd'), false);
console.log('ok - source reschedule state is exposed without exposing title');

// Green Square-style reschedule keeps source slot and creates a destination.
eventById = makeSourceEvent();
calendarEvents = [];
createdEvents = [];
titleUpdates = [];
colorUpdates = [];
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
assert.equal(createdEvents.length, 1);
assert.equal(createdEvents[0].title, 'Keishi (Cafe) 2/4 · Moved from 20th');
assert.equal(createdEvents[0].start.toISOString(), '2026-08-22T06:00:00.000Z');
assert.equal(createdEvents[0].end.toISOString(), '2026-08-22T06:50:00.000Z');
assert.deepEqual(titleUpdates, ['Keishi (Cafe) 2/4 · Moved to 22nd']);
assert.deepEqual(colorUpdates, ['8']);
assert.equal(eventById.getStartTime().toISOString(), '2026-08-20T01:00:00.000Z');
assert.equal(eventById.getEndTime().toISOString(), '2026-08-20T01:50:00.000Z');
assert.equal(lockReleaseCount, 1);
console.log('ok - reschedule preserves source and creates linked destination event');

// Occupied destination is rejected before a destination event is created.
eventById = makeSourceEvent();
createdEvents = [];
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
assert.equal(createdEvents.length, 0);
assert.equal(lockReleaseCount, 1);
console.log('ok - reschedule rejects an occupied destination');

// Already-rescheduled source cannot be moved again.
eventById = makeSourceEvent({ title: 'Keishi (Cafe) 2/4 · Moved to 22nd' });
calendarEvents = [];
createdEvents = [];
response = post({
  action: 'lesson_book_update',
  key: 'worker-secret',
  eventId: 'lesson-ical-id@google.com',
  occurrenceStartIso: '2026-08-20T01:00:00.000Z',
  updateScope: 'thisInstanceOnly',
  start: '2026-08-23T15:00:00+09:00',
  end: '2026-08-23T15:50:00+09:00',
});
payload = JSON.parse(response.text);
assert.equal(payload.ok, false);
assert.equal(payload.code, 'ALREADY_RESCHEDULED');
assert.equal(createdEvents.length, 0);
console.log('ok - already-rescheduled source is protected');

// Metadata-only update still falls through to the original Code.js route.
calendarEvents = [];
eventById = makeSourceEvent();
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
