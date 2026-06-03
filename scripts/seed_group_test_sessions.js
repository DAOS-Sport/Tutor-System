/**
 * 測試資料 seed（僅供預覽/開發 DB）：為「團報共用 course_period」建 6 堂 course_sessions，
 * 讓「中途換教練（U2）」可被實際驗證：3 堂已上(completed) + 3 堂未上(confirmed)。
 *
 * 背景：對帳只建 period 不建 sessions（選槽排課前端尚未做），因此團報 period 預設 0 堂，
 * 換教練的「重派未來課堂」會重派 0 堂、看不到效果。本 seed 補出可觀察的課堂。
 *
 * 冪等：先刪掉本 period「由本 seed 建立（availability_slot_id IS NULL）」的課堂再重建，
 * 重跑結果一致；不會動到任何有 slot 綁定的真實課堂。
 *
 * 用法：NODE_PATH=server/node_modules node scripts/seed_group_test_sessions.js
 */
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 鎖定團報共用 period（預覽僅一個團報 period；若有多個，取最新建立者）
    const pr = await client.query(
      `SELECT id, coach_id, venue_id, course_type
         FROM course_periods
        WHERE group_order_id IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 1`
    );
    if (!pr.rowCount) throw new Error('找不到團報 course_period，無法 seed');
    const period = pr.rows[0];
    if (!period.coach_id) throw new Error('團報 period 缺 coach_id');

    // 冪等：清掉本 seed 先前建立的課堂（無 slot 綁定者）
    const del = await client.query(
      `DELETE FROM course_sessions
        WHERE course_period_id = $1 AND availability_slot_id IS NULL`,
      [period.id]
    );

    // 3 堂已上（過去、completed）+ 3 堂未上（未來、confirmed），都掛現任教練
    const past = [-21, -14, -7];   // 天
    const future = [7, 14, 21];
    let made = 0;
    for (const d of past) {
      await client.query(
        `INSERT INTO course_sessions
           (course_period_id, coach_id, scheduled_at, duration_minutes, status, completed_at, created_at, updated_at)
         VALUES ($1, $2, NOW() + ($3 || ' days')::interval, 60, 'completed', NOW() + ($3 || ' days')::interval, NOW(), NOW())`,
        [period.id, period.coach_id, String(d)]
      );
      made++;
    }
    for (const d of future) {
      await client.query(
        `INSERT INTO course_sessions
           (course_period_id, coach_id, scheduled_at, duration_minutes, status, created_at, updated_at)
         VALUES ($1, $2, NOW() + ($3 || ' days')::interval, 60, 'confirmed', NOW(), NOW())`,
        [period.id, period.coach_id, String(d)]
      );
      made++;
    }

    await client.query('COMMIT');
    console.log(`period ${period.id}：刪除舊 seed ${del.rowCount} 堂，新建 ${made} 堂（3 已上 + 3 未上），教練 ${period.coach_id}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('SEED ERROR:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
