'use strict';
/**
 * 雅正轉：對上的舊課自動轉入（雅正轉_手動建檔與對帳 SPEC v1，YZM-09）。
 *
 * 10/22 的批次只跑一次，之後才註冊的家長，電話對得上也不會自己轉。這裡每晚把「確定沒問題」的包轉進新系統，
 * 建單形狀和 10/22 匯入工具（legacy_import.js）一樣：ABLEPOS:<舊單號>、確認狀態、金額 0、
 * 舊系統每一堂補 legacy_import 紀錄（不計薪資、不發評鑑）、不推播。
 *
 * 只轉 A4 全部條件都符合的包；不新增家長或學員，任何一條不符就跳過、留給櫃台。
 * 同一家長一個交易；交易內鎖舊包列並重查，和櫃台對帳同時發生時只會成功一邊。
 */
const { pool } = require('../models/db');
const { builtMap, normCoach, LEGACY_PAYMENT_METHOD } = require('./yazhengLegacy');
const { parentIdsFor } = require('./familyScope');

const JOB = 'yazheng_auto_transfer';
const EXT_PREFIX = 'ABLEPOS:';
const ACTOR = 'legacy-auto';
const SOURCE = 'legacy_import';
// A3：家長已加入新系統 → 統一到期日（同 10/22 規則 join:2027-10-23）。
const JOINED_EXPIRES = '2027-10-23';
const DEFAULT_LIMIT = 50;

const PHONE_CANON_SQL = (col) => `(CASE WHEN regexp_replace(NORMALIZE(COALESCE(${col},''),NFKC),'\\D','','g') LIKE '8869%'
  THEN '0'||substring(regexp_replace(NORMALIZE(COALESCE(${col},''),NFKC),'\\D','','g') FROM 4)
  ELSE regexp_replace(NORMALIZE(COALESCE(${col},''),NFKC),'\\D','','g') END)`;
const BOUND_SQL = (alias) => `(${alias}.line_uid IS NOT NULL AND ${alias}.line_uid <> ''
  AND ${alias}.line_uid NOT LIKE 'demo:%' AND ${alias}.line_uid NOT LIKE 'DEMOTEST_%')`;

const normStudent = (v) => String(v ?? '').normalize('NFKC').trim().replace(/\s+/g, '').toLowerCase();

/** 課名的折扣標示決定購入係數（擁有者 10/19）：(20%)＝1.2、(50%)＝1.5、沒標示＝1.0。 */
function multiplierFor(courseName) {
  const s = String(courseName || '').normalize('NFKC');
  if (/\(\s*20\s*%\s*\)/.test(s)) return 1.2;
  if (/\(\s*50\s*%\s*\)/.test(s)) return 1.5;
  return 1.0;
}

const enabled = (env = process.env) => String(env.YZ_AUTO_TRANSFER || '').trim().toLowerCase() !== 'off';

class Hold extends Error {
  constructor(code, detail) { super(code); this.code = code; this.detail = detail || null; }
}

/** 便宜的預篩：還沒建過、有剩餘、不是紅燈、手機對得到一位已綁 LINE 的有效家長。真正的檢查在交易裡重做。 */
async function loadCandidates(db) {
  const { rows } = await db.query(
    `SELECT p.seq, m.phone
       FROM yz_legacy_packages p
       JOIN yz_legacy_package_meta m ON m.seq = p.seq
      WHERE COALESCE(p.remaining_sessions, 0) > 0
        AND m.light IS DISTINCT FROM '紅'
        AND m.phone ~ '^09[0-9]{8}$'
        AND EXISTS (SELECT 1 FROM parents pa
                     WHERE ${PHONE_CANON_SQL('pa.phone')} = m.phone AND pa.is_active IS NOT FALSE AND ${BOUND_SQL('pa')})
        AND NOT EXISTS (SELECT 1 FROM admin_enrollments ae
                         WHERE ae.external_order_no = '${EXT_PREFIX}' || p.seq
                           AND COALESCE(ae.status, '') NOT IN ('cancelled', 'refunded'))
        AND NOT EXISTS (SELECT 1 FROM yz_legacy_links l JOIN admin_enrollments ae ON ae.id = l.enrollment_id
                         WHERE l.seq = p.seq AND COALESCE(ae.status, '') NOT IN ('cancelled', 'refunded'))
      ORDER BY m.phone, p.seq::bigint`);
  const families = new Map();
  for (const r of rows) families.set(r.phone, [...(families.get(r.phone) || []), r.seq]);
  return families;
}

