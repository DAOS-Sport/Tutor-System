const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(
  path.resolve(__dirname, '../client/admin/src/pages/GroupOrdersPage.jsx'),
  'utf8'
);

for (const label of ['依團主篩選', '依組別篩選', '依教練篩選', '依場館篩選']) {
  assert.ok(source.includes(`aria-label="${label}"`), `${label} dropdown must remain visible`);
}

assert.ok(source.includes("leader_phone || row.leader_name"), 'leader filter keeps a stable phone-backed key');
assert.ok(source.includes("row.coach_id || '__unassigned__'"), 'coach filter uses coach_id and classifies unassigned rows');
assert.ok(source.includes("row.venue_id || '__missing__'"), 'venue filter uses venue_id and classifies missing rows');
assert.ok(source.includes("String(row.course_type ?? '')"), 'course-type filter uses the persisted course_type');
assert.ok(source.includes('Object.values(categoryFilters).some(Boolean)'), 'category filters expose a deterministic reset state');
assert.ok(source.includes("{m.carrier || '—'}"), 'group member detail keeps the carrier field visible in admin');

console.log('admin_group_order_filter_ui_test: PASS');
