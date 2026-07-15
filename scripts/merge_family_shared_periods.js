#!/usr/bin/env node
'use strict';

/**
 * 家庭共班既有資料修復 — 合併「同批同期」被錯誤拆成多個的 course_periods。
 *
 * 背景（migration 029 / U12）：
 *   家長端「同一家長多位小孩」報名一對二以上課程時，訂單按「學員 × 期數」拆成
 *   多筆 admin_enrollments（共用 enrollment_batch_id）。舊版開通橋替每筆各自建
 *   course_period（每位小孩各 6 堂），把「一期 6 堂的共班」膨脹成 N 期 6N 堂。
 *   新版開通橋已改為共用一個 period；本 script 修復既有已開通的錯誤資料：
 *   同 (enrollment_batch_id, period_number) 且課型 max_students > 1 的多個 periods
 *   → 併入最早建立的那一個（搬移全部子資料後刪除其餘）。
 *
 * 用法：
 *   node scripts/merge_family_shared_periods.js                    # dry-run（預設，只報告）
 *   node scripts/merge_family_shared_periods.js --execute          # 開發庫執行
 *   node scripts/merge_family_shared_periods.js --execute --production-confirmed
 *
 * 安全機制：
 *   - 每個 batch+period 群組獨立 transaction；任一步失敗只跳過該群組，不影響其他。
 *   - 群組內 periods 的 coach/venue/course_type 不一致（例如其中一位小孩已被轉教練）
 *     → 跳過並列入報告，交由人工判斷。
 *   - manual_lesson_deductions / transfer_records 為 ON DELETE RESTRICT；搬移後仍有
 *     殘留即 abort 該群組（絕不刪除有帳務紀錄依附的 period）。
 */

const { Client } = require('../server/node_modules/pg');
const {
  sanitizedDatabaseIdentity,
  isDevelopmentDatabase,
} = require('./preflight_release_20260712');

// 已知引用 course_periods 的子表（與 server/bootstrap/coreSchema.js 對齊）。
// 發現未知引用表且有資料依附時 abort 該群組，避免 CASCADE 吃掉沒被搬移的資料。
const KNOWN_CHILD_TABLES = new Set([
  'course_period_enrollments',
  'course_sessions',
  'manual_lesson_deductions',
  'chat_rooms',
  'lesson_plans',
  'session_records',
  'course_evaluations',
  'promotion_usages',
  'transfer_records',
]);

async function findReferencingTables(client) {
  const r = await client.query(`
    SELECT DISTINCT c.conrelid::regclass::text AS table_name,
           a.attname AS column_name
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
     WHERE c.contype = 'f'
       AND c.confrelid = 'course_periods'::regclass`);
  return r.rows;
}

async function findGroups(client) {
  const r = await client.query(`
    SELECT ae.enrollment_batch_id AS batch_id,
           COALESCE(ae.period_number, 1) AS period_number,
           array_agg(DISTINCT cp.id::text ORDER BY cp.id::text) AS period_ids,
           MIN(ae.course_type) AS course_type
      FROM course_periods cp
      JOIN admin_enrollments ae ON ae.id = cp.admin_enrollment_id
      JOIN course_type_configs ctc ON ctc.course_type = ae.course_type
     WHERE cp.group_order_id IS NULL
       AND ae.group_order_id IS NULL
       AND ae.enrollment_batch_id IS NOT NULL
       AND ctc.max_students > 1
     GROUP BY 1, 2
    HAVING COUNT(DISTINCT cp.id) > 1
     ORDER BY 1, 2`);
  return r.rows;
}

