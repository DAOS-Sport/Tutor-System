#!/usr/bin/env node
'use strict';
/**
 * 雅正轉：把舊系統課程包快照（2026-10-22 21:06）寫進 yz_legacy_packages（雅正轉_手動建檔與對帳 SPEC v1，YZM-01）。
 *
 *   DATABASE_URL=... node scripts/yz_load_snapshot.js plan   --data <快照.json>
 *   DATABASE_URL=... node scripts/yz_load_snapshot.js apply  --data <快照.json>
 *   DATABASE_URL=... node scripts/yz_load_snapshot.js verify --data <快照.json>
 *
 * 快照.json：陣列，每筆 { seq, invoice, invoice_candidates[], coach, student_names[], member_code, course_name,
 *   course_type, total_sessions, remaining_sessions, used_sessions, uses[{ at(ISO), coach }],
 *   purchase_date(YYYY-MM-DD), snapshot_at(ISO) }。
 * v1.1（YZM-08）：used_sessions＋uses 是舊系統每一堂，對帳時補成「舊系統轉移」上課紀錄；
 *   檢核 已用＋剩餘＝總堂數、uses 筆數＝已用。
 * 含學員姓名，只放執行者本機，不進 repo。
 *
 * plan：在交易裡完整跑一次再 ROLLBACK，回報會新增／更新／不變幾筆。apply：同樣的寫法但 COMMIT。可重複執行（以 seq upsert）。
 * 只寫 yz_legacy_packages；不碰訂單、連結或任何其他表。
 */
const fs = require('fs');
const path = require('path');
const { Client } = require(path.join(__dirname, '../server/node_modules/pg'));

const [mode, ...rest] = process.argv.slice(2);
const dataPath = rest[rest.indexOf('--data') + 1];
if (!['plan', 'apply', 'verify'].includes(mode) || !rest.includes('--data') || !dataPath) {
  console.error('用法：node scripts/yz_load_snapshot.js plan|apply|verify --data <快照.json>');
  process.exit(2);
}

const FIELDS = ['invoice', 'invoice_candidates', 'coach', 'student_names', 'member_code', 'course_name', 'course_type',
  'total_sessions', 'remaining_sessions', 'used_sessions', 'uses', 'purchase_date', 'snapshot_at'];

function validate(rows) {
  const seen = new Set();
  rows.forEach((r, i) => {
    if (!/^\d{1,10}$/.test(String(r.seq || ''))) throw new Error(`第 ${i + 1} 筆 seq 不正確`);
    if (seen.has(String(r.seq))) throw new Error(`seq 重複：${r.seq}`);
    seen.add(String(r.seq));
    if (!Array.isArray(r.invoice_candidates) || !Array.isArray(r.student_names)) throw new Error(`第 ${i + 1} 筆陣列欄位不正確`);
    if (!r.snapshot_at || Number.isNaN(Date.parse(r.snapshot_at))) throw new Error(`第 ${i + 1} 筆 snapshot_at 不正確`);
    if (!Array.isArray(r.uses) || !Number.isInteger(r.used_sessions) || r.uses.length !== r.used_sessions) {
      throw new Error(`第 ${i + 1} 筆（seq ${r.seq}）uses 筆數和 used_sessions 不一致`);
    }
    if (r.uses.some((u) => !u || Number.isNaN(Date.parse(u.at)) || !/[+-]\d{2}:\d{2}$|Z$/.test(String(u.at)))) {
      throw new Error(`第 ${i + 1} 筆（seq ${r.seq}）uses 的時間要帶時區`);
    }
    if (r.total_sessions != null && r.used_sessions + (Number(r.remaining_sessions) || 0) !== Number(r.total_sessions)) {
      throw new Error(`第 ${i + 1} 筆（seq ${r.seq}）已用＋剩餘≠總堂數`);
    }
  });
}

(async () => {
  const rows = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  validate(rows);
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    if (mode === 'verify') {
      const { rows: [r] } = await db.query(
        `SELECT count(*)::int AS n, COALESCE(sum(remaining_sessions), 0)::int AS remaining,
                COALESCE(sum(used_sessions), 0)::int AS used, COALESCE(sum(jsonb_array_length(uses)), 0)::int AS uses
           FROM yz_legacy_packages
          WHERE seq = ANY($1::text[])`, [rows.map((x) => String(x.seq))]);
      const want = {
        n: rows.length,
        remaining: rows.reduce((s, x) => s + (Number(x.remaining_sessions) || 0), 0),
        used: rows.reduce((s, x) => s + x.used_sessions, 0),
        uses: rows.reduce((s, x) => s + x.uses.length, 0),
      };
      const ok = r.n === want.n && r.remaining === want.remaining && r.used === want.used && r.uses === want.uses;
      console.log(JSON.stringify({ mode, db: r, file: want, ok }));
      process.exitCode = ok ? 0 : 1;
      return;
    }
    await db.query('BEGIN');
    const counts = { inserted: 0, updated: 0, unchanged: 0 };
    for (const r of rows) {
      const values = [String(r.seq), r.invoice || null, r.invoice_candidates, r.coach || null, r.student_names,
        r.member_code || null, r.course_name || null, r.course_type ?? null, r.total_sessions ?? null,
        r.remaining_sessions ?? null, r.used_sessions, JSON.stringify(r.uses), r.purchase_date || null, r.snapshot_at];
      const res = await db.query(
        `INSERT INTO yz_legacy_packages (seq, ${FIELDS.join(', ')})
         VALUES ($1, $2, $3::text[], $4, $5::text[], $6, $7, $8, $9, $10, $11, $12::jsonb, $13::date, $14::timestamptz)
         ON CONFLICT (seq) DO UPDATE SET ${FIELDS.map((f) => `${f} = EXCLUDED.${f}`).join(', ')}, loaded_at = NOW()
           WHERE (${FIELDS.map((f) => `yz_legacy_packages.${f}`).join(', ')}) IS DISTINCT FROM (${FIELDS.map((f) => `EXCLUDED.${f}`).join(', ')})
         RETURNING (xmax = 0) AS inserted`, values);
      if (!res.rowCount) counts.unchanged += 1;
      else if (res.rows[0].inserted) counts.inserted += 1;
      else counts.updated += 1;
    }
    const { rows: [t] } = await db.query(
      `SELECT count(*)::int AS n, COALESCE(sum(remaining_sessions), 0)::int AS remaining,
              COALESCE(sum(used_sessions), 0)::int AS used FROM yz_legacy_packages`);
    await db.query(mode === 'apply' ? 'COMMIT' : 'ROLLBACK');
    console.log(JSON.stringify({ mode, file: rows.length, ...counts, table_after: t }));
  } catch (err) {
    await db.query('ROLLBACK').catch(() => {});
    console.error('FAIL', err.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
})();