async function loadReference(db) {
  const coaches = (await db.query(
    `SELECT id::text, name, is_active, COALESCE(is_placeholder, FALSE) AS is_placeholder FROM coaches`)).rows;
  const venues = (await db.query(`SELECT id::text, is_active FROM venues`)).rows;
  const types = (await db.query(`SELECT course_type FROM course_types`)).rows.map((r) => Number(r.course_type));
  const coachByName = new Map();
  for (const c of coaches) {
    const k = normCoach(c.name);
    if (k) coachByName.set(k, [...(coachByName.get(k) || []), c]);
  }
  return { coachByName, venueById: new Map(venues.map((v) => [v.id, v])), courseTypes: new Set(types) };
}

/** 包本身的檢查（A4 ⑥⑦⑧），不看家長。 */
function validatePackage(pkg, ref) {
  const names = (pkg.student_names || []).map(String).filter((n) => normStudent(n));
  if (!names.length) throw new Hold('NO_STUDENT_NAME');
  if (new Set(names.map(normStudent)).size !== names.length) throw new Hold('DUPLICATE_STUDENT_NAME');
  const type = Number(pkg.course_type);
  if (!ref.courseTypes.has(type)) throw new Hold('COURSE_TYPE_INVALID', String(pkg.course_type));
  if (names.length !== type) throw new Hold('STUDENT_COUNT_MISMATCH', `學員 ${names.length} 位、組別 1 對 ${type}`);
  const coaches = (ref.coachByName.get(normCoach(pkg.coach)) || []).filter((c) => !c.is_placeholder && c.is_active);
  if (coaches.length !== 1) throw new Hold('COACH_NOT_UNIQUE', `${pkg.coach}：${coaches.length} 位`);
  const venue = ref.venueById.get(String(pkg.venue_id || ''));
  if (!venue || venue.is_active === false) throw new Hold('VENUE_INVALID', String(pkg.venue_id || ''));
  const total = Number(pkg.total_sessions);
  const used = Number(pkg.used_sessions);
  const remaining = Number(pkg.remaining_sessions);
  if (!(total > 0) || used + remaining !== total) throw new Hold('COUNT_MISMATCH', `總 ${total}≠用 ${used}+剩 ${remaining}`);
  const uses = Array.isArray(pkg.uses) ? pkg.uses : [];
  if (uses.length !== used || uses.some((u) => !u || Number.isNaN(Date.parse(u.at)))) throw new Hold('USES_MISMATCH');
  if (Number(pkg.expired_sessions) > 0) throw new Hold('HAS_EXPIRED_SESSIONS');
  if (remaining < 1) throw new Hold('NO_REMAINING');
  if (!pkg.purchase_date) throw new Hold('PURCHASE_DATE_MISSING');
  return { names, coach: coaches[0], total, used, remaining, uses };
}

function useCoachId(ref, name, fallbackId) {
  const real = (ref.coachByName.get(normCoach(name)) || []).filter((c) => !c.is_placeholder);
  if (real.length === 1) return real[0].id;
  const active = real.filter((c) => c.is_active);
  return active.length === 1 ? active[0].id : fallbackId;
}

const ymd = (d) => (d instanceof Date ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(d) : String(d).slice(0, 10));