async function mergeGroup(client, group, { execute, unknownRefs }) {
  const report = {
    batch_id: group.batch_id,
    period_number: group.period_number,
    course_type: group.course_type,
    period_ids: group.period_ids,
  };
  await client.query('BEGIN');
  try {
    const periods = await client.query(
      `SELECT id, coach_id, venue_id, course_type, total_sessions, created_at
         FROM course_periods WHERE id = ANY($1::uuid[])
        ORDER BY created_at, id
        FOR UPDATE`,
      [group.period_ids]
    );
    if (periods.rowCount < 2) {
      await client.query('ROLLBACK');
      return { ...report, status: 'SKIPPED', reason: '群組已不足 2 個 period（可能已被修復）' };
    }
    const keep = periods.rows[0];
    const losers = periods.rows.slice(1).map((row) => row.id);
    report.keep_period_id = keep.id;
    report.merged_period_ids = losers;

    // 一致性守門：教練/場館/課型不一致（如其中一位小孩已被轉教練）→ 人工處理
    const inconsistent = periods.rows.some((row) =>
      row.coach_id !== keep.coach_id || row.venue_id !== keep.venue_id || row.course_type !== keep.course_type);
    if (inconsistent) {
      await client.query('ROLLBACK');
      return { ...report, status: 'SKIPPED', reason: 'periods 教練/場館/課型不一致，需人工確認後再合併' };
    }

    // 未知子表守門
    for (const ref of unknownRefs) {
      const cnt = await client.query(
        `SELECT COUNT(*)::int AS n FROM ${ref.table_name} WHERE ${ref.column_name} = ANY($1::uuid[])`,
        [losers]
      );
      if (cnt.rows[0].n > 0) {
        await client.query('ROLLBACK');
        return {
          ...report, status: 'SKIPPED',
          reason: `未知子表 ${ref.table_name}.${ref.column_name} 有 ${cnt.rows[0].n} 筆資料依附，需先擴充本 script`,
        };
      }
    }

    // 本期有效兄弟訂單（金額加總 + anchor）
    const siblings = await client.query(
      `SELECT id, original_price, final_price FROM admin_enrollments
        WHERE enrollment_batch_id = $1 AND COALESCE(period_number, 1) = $2
          AND group_order_id IS NULL AND status NOT IN ('cancelled','refunded')
        ORDER BY submitted_at, id`,
      [group.batch_id, group.period_number]
    );
    if (!siblings.rowCount) {
      await client.query('ROLLBACK');
      return { ...report, status: 'SKIPPED', reason: '找不到有效兄弟訂單（全數取消/退費？），不合併' };
    }

    // ── 搬移子資料 → keep ──────────────────────────────────────────
    // 學員掛載（UNIQUE(course_period_id, student_id)）
    await client.query(
      `INSERT INTO course_period_enrollments (course_period_id, student_id, status, enrolled_at)
       SELECT $1, student_id, status, enrolled_at
         FROM course_period_enrollments WHERE course_period_id = ANY($2::uuid[])
       ON CONFLICT (course_period_id, student_id) DO NOTHING`,
      [keep.id, losers]
    );
    await client.query(
      `DELETE FROM course_period_enrollments WHERE course_period_id = ANY($1::uuid[])`,
      [losers]
    );
    // 已排課堂（簽到紀錄掛在 session 底下，自動跟著走）
    const movedSessions = await client.query(
      `UPDATE course_sessions SET course_period_id = $1, updated_at = NOW()
        WHERE course_period_id = ANY($2::uuid[])`,
      [keep.id, losers]
    );
    report.moved_sessions = movedSessions.rowCount;
    await client.query(
      `UPDATE session_records SET course_period_id = $1, updated_at = NOW()
        WHERE course_period_id = ANY($2::uuid[])`,
      [keep.id, losers]
    );
    // 手動扣課（RESTRICT + UNIQUE(course_period_id, request_id)）：搬得動就搬，殘留即 abort
    await client.query(
      `UPDATE manual_lesson_deductions mld SET course_period_id = $1
        WHERE mld.course_period_id = ANY($2::uuid[])
          AND NOT EXISTS (SELECT 1 FROM manual_lesson_deductions x
                           WHERE x.course_period_id = $1 AND x.request_id = mld.request_id)`,
      [keep.id, losers]
    );
    const leftoverDeductions = await client.query(
      `SELECT COUNT(*)::int AS n FROM manual_lesson_deductions WHERE course_period_id = ANY($1::uuid[])`,
      [losers]
    );
    if (leftoverDeductions.rows[0].n > 0) {
      await client.query('ROLLBACK');
      return { ...report, status: 'SKIPPED', reason: `manual_lesson_deductions 有 ${leftoverDeductions.rows[0].n} 筆 request_id 撞號無法搬移，需人工處理` };
    }
    await client.query(
      `UPDATE transfer_records SET course_period_id = $1 WHERE course_period_id = ANY($2::uuid[])`,
      [keep.id, losers]
    );
    await client.query(
      `UPDATE promotion_usages SET course_period_id = $1 WHERE course_period_id = ANY($2::uuid[])`,
      [keep.id, losers]
    );
    // 課前規劃（UNIQUE(course_period_id)）：keep 沒有時收編最早一份；其餘隨 period 刪除
    const keepPlan = await client.query(
      `SELECT id FROM lesson_plans WHERE course_period_id = $1 LIMIT 1`, [keep.id]
    );
    if (!keepPlan.rowCount) {
      await client.query(
        `UPDATE lesson_plans SET course_period_id = $1, updated_at = NOW()
          WHERE id = (SELECT id FROM lesson_plans
                       WHERE course_period_id = ANY($2::uuid[])
                       ORDER BY created_at, id LIMIT 1)`,
        [keep.id, losers]
      );
    }
    const droppedPlans = await client.query(
      `SELECT COUNT(*)::int AS n FROM lesson_plans WHERE course_period_id = ANY($1::uuid[])`, [losers]
    );
    report.dropped_lesson_plans = droppedPlans.rows[0].n;
    // 期末評鑑（UNIQUE(course_period_id, parent_id)）：搬不動的（同家長重複）隨 period 刪除
    await client.query(
      `UPDATE course_evaluations ce SET course_period_id = $1
        WHERE ce.course_period_id = ANY($2::uuid[])
          AND NOT EXISTS (SELECT 1 FROM course_evaluations x
                           WHERE x.course_period_id = $1 AND x.parent_id = ce.parent_id)`,
      [keep.id, losers]
    );
    // 聊天室（UNIQUE(course_period_id)）：keep 沒房間時收編最早一間；其餘房間的
    // 訊息/警示併入 keep 房間後刪除空房
    let keepRoom = await client.query(
      `SELECT id FROM chat_rooms WHERE course_period_id = $1 LIMIT 1`, [keep.id]
    );
    if (!keepRoom.rowCount) {
      await client.query(
        `UPDATE chat_rooms SET course_period_id = $1
          WHERE id = (SELECT id FROM chat_rooms
                       WHERE course_period_id = ANY($2::uuid[])
                       ORDER BY created_at, id LIMIT 1)`,
        [keep.id, losers]
      );
      keepRoom = await client.query(
        `SELECT id FROM chat_rooms WHERE course_period_id = $1 LIMIT 1`, [keep.id]
      );
    }
    if (keepRoom.rowCount) {
      const keepRoomId = keepRoom.rows[0].id;
      await client.query(
        `UPDATE messages SET chat_room_id = $1
          WHERE chat_room_id IN (SELECT id FROM chat_rooms WHERE course_period_id = ANY($2::uuid[]))`,
        [keepRoomId, losers]
      );
      await client.query(
        `UPDATE keyword_alerts SET chat_room_id = $1
          WHERE chat_room_id IN (SELECT id FROM chat_rooms WHERE course_period_id = ANY($2::uuid[]))`,
        [keepRoomId, losers]
      );
      await client.query(
        `DELETE FROM chat_rooms WHERE course_period_id = ANY($1::uuid[])`, [losers]
      );
    }

    // ── 更新 keep 主檔 → 刪除其餘 periods ─────────────────────────
    const originalSum = siblings.rows.reduce((sum, row) => sum + (Number(row.original_price) || 0), 0);
    const finalSum = siblings.rows.reduce((sum, row) => sum + (Number(row.final_price) || 0), 0);
    await client.query(
      `UPDATE course_periods
          SET enrollment_batch_id = $2, period_number = $3, admin_enrollment_id = $4,
              original_price = $5, final_price = $6, updated_at = NOW()
        WHERE id = $1`,
      [keep.id, group.batch_id, group.period_number, siblings.rows[0].id, originalSum, finalSum]
    );
    const del = await client.query(
      `DELETE FROM course_periods WHERE id = ANY($1::uuid[])`, [losers]
    );
    report.deleted_periods = del.rowCount;

    // 超訂警示：合併後已排（未取消）課堂 > 購買堂數 → 需營運端與家長協調
    const booked = await client.query(
      `SELECT COUNT(*)::int AS n FROM course_sessions
        WHERE course_period_id = $1 AND status NOT IN ('cancelled_normal','cancelled_penalty')`,
      [keep.id]
    );
    report.booked_sessions = booked.rows[0].n;
    report.total_sessions = keep.total_sessions;
    if (booked.rows[0].n > keep.total_sessions) {
      report.warning = `合併後已排課堂 ${booked.rows[0].n} > 購買堂數 ${keep.total_sessions}，請與家長確認取消多排的課`;
    }

    await client.query(execute ? 'COMMIT' : 'ROLLBACK');
    return { ...report, status: execute ? 'MERGED' : 'DRY_RUN_OK' };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    return { ...report, status: 'FAILED', error_code: error.code || null, reason: error.message };
  }
}

