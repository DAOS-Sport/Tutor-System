import assert from 'node:assert/strict';
import { tourKey, tourSeen, markTourShown, claimAutoTour, tourSteps } from '../client/liff/src/utils/guideTour.mjs';

const parent = tourKey('parent', 'account-1');
const coach = tourKey('coach', 'account-1');
assert.equal(tourKey('admin', 'account-1'), null);
assert.equal(tourKey('parent', null), null);
assert.equal(tourSeen(null), true);
assert.equal(tourSeen(parent), false);
let calls = 0;
const request = async () => { calls++; return { show: true }; };
assert.deepEqual(await Promise.all([claimAutoTour(parent, request), claimAutoTour(parent, request)]), [true, true]);
assert.equal(calls, 1);
markTourShown(parent);
assert.equal(tourSeen(parent), true);
assert.equal(tourSeen(coach), false);
assert.equal(await claimAutoTour(coach, async () => ({ show: false })), false);
assert.equal(await claimAutoTour('unavailable', async () => { throw new Error('Offline'); }), false);
assert.equal(await claimAutoTour('malformed', async () => ({ show: 'true' })), false);
for (const role of ['parent', 'coach']) {
  const steps = tourSteps(role);
  assert.equal(steps[0].route, role === 'coach' ? '/coach' : '/');
  assert.equal(steps.at(-1).target, '[data-guide-entry]');
  assert(steps.slice(0, -1).every(s => !s.route.includes('guide') && !s.section));
  assert(steps.at(-1).text.includes('重看功能引導'));
}
assert.equal(tourSteps('parent').length, 5);
assert.equal(tourSteps('coach').length, 6);
console.log('PASS: one in-flight claim, account isolation, fail-closed response, functional steps, guide last');
