/**
 * 自動送審 / 代為送審（U15）迴歸鎖。
 *
 * 背景：2026-08 有兩團全員都付了款卻卡在 forming —— 團主不知道還要回來按一次送審，
 * 而後台清單只收 submitted/approved/rejected，所以櫃檯完全看不到，錢進來了沒人在追
 * （一團 3 天、一團 9 天才被發現）。修法是三件事：滿團＋全員付款齊備自動送審、
 * 後台多一個「揪團中·已收齊款」分頁、櫃檯可代為送審。
 *
 * 這支測試鎖的重點不是「功能有沒有寫」，而是「送審條件只有一份」：
 * 三條路徑散在兩個路由檔，任何一條就地複製一份判斷，兩邊遲早漂移，
 * 症狀會是「有的團送得出去、有的送不出去」——最難重現的那種客訴。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

const submitService = require('../server/services/groupOrderSubmit');
const serviceSource = read('server/services/groupOrderSubmit.js');
const parentRoute = read('server/routes/groupOrders.js');
const adminRoute = read('server/routes/admin/groupOrders.js');
const adminPage = read('client/admin/src/pages/GroupOrdersPage.jsx');
const liffPage = read('client/liff/src/pages/GroupStatusPage.jsx');

// ── 1. 共用服務的介面 ────────────────────────────────────
for (const fn of ['evaluateSubmitReadiness', 'isFullHouse', 'markSubmitted', 'notifyGroupSubmitted']) {
  assert.strictEqual(typeof submitService[fn], 'function', `groupOrderSubmit.${fn} must exist`);
}

// ── 2. 自動送審門檻是「滿團」，不是「達最低人數」──────────
// 一對三是 min 2 / max 3：若第 2 家付完款就自動送出，送審會鎖名單
// （加入端要求 status='forming'），第 3 家就永遠加不進來。把這條放寬成 min
// 會讓收得滿的團收不滿——歷史上一對三有 8/9 團最後收滿 3 人。
const { isFullHouse } = submitService;
assert.strictEqual(isFullHouse({ min_students: 2, max_students: 3 }, 2), false,
  'a 1v3 group sitting at its minimum must NOT auto-submit: the third family can still join');
assert.strictEqual(isFullHouse({ min_students: 2, max_students: 3 }, 3), true,
  'a full 1v3 group must auto-submit');
assert.strictEqual(isFullHouse({ min_students: 2, max_students: 2 }, 2), true,
  'for 1v2/1v4/1v5 (min == max) full house and minimum coincide');
assert.strictEqual(isFullHouse({ min_students: 5, max_students: 6 }, 5), false,
  'a 1v6 group at 5 of 6 must still wait for the last family');

// ── 3. 「付款齊備」的判斷片語兩份必須逐字相同 ────────────
// 後台清單沒辦法對每一列呼叫 JS 服務，SQL 那份必然是第二份實作；這裡不禁止它存在，
// 而是釘住兩份的片語逐字相同——改了其中一邊沒改另一邊，這條就會紅。
// 家長端路由則不該有自己的第三份，它必須走服務。
const UNPAID_FINGERPRINT = "NULLIF(TRIM(COALESCE(m.transfer_last_5, '')), '') IS NULL";
assert.ok(serviceSource.includes(UNPAID_FINGERPRINT),
  'the unpaid-member definition must live in services/groupOrderSubmit.js');
assert.ok(adminRoute.includes(UNPAID_FINGERPRINT),
  "the admin list's SQL predicate must stay word-for-word identical to the service's");
assert.ok(!parentRoute.includes(UNPAID_FINGERPRINT),
  'routes/groupOrders.js must go through the service, not keep its own copy');

// ── 4. my-proof 是唯一會讓「付款齊備」由否轉是的入口 ──────
// 加入端不寫 transfer_last_5，所以「加入」本身永遠不可能讓一團變成齊備。
// 哪天 join 開始收末 5 碼，就必須在那裡也掛自動送審，否則會有團永遠送不出去。
const joinInsertStart = parentRoute.indexOf('INSERT INTO group_order_members');
assert.ok(joinInsertStart > 0, 'join INSERT block must be findable');
const joinInsert = parentRoute.slice(joinInsertStart, parentRoute.indexOf('RETURNING id', joinInsertStart));
assert.ok(!joinInsert.includes('transfer_last_5'),
  'join must not set transfer_last_5 — if it ever does, hook auto-submit there as well');

// ── 5. my-proof 確實接上了自動送審 ───────────────────────
const myProofStart = parentRoute.indexOf("router.post('/:id/my-proof'");
const myProofEnd = parentRoute.indexOf("router.post('/:id/submit'");
assert.ok(myProofStart > 0 && myProofEnd > myProofStart, 'my-proof / submit handlers must be findable in order');
const myProof = parentRoute.slice(myProofStart, myProofEnd);
for (const token of ['evaluateSubmitReadiness', 'isFullHouse', 'markSubmitted', '系統自動', 'notifyGroupSubmitted']) {
  assert.ok(myProof.includes(token), `my-proof must wire auto-submit (missing: ${token})`);
}

// ── 6. 三條路徑都走同一個判定 ────────────────────────────
assert.ok(parentRoute.includes('evaluateSubmitReadiness'),
  "the leader's own submit must go through the shared evaluator");
assert.ok(adminRoute.includes('evaluateSubmitReadiness'),
  'the counter proxy-submit must go through the shared evaluator');
assert.ok(adminRoute.includes("router.post('/:id/submit'"), 'admin proxy-submit endpoint must exist');
assert.ok(adminRoute.includes('櫃檯代為送審'),
  'proxy submit must be audited under its own wording, not disguised as the leader submitting');

// ── 7. 後台看得到「揪團中·已收齊款」並且能動它 ────────────
assert.ok(adminRoute.includes('FORMING_READY_SQL'), 'admin list must surface forming-but-fully-paid groups');
assert.ok(adminRoute.includes("status === 'forming_ready'"), 'the forming_ready filter must be selectable');
assert.ok(adminPage.includes("['forming', '揪團中']"), 'admin page must show the forming tab');
assert.ok(adminRoute.includes("go.status IN ('forming','submitted','approved','rejected')"),
  'the default admin list must carry the whole forming pipeline, not just the fully-paid ones');
assert.ok(adminPage.includes('代為送審（送進待審核）'), 'admin page must offer the proxy-submit action');
assert.ok(adminPage.includes("forming: { label: '揪團中'"),
  'forming rows need their own badge, otherwise they render as a bare raw status string');
assert.ok(adminPage.includes('已收款 {g.paid_member_count}/{g.member_count}'),
  'the counter must see how many families have actually paid, not just how many joined');

// ── 8. 家長端要說明「會自動送審」──────────────────────────
// 不寫的話，家長看到「已上傳，待確認」還是不知道到底誰要按下一步。
assert.ok(liffPage.includes('自動送審'), 'the LIFF group page must tell parents that auto-submit exists');

console.log('group_auto_submit_test: PASS');
