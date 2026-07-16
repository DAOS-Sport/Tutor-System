// ═══════════════════════════════════════════════════════════════════
// 🧊 凍結（2026-07-16 使用者凍結令）：簽到／扣課政策 2026-07 版
// 本檔全檔屬凍結範圍。
// 修改凍結範圍前，必須先向使用者嚴格詢問並取得明確同意。
// 政策與完整範圍清單：repo 根目錄 CLAUDE.md、replit.md「簽到／扣課政策」節。
// ═══════════════════════════════════════════════════════════════════
/**
 * used_sessions 鏡射同步（共用 service）
 *
 * 堂數真相永遠是 course_sessions + checkin_records（DISTINCT 有 ATTENDED 的未取消
 * session 數）；course_periods.used_sessions 與 admin_enrollments.used_sessions 只是
 * 由該真相推導出來的 legacy 顯示欄位。任何寫入簽到/扣課的路徑（家長自助、教練端、
 * 櫃檯手動扣課）完成後都應呼叫本函式，把「同一共享 period 對應的全部訂單」一次同步：
 *  - anchor：course_periods.admin_enrollment_id 直接對應的訂單
 *  - 團報：同 group_order_id + period_number 的所有成員訂單
 *  - 多期批次：同 enrollment_batch_id + period_number 的所有訂單
 *
 * @param {object} client - pg client（呼叫端 transaction 內）
 * @param {object} period - 至少含 id（或 period_id）、admin_enrollment_id、
 *                          group_order_id、enrollment_batch_id、period_number
 * @param {number} used   - 權威已用堂數（attended distinct session 數）
 */
async function syncStoredUsage(client, period, used) {
  const periodId = period.id || period.period_id;
  await client.query(
    `UPDATE course_periods SET used_sessions = $2, updated_at = NOW() WHERE id = $1`,
    [periodId, used]
  );
  await client.query(
    `UPDATE admin_enrollments ae
        SET used_sessions = $5, updated_at = NOW()
      WHERE ae.id = $1
         OR ($2::uuid IS NOT NULL AND ae.group_order_id = $2::uuid
             AND COALESCE(ae.period_number, 1) = COALESCE($4::int, 1))
         OR ($3::uuid IS NOT NULL AND ae.enrollment_batch_id = $3::uuid
             AND COALESCE(ae.period_number, 1) = COALESCE($4::int, 1))`,
    [period.admin_enrollment_id || '', period.group_order_id || null,
     period.enrollment_batch_id || null, period.period_number || 1, used]
  );
}

/**
 * 列出共享此 period 的全部 admin_enrollments id（與 syncStoredUsage 同一組匹配條件），
 * 供稽核紀錄（admin_enrollment_audit_logs）對每筆訂單各寫一筆。
 */
async function listLinkedEnrollmentIds(client, period) {
  const r = await client.query(
    `SELECT ae.id
       FROM admin_enrollments ae
      WHERE ae.id = $1
         OR ($2::uuid IS NOT NULL AND ae.group_order_id = $2::uuid
             AND COALESCE(ae.period_number, 1) = COALESCE($4::int, 1))
         OR ($3::uuid IS NOT NULL AND ae.enrollment_batch_id = $3::uuid
             AND COALESCE(ae.period_number, 1) = COALESCE($4::int, 1))`,
    [period.admin_enrollment_id || '', period.group_order_id || null,
     period.enrollment_batch_id || null, period.period_number || 1]
  );
  return r.rows.map((row) => row.id);
}

module.exports = { syncStoredUsage, listLinkedEnrollmentIds };
