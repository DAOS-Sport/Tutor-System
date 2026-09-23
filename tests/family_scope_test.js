/**
 * 家庭帳號核心（規格 docs/family_accounts_spec_2026-09-23.md §4、§9）：
 *  - familyRules：關係、重複學員處理規則、擁有者判斷（純函式）
 *  - familyScope：開關、試點手機、凍結、成員集合、同請求只查一次（假 DB，不連線）
 */
const assert = require('node:assert/strict');
const path = require('node:path');

const SERVER = path.resolve(__dirname, '..', 'server');
const rules = require(path.join(SERVER, 'services/familyRules'));
const scope = require(path.join(SERVER, 'services/familyScope'));

let failures = 0;
async function check(label, fn) {
  try { await fn(); console.log('  ok  ' + label); }
  catch (e) { failures++; console.error('  FAIL ' + label + ' → ' + e.message); }
}

// 假 DB：依 SQL 片段回資料；遇到沒預期的查詢直接丟錯（避免測到不該查的東西）
function fakeDb({ flagRow = null, memberships = [], families = {}, parents = {} } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push(sql);
      if (sql.includes('application_feature_flags')) return { rows: flagRow ? [flagRow] : [] };
      if (sql.includes('JOIN families f ON f.id = fm.family_id')) {
        const m = memberships.find((x) => x.parent_id === params[0] && x.status === 'active');
        if (!m) return { rows: [] };
        const f = families[m.family_id];
        return { rows: [{ family_id: m.family_id, role: m.role, relationship: m.relationship,
          family_status: f.status, owner_parent_id: f.owner, family_name: null }] };
      }
      if (sql.includes('JOIN parents p ON p.id = fm.parent_id')) {
        return { rows: memberships
          .filter((x) => x.family_id === params[0] && x.status === 'active')
          .map((x) => ({ id: x.parent_id, phone: parents[x.parent_id] })) };
      }
      throw new Error('unexpected query: ' + sql.slice(0, 60));
    },
  };
}

const MOM = { id: 'p-mom', phone: '0911000001' };
const DAD = { id: 'p-dad', phone: '0911000002' };
const STRANGER = { id: 'p-x', phone: '0911000009' };
const FAMILY = {
  memberships: [
    { family_id: 'f1', parent_id: 'p-mom', role: 'owner', relationship: 'mother', status: 'active' },
    { family_id: 'f1', parent_id: 'p-dad', role: 'member', relationship: 'father', status: 'active' },
  ],
  families: { f1: { status: 'active', owner: 'p-mom' } },
  parents: { 'p-mom': MOM.phone, 'p-dad': DAD.phone },
};

