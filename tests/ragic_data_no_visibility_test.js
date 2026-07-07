const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ragicAdmin = require('../server/services/ragicAdmin');

const { staffPayloadFromRagicRow, publicStagingRow, sanitizeH01RawRow } = ragicAdmin.__test__;

function testDataNoUsesFieldIdOnly() {
  const payload = staffPayloadFromRagicRow(
    {
      _ragicId: 'R123',
      '資料編號': 'WRONG-NAME-FALLBACK',
      '3000934': '1107076',
      '3000935': 'S001',
      '3000933': '測試員工',
      '3000945': '在職',
      '1003633': 'U5713b8dca03d3a78777891da2e9f12b6',
    },
    () => []
  );
  assert.strictEqual(payload.ragic_data_no, '1107076');
  assert.strictEqual(payload.id, 'S001');
  assert.strictEqual(payload.line_uid, 'U5713b8dca03d3a78777891da2e9f12b6');
}

function testStagingDtoRedactsDataNo() {
  const row = publicStagingRow({
    entity_type: 'staff',
    entity_id: 'S001',
    payload_json: {
      id: 'S001',
      name: '測試員工',
      ragic_data_no: '1107076',
      halt_reason: 'duplicate_ragic_data_no',
    },
    diff_json: {
      ragic_data_no: { from: '1107076', to: '1107077' },
      name: { from: 'A', to: 'B' },
    },
  });
  assert.strictEqual(row.payload_json.ragic_data_no, undefined);
  assert.strictEqual(row.diff_json.ragic_data_no, undefined);
  assert.deepStrictEqual(row.diff_json.name, { from: 'A', to: 'B' });
}

function testUiHasExplicitDataNoHideList() {
  const ui = fs.readFileSync(
    path.join(__dirname, '../client/admin/src/pages/RagicStagingPage.jsx'),
    'utf8'
  );
  assert(ui.includes("'ragic_data_no'"));
  assert(ui.includes("'資料編號'"));
  assert(ui.includes("'3000934'"));

  const staffRoute = fs.readFileSync(
    path.join(__dirname, '../server/routes/admin/staff.js'),
    'utf8'
  );
  const rowToStaffBody = staffRoute.match(/function rowToStaff\(r\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert(!rowToStaffBody.includes('ragic_data_no'));
  assert(!rowToStaffBody.includes('3000934'));
  assert(!rowToStaffBody.includes('資料編號'));

  const coachesRoute = fs.readFileSync(
    path.join(__dirname, '../server/routes/coaches.js'),
    'utf8'
  );
  assert(coachesRoute.includes('const { ragic_data_no, ...safe } = row;'));

  const coachPortalRoute = fs.readFileSync(
    path.join(__dirname, '../server/routes/coachPortal.js'),
    'utf8'
  );
  assert(coachPortalRoute.includes('function stripCoachGovernanceFields'));
  assert(coachPortalRoute.includes('const { line_uid, ragic_data_no, ...safe } = coach;'));

  const authRoute = fs.readFileSync(
    path.join(__dirname, '../server/routes/auth.js'),
    'utf8'
  );
  assert(authRoute.includes('const { line_uid, ragic_data_no, ...safe } = coach;'));
}

function testH01ShadowRawDrops400LineFields() {
  process.env.RAGIC_FIELD_H01_400LINE_MESSAGE = '3999999';
  try {
    const row = sanitizeH01RawRow({
      _ragicId: 'R123',
      '3000934': '1107076',
      '3000935': 'S001',
      '400Line訊息': 'https://chat.line.biz/foo/chat/bar',
      '400v訊息': 'https://chat.line.biz/foo/chat/baz',
      3999999: 'env-blocked',
      '1003633': 'U5713b8dca03d3a78777891da2e9f12b6',
    });
    assert.strictEqual(row['3000934'], '1107076');
    assert.strictEqual(row['1003633'], 'U5713b8dca03d3a78777891da2e9f12b6');
    assert.strictEqual(row['400Line訊息'], undefined);
    assert.strictEqual(row['400v訊息'], undefined);
    assert.strictEqual(row[3999999], undefined);
  } finally {
    delete process.env.RAGIC_FIELD_H01_400LINE_MESSAGE;
  }
}

testDataNoUsesFieldIdOnly();
testStagingDtoRedactsDataNo();
testUiHasExplicitDataNoHideList();
testH01ShadowRawDrops400LineFields();
console.log('ragic_data_no_visibility_test: PASS');
