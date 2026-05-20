#!/usr/bin/env node
/**
 * Task #91 一次性健檢腳本
 * 找出並修復 admin_staff ↔ coaches 之間的孤兒：
 *
 *   A) staff role='coach' 但 coaches 沒對應列 → 自動補一筆（is_active=staff.active）
 *   B) coaches 在但 admin_staff 沒對應 row → 列出（不自動建，因為缺角色/場館語意；
 *      由 operator 在後台手動建員工或下架該 coach）
 *   C) 兩邊 name / phone / is_active / is_senior / pricing_multiplier 不一致
 *      → 以 admin_staff 為單一事實來源，UPDATE coaches 對齊
 *
 *  用法：
 *    node scripts/heal-coach-staff-orphans.js          # dry-run，只列出
 *    node scripts/heal-coach-staff-orphans.js --apply  # 實際寫入
 */
const path = require('path');
// 環境變數已由 Replit Secrets 或外層 shell 注入；不依賴 dotenv（server 也沒裝）
const { pool } = require(path.join(__dirname, '..', 'server', 'models', 'db'));

const APPLY = process.argv.includes('--apply');

async function main() {
  const out = { staffMissingCoach: [], coachMissingStaff: [], drift: [], fixed: 0 };

  // A) staff role=coach 但無 coaches row
  const a = await pool.query(`
    SELECT s.id, s.name, s.phone, s.active, s.is_senior, s.multiplier, s.venue_id
      FROM admin_staff s
      LEFT JOIN coaches c ON c.ragic_employee_id = s.id
     WHERE s.role = 'coach' AND c.id IS NULL`);
  out.staffMissingCoach = a.rows;

  if (APPLY) {
    for (const s of a.rows) {
      if (!s.phone) { console.warn(`  ⤷ skip ${s.id}（無手機，無法建 coach）`); continue; }
      await pool.query(
        `INSERT INTO coaches
           (ragic_employee_id, name, phone, email, is_senior, pricing_multiplier,
            specialties, bio_rich_text, is_active, intro_review_status, active_overridden_at)
         VALUES ($1,$2,$3,'',$4,$5,ARRAY[]::text[],'',$6,'draft',NOW())
         ON CONFLICT (ragic_employee_id) DO NOTHING
         RETURNING id`,
        [s.id, s.name, s.phone, !!s.is_senior, Number(s.multiplier || 1), !!s.active]
      );
      const cv = await pool.query(`SELECT id FROM coaches WHERE ragic_employee_id = $1`, [s.id]);
      if (cv.rows[0] && s.venue_id) {
        await pool.query(
          `INSERT INTO coach_venues (coach_id, venue_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [cv.rows[0].id, s.venue_id]);
      }
      out.fixed += 1;
    }
  }

  // B) coach 在但 staff 沒
  const b = await pool.query(`
    SELECT c.id AS coach_uuid, c.ragic_employee_id, c.name, c.phone, c.is_active
      FROM coaches c
      LEFT JOIN admin_staff s ON s.id = c.ragic_employee_id
     WHERE s.id IS NULL`);
  out.coachMissingStaff = b.rows;

  // C) 姓名 / 手機 / 在職 / is_senior / multiplier drift
  const c = await pool.query(`
    SELECT s.id, s.name AS s_name, c.name AS c_name, s.phone AS s_phone, c.phone AS c_phone,
           s.active AS s_active, c.is_active AS c_active,
           s.is_senior AS s_senior, c.is_senior AS c_senior,
           s.multiplier AS s_mult, c.pricing_multiplier AS c_mult
      FROM admin_staff s
      JOIN coaches c ON c.ragic_employee_id = s.id
     WHERE s.role = 'coach'
       AND ( s.name <> c.name OR COALESCE(s.phone,'') <> COALESCE(c.phone,'')
          OR s.active <> c.is_active OR COALESCE(s.is_senior,FALSE) <> COALESCE(c.is_senior,FALSE)
          OR ROUND(s.multiplier::numeric, 2) <> ROUND(c.pricing_multiplier::numeric, 2) )`);
  out.drift = c.rows;

  if (APPLY) {
    for (const r of c.rows) {
      await pool.query(
        `UPDATE coaches SET name=$2, phone=$3, is_active=$4, is_senior=$5,
                pricing_multiplier=$6, updated_at=NOW()
          WHERE ragic_employee_id=$1`,
        [r.id, r.s_name, r.s_phone, !!r.s_active, !!r.s_senior, Number(r.s_mult || 1)]
      );
      out.fixed += 1;
    }
  }

  console.log(JSON.stringify({ apply: APPLY, ...out }, null, 2));
  console.log(`\n摘要：staffMissingCoach=${out.staffMissingCoach.length}  coachMissingStaff=${out.coachMissingStaff.length}  drift=${out.drift.length}  fixed=${out.fixed}`);
  if (!APPLY && (out.staffMissingCoach.length + out.drift.length) > 0) {
    console.log('\n  → 加上 --apply 旗標即可實際修復（B 類 coachMissingStaff 不自動處理，請於後台手動建員工或下架該 coach）');
  }
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