async function main() {
  const execute = process.argv.includes('--execute');
  const productionConfirmed = process.argv.includes('--production-confirmed');
  const connectionString = process.env.DATABASE_URL;
  const database = sanitizedDatabaseIdentity(connectionString || '');
  const output = { script: 'merge_family_shared_periods', mode: execute ? 'execute' : 'dry-run', database };

  if (!connectionString) {
    console.log(JSON.stringify({ ...output, status: 'BLOCKED', reason: 'DATABASE_URL is missing' }, null, 2));
    process.exitCode = 2;
    return;
  }
  if (!isDevelopmentDatabase(database) && execute && !productionConfirmed) {
    console.log(JSON.stringify({
      ...output, status: 'BLOCKED',
      reason: 'non-development execution requires --production-confirmed（請先跑 dry-run 並確認報告）',
    }, null, 2));
    process.exitCode = 2;
    return;
  }

  const client = new Client({ connectionString });
  try {
    await client.connect();
    // schema 前置檢查：migration 029（enrollment_batch_id 欄）必須已套用
    const col = await client.query(`
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'course_periods' AND column_name = 'enrollment_batch_id'`);
    if (!col.rowCount) {
      console.log(JSON.stringify({
        ...output, status: 'BLOCKED',
        reason: 'course_periods.enrollment_batch_id 不存在，請先套用 migration 029 或重啟服務跑 bootstrap',
      }, null, 2));
      process.exitCode = 2;
      return;
    }
    const refs = await findReferencingTables(client);
    const unknownRefs = refs.filter((ref) => !KNOWN_CHILD_TABLES.has(ref.table_name));
    const groups = await findGroups(client);
    const results = [];
    for (const group of groups) {
      results.push(await mergeGroup(client, group, { execute, unknownRefs }));
    }
    const summary = results.reduce((acc, row) => {
      acc[row.status] = (acc[row.status] || 0) + 1;
      return acc;
    }, {});
    console.log(JSON.stringify({
      ...output,
      status: 'DONE',
      groups_found: groups.length,
      summary,
      results,
    }, null, 2));
    if (results.some((row) => row.status === 'FAILED')) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({ ...output, status: 'BLOCKED', reason: error.message }, null, 2));
    process.exitCode = 2;
  } finally {
    await client.end().catch(() => {});
  }
}

main();
