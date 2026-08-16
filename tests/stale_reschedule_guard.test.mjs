import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
let delegated = 0;

const context = vm.createContext({
  Date,
  Math,
  String,
  isNaN,
  applyLessonBookTimeUpdate_: () => {
    delegated += 1;
    return { ok: true, moved: true };
  },
  lessonBookSafeEventTime_: event => event.getStartTime(),
});

vm.runInContext(
  fs.readFileSync(path.join(root, 'StaleRescheduleGuard.js'), 'utf8'),
  context,
  { filename: 'StaleRescheduleGuard.js' }
);

const event = {
  getStartTime: () => new Date('2026-08-20T01:00:00.000Z'),
};

let result = context.applyLessonBookTimeUpdate_('primary', event, {
  occurrenceStartIso: '2026-08-20T01:00:00.000Z',
});
assert.equal(result.ok, true);
assert.equal(delegated, 1);
console.log('ok - current lesson reference delegates to reschedule implementation');

result = context.applyLessonBookTimeUpdate_('primary', event, {
  occurrenceStartIso: '2026-08-19T01:00:00.000Z',
});
assert.equal(result.ok, false);
assert.equal(result.code, 'STALE_LESSON_REFERENCE');
assert.equal(delegated, 1);
console.log('ok - stale lesson reference is rejected before reschedule');

console.log('\n2 stale-reference tests passed');