/** 同一支手機（一位家長）的包：一個交易（呼叫端負責 BEGIN／COMMIT）。 */
async function transferFamily(db, phone, seqs, ref, out, budget) {
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`canonical-parent:${phone}`]);
  const hold = (seq, code, detail) => out.push({ seq, action: 'HOLD', code, detail: detail || null });
  const parents = (await db.query(
    `SELECT * FROM parents WHERE ${PHONE_CANON_SQL('phone')} = $1 FOR UPDATE`, [phone])).rows;
  const active = parents.filter((p) => p.is_active !== false);
  if (active.length !== 1) { seqs.forEach((s) => hold(s, 'PHONE_NOT_UNIQUE', `${active.length} 位`)); return; }
  const parent = active[0];
  const bound = (await db.query(`SELECT ${BOUND_SQL('p')} AS ok FROM parents p WHERE p.id = $1`, [parent.id])).rows[0];
  if (!bound || !bound.ok) { seqs.forEach((s) => hold(s, 'PARENT_NOT_BOUND')); return; }
  const scope = await parentIdsFor(parent.id, db);
  const students = (await db.query(
    `SELECT id, name, parent_id, is_active FROM students WHERE parent_id::text = ANY($1::text[]) FOR UPDATE`, [scope])).rows;

  for (const seq of seqs) {
    if (budget.left <= 0) { hold(seq, 'RUN_LIMIT'); continue; }
    const pkg = (await db.query(
      `SELECT p.*, m.venue_id, m.expired_sessions FROM yz_legacy_packages p
         JOIN yz_legacy_package_meta m ON m.seq = p.seq WHERE p.seq = $1 FOR UPDATE OF p`, [seq])).rows[0];
    if (!pkg) { hold(seq, 'PACKAGE_GONE'); continue; }
    if ((await builtMap(db, [seq])).has(seq)) { hold(seq, 'ALREADY_BUILT'); continue; }
    let v;
    try { v = validatePackage(pkg, ref); } catch (err) {
      if (!(err instanceof Hold)) throw err;
      hold(seq, err.code, err.detail); continue;
    }
    const roster = [];
    let miss = null;
    for (const name of v.names) {
      const hits = students.filter((s) => normStudent(s.name) === normStudent(name));
      if (hits.length !== 1) { miss = hits.length ? 'STUDENT_AMBIGUOUS' : 'STUDENT_NOT_FOUND'; break; }
      if (hits[0].is_active === false) { miss = 'STUDENT_INACTIVE'; break; }
      roster.push(hits[0]);
    }
    if (miss) { hold(seq, miss); continue; }
    // A4 ⑨：同一家長＋同一教練有待對帳的舊系統轉移付款單 → 櫃台正在處理，不搶。
    const pending = (await db.query(
      `SELECT id FROM admin_enrollments
        WHERE status = 'pending_payment' AND payment_method = $1 AND coach_id::text = $2
          AND ${PHONE_CANON_SQL('parent_phone')} = $3 LIMIT 1`, [LEGACY_PAYMENT_METHOD, v.coach.id, phone])).rows[0];
    if (pending) { hold(seq, 'COUNTER_PENDING', pending.id); continue; }

    const orderId = `ABL${String(seq).padStart(5, '0')}`;
    if ((await db.query(`SELECT 1 FROM admin_enrollments WHERE id = $1`, [orderId])).rowCount) {
      throw new Error(`訂單編號 ${orderId} 已被其他訂單使用`);
    }
    const purchasedAt = `${ymd(pkg.purchase_date)}T00:00:00+08:00`;
    const mult = multiplierFor(pkg.course_name);
    const notes = `雅正轉｜自動轉入｜單據序號 ${seq}｜學員編號 ${pkg.member_code || '-'}｜原課程 ${pkg.course_name || '-'}｜`
      + `購買 ${ymd(pkg.purchase_date)}｜原購買 ${v.total} 堂、舊系統已用 ${v.used} 堂｜金額 0\n[legacy-auto]`;
    await db.query(
      `INSERT INTO admin_enrollments
         (id, parent_name, parent_phone, students, student_ids, coach, coach_id, venue_id, course_type,
          original_price, final_price, status, submitted_at, total_sessions, used_sessions,
          created_at, updated_at, notes, external_order_no, purchased_pricing_multiplier,
          period_count, period_number, order_kind)
       VALUES ($1,$2,$3,$4::text[],$5::uuid[],$6,$7,$8,$9,0,0,'confirmed',$10::timestamptz,$11,0,
               $10::timestamptz,NOW(),$12,$13,$14,1,1,'standard')`,
      [orderId, parent.name, parent.phone, roster.map((s) => s.name), roster.map((s) => s.id),
        v.coach.name, v.coach.id, pkg.venue_id, Number(pkg.course_type), purchasedAt, v.total,
        notes, EXT_PREFIX + seq, mult]);
    const period = (await db.query(
      `INSERT INTO course_periods
         (coach_id, venue_id, course_type, total_sessions, used_sessions, expires_at, original_price, final_price,
          status, created_at, updated_at, admin_enrollment_id, period_number, is_experience_course,
          checkin_mode, entitlement_state, purchased_pricing_multiplier)
       VALUES ($1,$2,$3,$4,0,$5::date,0,0,'active',$6::timestamptz,NOW(),$7,1,FALSE,'self','ACTIVE',$8)
       RETURNING id`,
      [v.coach.id, pkg.venue_id, Number(pkg.course_type), v.total, JOINED_EXPIRES, purchasedAt, orderId, mult])).rows[0];
    for (const st of roster) {
      await db.query(
        `INSERT INTO course_period_enrollments (course_period_id, student_id, status, enrolled_at)
         VALUES ($1,$2,'active',$3::timestamptz)`, [period.id, st.id, purchasedAt]);
    }
    for (const use of v.uses) {
      const sess = (await db.query(
        `INSERT INTO course_sessions
           (course_period_id, coach_id, scheduled_at, duration_minutes, status, completed_at,
            session_deducted, created_at, updated_at)
         VALUES ($1,$2,$3::timestamptz,60,'completed',$3::timestamptz,TRUE,$3::timestamptz,$3::timestamptz)
         RETURNING id`, [period.id, useCoachId(ref, use.coach, v.coach.id), use.at])).rows[0];
      for (const st of roster) {
        await db.query(
          `INSERT INTO checkin_records
             (course_session_id, student_id, checked_in_by_student_id, is_auto_linked,
              checked_in_source, checked_in_at, attendance_status)
           VALUES ($1,$2,$2,FALSE,$3,$4::timestamptz,'ATTENDED')`, [sess.id, st.id, SOURCE, use.at]);
      }
    }
    // 已用堂數由出席紀錄重算（和 usageSync 同一真相）。
    const used = Number((await db.query(
      `SELECT COUNT(DISTINCT cs.id)::int AS n FROM course_sessions cs
         JOIN checkin_records cr ON cr.course_session_id = cs.id
        WHERE cs.course_period_id = $1 AND cs.status::text NOT LIKE 'cancelled%' AND cr.attendance_status = 'ATTENDED'`,
      [period.id])).rows[0].n);
    if (used !== v.used) throw new Error(`單據 ${seq} 已用推得 ${used}，應為 ${v.used}`);
    await db.query(`UPDATE course_periods SET used_sessions = $2 WHERE id = $1`, [period.id, used]);
    await db.query(`UPDATE admin_enrollments SET used_sessions = $2 WHERE id = $1`, [orderId, used]);
    await db.query(
      `INSERT INTO admin_enrollment_audit_logs (enrollment_id, at, action, by_user, reason)
       VALUES ($1, NOW(), $2, $3, $4)`,
      [orderId, `雅正轉自動轉入：共 ${v.total} 堂、補 ${used} 筆舊上課紀錄、剩 ${v.total - used} 堂`, ACTOR,
        `單據序號 ${seq}；電話與學員都對上新系統已綁 LINE 的家長`]);
    budget.left -= 1;
    out.push({ seq, action: 'TRANSFERRED', order_id: orderId, period_id: period.id, sessions: v.uses.length });
  }
}

