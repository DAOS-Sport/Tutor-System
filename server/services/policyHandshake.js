'use strict';
/**
 * 報名握手（老闆 2026-11-03：家長報名時要點下去才能報名）。
 *
 * 協議：家長在報名／發起團購／加入團購畫面勾選「我已閱讀並同意《家教班課程使用期限及退費說明》」，
 * 送出時帶 policy_ack＝目前條文版本。後端在建單前先驗證，版本相符才放行，之後的建單流程照舊。
 * 不另存紀錄（使用者 2026-11-03：只是放行鎖）。條文改版就換版本號，舊畫面或沒勾的請求一律擋下、要求重新勾選。
 *
 * 版本必須和 client/liff/src/components/RefundPolicyNotice.jsx 的 REFUND_POLICY_VERSION 一致
 * （tests/policy_handshake_test.js 會比對）。
 */
const REFUND_POLICY_VERSION = '2026-11-03';

function checkPolicyAck(body) {
  const ack = String((body && body.policy_ack) || '').trim();
  if (ack === REFUND_POLICY_VERSION) return null;
  return {
    status: 428,
    body: {
      error: '請先閱讀並勾選同意《家教班課程使用期限及退費說明》',
      code: 'POLICY_ACK_REQUIRED',
      policy_version: REFUND_POLICY_VERSION,
    },
  };
}

module.exports = { REFUND_POLICY_VERSION, checkPolicyAck };