(async () => {
  // ── familyRules ────────────────────────────────────────────────────────
  await check('關係代碼與中文', () => {
    assert.equal(rules.relationshipLabel('father'), '爸爸');
    assert.equal(rules.relationshipLabel('maternal_grandmother'), '外婆');
    assert.equal(rules.relationshipLabel('???'), '家人');
    assert.equal(rules.isRelationship('guardian'), true);
    assert.equal(rules.isRelationship('self'), false);
  });

  const ragic = (id, periods) => ({ id, parentId: 'p-' + id, inRagic: true, periods });
  const local = (id, periods) => ({ id, parentId: 'p-' + id, inRagic: false, periods });
  await check('§9：只有 Ragic 那份有課 → 停用另一份', () => {
    assert.deepEqual(rules.resolveDuplicate(ragic('a', 2), local('b', 0)), { action: 'deactivate', studentId: 'b', keepId: 'a' });
    assert.deepEqual(rules.resolveDuplicate(local('b', 0), ragic('a', 2)), { action: 'deactivate', studentId: 'b', keepId: 'a' });
  });
  await check('§9：有課的是沒進 Ragic 那份 → 交給櫃台', () => {
    assert.deepEqual(rules.resolveDuplicate(ragic('a', 0), local('b', 1)), { action: 'manual', reason: 'courses_on_non_ragic_copy' });
  });
  await check('§9：兩份都有課 → 都保留、不搬課程', () => {
    assert.equal(rules.resolveDuplicate(ragic('a', 1), local('b', 3)).action, 'keep_both');
  });
  await check('§9：都沒課 → 保留 Ragic 那份；都在／都不在 Ragic → 交給櫃台', () => {
    assert.deepEqual(rules.resolveDuplicate(local('b', 0), ragic('a', 0)), { action: 'deactivate', studentId: 'b', keepId: 'a' });
    assert.equal(rules.resolveDuplicate(ragic('a', 0), ragic('b', 0)).action, 'manual');
    assert.equal(rules.resolveDuplicate(local('a', 0), local('b', 0)).action, 'manual');
    assert.equal(rules.resolveDuplicate(ragic('a', 0), ragic('a', 0)).action, 'manual');
  });
  await check('擁有者＝孩子在 Ragic 上所屬的家長', () => {
    assert.equal(rules.ownerParentFor(ragic('a', 0), local('b', 0)), 'p-a');
    assert.equal(rules.ownerParentFor(local('a', 0), local('b', 0)), null);
  });

  // ── familyScope ────────────────────────────────────────────────────────
  delete process.env.FAMILY_ACCOUNTS_V1;
  await check('開關沒設定 → 只有自己，而且不查家庭', async () => {
    const db = fakeDb(FAMILY);
    const s = await scope.scopeFor(DAD, db);
    assert.deepEqual(s.parentIds, ['p-dad']);
    assert.deepEqual(s.phones, [DAD.phone]);
    assert.equal(s.enabled, false);
    assert.ok(!db.calls.some((c) => c.includes('family_members')), '關閉時不該查家庭表');
  });

  process.env.FAMILY_ACCOUNTS_V1 = 'all';
  await check('開關開啟、在家庭裡 → 全家（含本人）', async () => {
    const s = await scope.scopeFor(DAD, fakeDb(FAMILY));
    assert.deepEqual([...s.parentIds].sort(), ['p-dad', 'p-mom']);
    assert.deepEqual([...s.phones].sort(), [MOM.phone, DAD.phone].sort());
    assert.equal(s.family.role, 'member');
  });
  await check('不在任何家庭 → 只有自己', async () => {
    const s = await scope.scopeFor(STRANGER, fakeDb(FAMILY));
    assert.deepEqual(s.parentIds, ['p-x']);
    assert.equal(s.family, null);
  });
  await check('家庭被凍結 → 擁有者和成員都只剩自己', async () => {
    const frozen = { ...FAMILY, families: { f1: { status: 'frozen', owner: 'p-mom' } } };
    assert.deepEqual((await scope.scopeFor(MOM, fakeDb(frozen))).parentIds, ['p-mom']);
    assert.deepEqual((await scope.scopeFor(DAD, fakeDb(frozen))).parentIds, ['p-dad']);
  });
  await check('成員被移除（revoked）→ 立刻只剩自己；擁有者也看不到他', async () => {
    const revoked = { ...FAMILY, memberships: FAMILY.memberships.map((m) => (m.parent_id === 'p-dad' ? { ...m, status: 'revoked' } : m)) };
    assert.deepEqual((await scope.scopeFor(DAD, fakeDb(revoked))).parentIds, ['p-dad']);
    assert.deepEqual((await scope.scopeFor(MOM, fakeDb(revoked))).parentIds, ['p-mom']);
  });

  process.env.FAMILY_ACCOUNTS_V1 = `${DAD.phone}`;
  await check('試點：只開給指定手機，其他人照舊', async () => {
    assert.deepEqual([...(await scope.scopeFor(DAD, fakeDb(FAMILY))).parentIds].sort(), ['p-dad', 'p-mom']);
    assert.deepEqual((await scope.scopeFor(MOM, fakeDb(FAMILY))).parentIds, ['p-mom']);
  });

  delete process.env.FAMILY_ACCOUNTS_V1;
  await check('開關也可以存在 application_feature_flags（依手機試點）', async () => {
    const db = fakeDb({ ...FAMILY, flagRow: { enabled: true, allowed_phones: [MOM.phone] } });
    assert.deepEqual([...(await scope.scopeFor(MOM, db)).parentIds].sort(), ['p-dad', 'p-mom']);
    assert.deepEqual((await scope.scopeFor(DAD, db)).parentIds, ['p-dad']);
  });

  process.env.FAMILY_ACCOUNTS_V1 = 'all';
  await check('同一個請求只查一次；擁有者判斷', async () => {
    const db = fakeDb(FAMILY);
    const req = { parent: MOM };
    const a = await scope.actingParentIds(req, db);
    const b = await scope.actingPhones(req, db);
    assert.deepEqual([...a].sort(), ['p-dad', 'p-mom']);
    assert.equal(b.length, 2);
    assert.equal(db.calls.filter((c) => c.includes('JOIN parents p')).length, 1);
    assert.equal(await scope.isFamilyOwner(req, db), true);
    assert.equal(await scope.isFamilyOwner({ parent: DAD }, fakeDb(FAMILY)), false);
  });
  await check('沒有登入的家長 → 空集合，不查 DB', async () => {
    const db = fakeDb(FAMILY);
    const s = await scope.scopeFor(null, db);
    assert.deepEqual(s.parentIds, []);
    assert.equal(db.calls.length, 0);
  });
  delete process.env.FAMILY_ACCOUNTS_V1;

  if (failures) {
    console.error(`family_scope_test: ${failures} FAIL`);
    process.exit(1);
  }
  console.log('family_scope_test: PASS');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
