/**
 * 課程需求（course_type_configs）排程生效：
 *   把 scheduled_effective_date <= 現在（含日期＋時間）且有 pending_changes 的列，
 *   套用成正式資料、清掉排程、更新 effective_date / updated_at。
 *
 * 由兩處呼叫、皆 idempotent：
 *   1) GET /api/admin/course-types 讀取時（保險：即使 cron 沒跑也會在下次讀取生效）
 *   2) cron（server/cron/index.js）每 5 分鐘跑一次，使排定的「時間」一到即套用
 */
const { pool } = require('../models/db');

// 可被排程套用的白名單欄位（避免 pending_changes JSON 被塞入非預期欄位）。
const EDITABLE = ['label', 'min_students', 'max_students', 'is_active', 'base_price', 'data_group'];

async function applyDueScheduledCourseTypeChanges(db = pool) {
  const due = await db.query(
    `SELECT course_type, pending_changes
       FROM course_type_configs
      WHERE pending_changes IS NOT NULL
        AND scheduled_effective_date IS NOT NULL
        AND scheduled_effective_date <= NOW()`
  );
  let applied = 0;
  for (const row of due.rows) {
    const pc = row.pending_changes || {};
    const sets = [];
    const vals = [row.course_type];
    for (const k of EDITABLE) {
      if (pc[k] !== undefined) { vals.push(pc[k]); sets.push(`${k} = $${vals.length}`); }
    }
    // 即使 pending 沒有任何白名單欄位，也要把排程清掉、生效起日推進，避免卡住。
    // scheduled_* 為 timestamptz、effective_* 為 date → 取台北日期；迄日由 scheduled_effective_until 帶入。
    sets.push("effective_date = (scheduled_effective_date AT TIME ZONE 'Asia/Taipei')::date");
    sets.push("effective_until = CASE WHEN scheduled_effective_until IS NOT NULL THEN (scheduled_effective_until AT TIME ZONE 'Asia/Taipei')::date ELSE effective_until END");
    sets.push('scheduled_effective_date = NULL');
    sets.push('scheduled_effective_until = NULL');
    sets.push('pending_changes = NULL');
    sets.push('updated_at = NOW()');
    const r = await db.query(
      `UPDATE course_type_configs SET ${sets.join(', ')} WHERE course_type = $1
        RETURNING effective_date, effective_until`, vals);
    // label 變更 → 同步未被覆寫的課程介紹 title（與 PATCH 立即生效行為一致）。
    if (pc.label !== undefined) {
      await db.query(
        `UPDATE admin_course_intros SET title=$2, updated_at=NOW() WHERE course_type=$1 AND title_overridden=FALSE`,
        [row.course_type, pc.label]
      );
    }
    // 編輯軌跡（排程套用，操作者 system）— best-effort，不可因軌跡失敗而擋住排程套用。
    try {
      const changes = {};
      for (const k of EDITABLE) if (pc[k] !== undefined) changes[k] = { after: pc[k] };
      const eff = r.rows[0] || {};
      await db.query(
        `INSERT INTO course_type_config_audit_logs (course_type, action, by_user, changes, note)
         VALUES ($1, '排程套用', 'system', $2::jsonb, $3)`,
        [row.course_type, Object.keys(changes).length ? JSON.stringify(changes) : null,
         `套用排程（生效 ${eff.effective_date || ''}${eff.effective_until ? ' ～ ' + eff.effective_until : ''}）`]
      );
    } catch (e) { console.warn('[course-types apply audit]', e.message); }
    applied += 1;
  }
  return applied;
}

module.exports = { applyDueScheduledCourseTypeChanges, EDITABLE };
