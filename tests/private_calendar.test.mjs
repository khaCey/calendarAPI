import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const properties = {};
let defaultCalendarCalls = 0;
let calendarByIdCalls = [];
let calendarEvents = [];
let createdEventCount = 0;
let lockReleaseCount = 0;

const defaultCalendar = {
  getId: () => 'private@example.com',
  getName: () => 'Private calendar',
  getTimeZone: () => 'Asia/Tokyo',
  isMyPrimaryCalendar: () => true,
  getEvents: () => calendarEvents,
  createEvent: () => {
    createdEventCount += 1;
    return {
      getId: () => 'created-event-id',
      setColor: () => {},
    };
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
    getDefaultCalendar: () => {
      defaultCalendarCalls += 1;
      return defaultCalendar;
    },
    getCalendarById: id => {
      calendarByIdCalls.push(id);
      return { getId: () => id };
    },
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
      tryLock: () => true,
      releaseLock: () => { lockReleaseCount += 1; },
    }),
  },
  Logger: { log: () => {} },
  Utilities: { getUuid: () => '00000000-0000-4000-8000-000000000000' },
});

for (const file of ['Config.js', 'PrivateCalendar.js', 'Code.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('defaults to exactly one private primary calendar', () => {
  assert.equal(context.getMainCalendarId_(), 'primary');
  assert.equal(context.getCalendarIdForKind_('regular'), 'primary');
  assert.equal(context.getCalendarIdForKind_('demo'), 'primary');
  assert.equal(context.getCalendarIdForKind_('owner'), 'primary');
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.getConfiguredCalendarDescriptors_())),
    [{ id: 'primary', kind: 'regular', name: 'private' }],
  );
});

test('uses optional separate calendars only when explicitly configured', () => {
  properties.DEMO_CALENDAR_ID = 'demo@example.com';
  properties.OWNER_CALENDAR_ID = 'primary';
  const descriptors = JSON.parse(JSON.stringify(context.getConfiguredCalendarDescriptors_()));
  assert.deepEqual(descriptors, [
    { id: 'primary', kind: 'regular', name: 'private' },
    { id: 'demo@example.com', kind: 'demo', name: 'demo' },
  ]);
  assert.equal(context.getCalendarIdForKind_('demo'), 'demo@example.com');
  delete properties.DEMO_CALENDAR_ID;
  delete properties.OWNER_CALENDAR_ID;
});

test('opens primary through getDefaultCalendar and custom IDs through getCalendarById', () => {
  defaultCalendarCalls = 0;
  calendarByIdCalls = [];
  assert.equal(context.openCalendarByConfiguredId_('primary'), defaultCalendar);
  assert.equal(defaultCalendarCalls, 1);
  context.openCalendarByConfiguredId_('custom@example.com');
  assert.deepEqual(calendarByIdCalls, ['custom@example.com']);
});

test('resolves a Japan calendar day into the correct UTC window', () => {
  const window = JSON.parse(JSON.stringify(context.parsePrivateAvailabilityWindow_({ date: '2026-08-20' })));
  assert.deepEqual(window, {
    timeMin: '2026-08-19T15:00:00.000Z',
    timeMax: '2026-08-20T15:00:00.000Z',
  });
});

test('merges overlapping and adjacent busy windows without event details', () => {
  const merged = JSON.parse(JSON.stringify(context.mergeBusyWindows_([
    { start: '2026-08-20T01:00:00.000Z', end: '2026-08-20T01:50:00.000Z' },
    { start: '2026-08-20T01:40:00.000Z', end: '2026-08-20T02:20:00.000Z' },
    { start: '2026-08-20T02:20:00.000Z', end: '2026-08-20T03:00:00.000Z' },
    { start: '2026-08-20T05:00:00.000Z', end: '2026-08-20T05:50:00.000Z' },
  ])));
  assert.deepEqual(merged, [
    { start: '2026-08-20T01:00:00.000Z', end: '2026-08-20T03:00:00.000Z' },
    { start: '2026-08-20T05:00:00.000Z', end: '2026-08-20T05:50:00.000Z' },
  ]);
});

test('detects an occupied slot and recognises an idempotent booking retry', () => {
  const start = new Date('2026-08-20T01:00:00.000Z');
  const end = new Date('2026-08-20T01:50:00.000Z');
  const occupied = {
    getStartTime: () => new Date('2026-08-20T01:20:00.000Z'),
    getEndTime: () => new Date('2026-08-20T02:10:00.000Z'),
    getDescription: () => '',
  };
  const retry = {
    getStartTime: () => start,
    getEndTime: () => end,
    getDescription: () => 'BookingSyncKey: retry-123',
  };
  const conflict = context.inspectBookingWindow_({ getEvents: () => [occupied] }, start, end, '');
  assert.equal(conflict.conflict, occupied);
  const idempotent = context.inspectBookingWindow_(
    { getEvents: () => [occupied, retry] },
    start,
    end,
    'BookingSyncKey: retry-123',
  );
  assert.equal(idempotent.existing, retry);
});

test('availability route never exposes private calendar event details', () => {
  properties.BOOKING_API_KEY = 'worker-secret';
  context.Calendar.Events.list = () => ({
    items: [{
      id: 'private-event-id',
      summary: 'Private appointment',
      description: 'Do not expose this',
      attendees: [{ email: 'private@example.com' }],
      start: { dateTime: '2026-08-20T10:00:00+09:00' },
      end: { dateTime: '2026-08-20T10:50:00+09:00' },
    }],
  });
  const response = context.doGet({
    parameter: {
      action: 'availability',
      date: '2026-08-20',
      key: 'worker-secret',
    },
  });
  const payload = JSON.parse(response.text);
  assert.equal(payload.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(payload.busy)), [{
    start: '2026-08-20T01:00:00.000Z',
    end: '2026-08-20T01:50:00.000Z',
  }]);
  assert.equal(response.text.includes('Private appointment'), false);
  assert.equal(response.text.includes('private-event-id'), false);
  assert.equal(response.text.includes('private@example.com'), false);
});

test('booking route rejects an occupied 50-minute slot while holding the lock', () => {
  properties.BOOKING_API_KEY = 'worker-secret';
  createdEventCount = 0;
  lockReleaseCount = 0;
  calendarEvents = [{
    getStartTime: () => new Date('2026-08-20T01:00:00.000Z'),
    getEndTime: () => new Date('2026-08-20T01:50:00.000Z'),
    getDescription: () => '',
  }];
  const response = context.doPost({
    parameter: {},
    postData: {
      contents: JSON.stringify({
        action: 'lesson_book_create',
        key: 'worker-secret',
        title: 'LINE Booking TEST',
        start: '2026-08-20T10:00:00+09:00',
        end: '2026-08-20T10:50:00+09:00',
        bookingKey: 'booking-test-1',
      }),
    },
  });
  const payload = JSON.parse(response.text);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'SLOT_UNAVAILABLE');
  assert.equal(createdEventCount, 0);
  assert.equal(lockReleaseCount, 1);
  calendarEvents = [];
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

console.log(`\n${passed} tests passed`);
