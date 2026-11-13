// 報名握手（老闆 2026-11-03：報名時要點下去才能報名）。
// 後端：三個建單入口沒帶或帶舊版 policy_ack 一律 428，帶對版本才往下走。前端：三頁都要勾選才放行並帶版本。
// 不連資料庫：被擋下的請求在碰資料庫之前就回應；放行的請求只看它「不是 428」。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const { REFUND_POLICY_VERSION, checkPolicyAck } = require('../server/services/policyHandshake');

function fakeRes() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    set() { return this; }, setHeader() {},
  };
}
function handlerOf(router, routePath) {
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods.post);
  assert.ok(layer, 'Missing POST ' + routePath);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}
async function hit(handle, body) {
  const res = fakeRes();
  const req = { body, params: { token: 'TESTTOKEN' }, query: {}, headers: {}, get: () => undefined, parent: { id: '00000000-0000-0000-0000-000000000000' }, ip: '127.0.0.1' };
  try { await handle(req, res, () => {}); } catch { /* 放行後碰資料庫失敗不影響這裡要測的事 */ }
  return res;
}

(async () => {
  // 1. 協議本身
  assert.match(REFUND_POLICY_VERSION, /^\d{4}-\d{2}-\d{2}/);
  assert.equal(checkPolicyAck({ policy_ack: REFUND_POLICY_VERSION }), null);
  for (const bad of [undefined, {}, { policy_ack: '' }, { policy_ack: true }, { policy_ack: '2020-01-01' }]) {
    const r = checkPolicyAck(bad);
    assert.equal(r.status, 428);
    assert.equal(r.body.code, 'POLICY_ACK_REQUIRED');
    assert.equal(r.body.policy_version, REFUND_POLICY_VERSION);
  }

  // 2. 三個建單入口都在最前面驗握手
  const entries = [
    [require('../server/routes/enrollments'), '/', '一般報名'],
    [require('../server/routes/groupOrders'), '/', '發起團購'],
    [require('../server/routes/groupOrders'), '/by-token/:token/join', '加入團購'],
  ];
  for (const [router, routePath, label] of entries) {
    const handle = handlerOf(router, routePath);
    const missing = await hit(handle, { course_type: 2 });
    assert.equal(missing.statusCode, 428, label + '：沒勾選要擋');
    const stale = await hit(handle, { policy_ack: '2020-01-01', course_type: 2 });
    assert.equal(stale.statusCode, 428, label + '：舊版條文要擋');
    const ok = await hit(handle, { policy_ack: REFUND_POLICY_VERSION });
    assert.notEqual(ok.statusCode, 428, label + '：勾選後要放行到後面的檢查');
  }

  // 3. 前後端版本一致
  const notice = read('client/liff/src/components/RefundPolicyNotice.jsx');
  const m = /REFUND_POLICY_VERSION = '([^']+)'/.exec(notice);
  assert.ok(m, 'Client version constant missing');
  assert.equal(m[1], REFUND_POLICY_VERSION, '前端條文版本要和後端一致');

  // 4. 三頁：勾選才放行、送出帶版本、畫面上有勾選框
  for (const [page, gate] of [
    ['client/liff/src/pages/EnrollmentPage.jsx', 'policyAgreed &&'],
    ['client/liff/src/pages/GroupCreatePage.jsx', '&& policyAgreed &&'],
    ['client/liff/src/pages/GroupJoinPage.jsx', '&& policyAgreed &&'],
  ]) {
    const src = read(page);
    assert.ok(src.includes(gate), page + '：送出鈕要等勾選');
    assert.ok(src.includes('policy_ack: REFUND_POLICY_VERSION'), page + '：送出要帶版本');
    assert.ok(src.includes('<PolicyAgreement checked={policyAgreed} onChange={setPolicyAgreed} />'), page + '：畫面要有勾選框');
    assert.ok(src.includes('useState(!!guide)'), page + '：示範模式預設已勾，導覽不卡');
  }
  console.log('PASS: policy handshake blocks enrollment/group create/group join without the current version, passes with it; client pages gate on the checkbox and send the version');
})().catch((error) => { console.error(error); process.exitCode = 1; });
