/**
 * 團購操作紀錄 — 比照 admin_enrollment_audit_logs（對帳）的追查標準。
 * 一律傳入當前交易的 client（或單一語句時的 pool），與業務寫入同生共死；
 * 不可 best-effort 吞錯，否則稽核紀錄會與實際狀態漂移。
 */
async function logGroupOrderAudit(db, { groupOrderId, action, by, reason = null }) {
  await db.query(
    `INSERT INTO group_order_audit_logs (group_order_id, action, by_user, reason)
     VALUES ($1, $2, $3, $4)`,
    [groupOrderId, String(action).slice(0, 500), String(by || 'unknown').slice(0, 100), reason]
  );
}

module.exports = { logGroupOrderAudit };