/**
 * 跑一次自動轉入。dryRun：整輪在同一個交易裡跑完再 ROLLBACK（結果和真的跑一樣，但不留資料）。
 * 回傳 { transferred: [舊單號], held: { 原因: 筆數 }, errors, rows }；rows 只有舊單號與原因，不含個資。
 */
async function runAutoTransfer({ db = pool, dryRun = false, limit = DEFAULT_LIMIT } = {}) {
  const client = await db.connect();
  const rows = [];
  const budget = { left: Math.max(0, Number(limit) || 0) };
  try {
    const families = await loadCandidates(client);
    const ref = await loadReference(client);
    if (dryRun) await client.query('BEGIN');
    for (const [phone, seqs] of families) {
      if (!dryRun) await client.query('BEGIN');
      await client.query('SAVEPOINT fam');
      const before = rows.length;
      try {
        await transferFamily(client, phone, seqs, ref, rows, budget);
        await client.query('RELEASE SAVEPOINT fam');
        if (!dryRun) await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK TO SAVEPOINT fam');
        if (!dryRun) await client.query('ROLLBACK');
        const undone = rows.splice(before).filter((r) => r.action === 'TRANSFERRED').length;
        budget.left += undone;
        for (const seq of seqs) rows.push({ seq, action: 'ERROR', code: 'ERROR', detail: String(err.message).slice(0, 200) });
      }
    }
    if (dryRun) await client.query('ROLLBACK');
  } finally {
    client.release();
  }
  const held = {};
  for (const r of rows) if (r.action !== 'TRANSFERRED') held[r.code] = (held[r.code] || 0) + 1;
  return {
    dry_run: dryRun,
    transferred: rows.filter((r) => r.action === 'TRANSFERRED').map((r) => r.seq),
    held,
    errors: rows.filter((r) => r.action === 'ERROR').length,
    rows,
  };
}

module.exports = { JOB, JOINED_EXPIRES, enabled, multiplierFor, runAutoTransfer };
