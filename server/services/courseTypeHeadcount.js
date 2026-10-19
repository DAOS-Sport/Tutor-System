/**
 * 課程需求人數校正：course_type_configs 的 min／max_students 一律＝組別人數。
 *
 * 規則來源：使用者 2026-10-14「一對三就是 3 人、一對六就是 6 人，不要 min／max」。
 * 判斷端早就改成只看組別（services/groupOrderSubmit.requiredGroupSize、
 * services/enrollmentRules），後台寫入端（routes/admin/courseTypes.js）也在新增／編輯時
 * 強制存成組別人數。剩下的缺口是「規則上線前存進去、之後沒人編輯過」的舊列——
 * 例如一對三存 2–3、一對六存 5–6（D18／GitHub #13）。
 *
 * 這些舊值目前不會放寬人數，但仍然有害：
 *   - max_students 若不等於組別，個人報名會以 COURSE_CAPACITY_CONFIG_MISMATCH 整筆擋下（fail-closed）；
 *   - 報表、後台列表與舊畫面讀到的「2–3 人」與實際規則矛盾，櫃檯會照著錯的數字跟家長說明。
 *
 * 為什麼放在開機時跑、而不是寫進 coreSchema.js：coreSchema 的遷移／種子區塊屬於凍結範圍
 * （CLAUDE.md），而且這是資料校正不是 schema 變更。這裡是冪等的：已正確的列一筆都不碰，
 * 第二次執行改 0 筆；每一筆校正都寫一列 course_type_config_audit_logs（操作者 system），
 * 後台「異動紀錄」看得到是誰、何時、從多少改成多少。
 */
const { pool } = require('../models/db');

const AUDIT_ACTION = '人數校正';
const AUDIT_NOTE = '人數＝組別（使用者 2026-10-14），開機校正規則上線前的舊設定';

/**
 * @param {import('pg').Pool} db
 * @returns {Promise<Array<{course_type:number, pricing_zone_id:number, before:{min:number,max:number}}>>}
 *   實際被校正的列（已正確者不列出）。
 */
async function normalizeCourseTypeHeadcounts(db = pool) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // 多台實例同時開機時序列化，避免兩邊各寫一份稽核。
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('course-type-headcount-normalize'))`);
    const stale = await client.query(
      `SELECT pricing_zone_id, course_type, min_students, max_students
         FROM course_type_configs
        WHERE course_type >= 1
          AND (min_students IS DISTINCT FROM course_type OR max_students IS DISTINCT FROM course_type)
        ORDER BY pricing_zone_id, course_type
        FOR UPDATE`
    );
    const fixed = [];
    for (const row of stale.rows) {
      const ct = Number(row.course_type);
      await client.query(
        `UPDATE course_type_configs
            SET min_students = $1, max_students = $1, updated_at = NOW()
          WHERE course_type = $1 AND pricing_zone_id IS NOT DISTINCT FROM $2`,
        [ct, row.pricing_zone_id]
      );
      const changes = {};
      if (Number(row.min_students) !== ct) changes.min_students = { before: row.min_students, after: ct };
      if (Number(row.max_students) !== ct) changes.max_students = { before: row.max_students, after: ct };
      await client.query(
        `INSERT INTO course_type_config_audit_logs (course_type, pricing_zone_id, action, by_user, changes, note)
         VALUES ($1, $2, $3, 'system', $4::jsonb, $5)`,
        [ct, row.pricing_zone_id, AUDIT_ACTION, JSON.stringify(changes), AUDIT_NOTE]
      );
      fixed.push({
        course_type: ct,
        pricing_zone_id: row.pricing_zone_id,
        before: { min: row.min_students, max: row.max_students },
      });
    }
    await client.query('COMMIT');
    return fixed;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* 連線已斷，原錯誤較重要 */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { normalizeCourseTypeHeadcounts, AUDIT_ACTION };
