'use strict';
/**
 * 雅正轉：手動建檔＋待對帳比對（雅正轉_手動建檔與對帳 SPEC v1，YZM-01／03／04／05）。
 *
 * 家長資料太亂、發票號碼也不唯一（假號碼、打錯、一次結帳買好幾包），所以舊課程包由櫃台手動建檔。
 * 櫃台在待對帳打「舊發票號碼」，這裡用「舊發票＋這張付款單的教練」到 21:06 快照找課程包，
 * 對帳通過時把舊單號記進 yz_legacy_links，兩邊用舊單號精準核對、也擋重複建檔。
 *
 * 「已經建過」＝有連結到一筆還有效（非取消／退費）的訂單，或匯入工具建的 ABLEPOS:<舊單號> 訂單還有效。
 * 訂單取消或退費後自動變回可建，不需要另外清理。
 */

const LEGACY_PAYMENT_METHOD = '舊系統轉移';
const VOID_STATUSES = ['cancelled', 'refunded'];

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS yz_legacy_packages (
  seq                 TEXT PRIMARY KEY,
  invoice             TEXT,
  invoice_candidates  TEXT[] NOT NULL DEFAULT '{}',
  coach               TEXT,
  student_names       TEXT[] NOT NULL DEFAULT '{}',
  member_code         TEXT,
  course_name         TEXT,
  course_type         INTEGER,
  total_sessions      INTEGER,
  remaining_sessions  INTEGER,
  used_sessions       INTEGER,
  uses                JSONB NOT NULL DEFAULT '[]'::jsonb,
  purchase_date       DATE,
  snapshot_at         TIMESTAMPTZ NOT NULL,
  loaded_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- v1.1（YZM-08）：舊系統已用堂數與每一堂的時間／教練（[{ at, coach }]），對帳時補成「舊系統轉移」上課紀錄。
ALTER TABLE yz_legacy_packages ADD COLUMN IF NOT EXISTS used_sessions INTEGER;
ALTER TABLE yz_legacy_packages ADD COLUMN IF NOT EXISTS uses JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS idx_yz_legacy_packages_invoice ON yz_legacy_packages (invoice);
CREATE TABLE IF NOT EXISTS yz_legacy_links (
  seq              TEXT NOT NULL REFERENCES yz_legacy_packages (seq),
  enrollment_id    TEXT NOT NULL REFERENCES admin_enrollments (id) ON DELETE CASCADE,
  checkout_id      UUID,
  invoice_entered  TEXT,
  linked_by        TEXT,
  linked_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (seq, enrollment_id)
);
CREATE INDEX IF NOT EXISTS idx_yz_legacy_links_enrollment ON yz_legacy_links (enrollment_id);
-- YZM-09：自動轉入要用、快照表沒有的欄位（10/22 快照的手機、建議場館、燈號、過期堂數）。含個資，只從本機檔載入。
CREATE TABLE IF NOT EXISTS yz_legacy_package_meta (
  seq               TEXT PRIMARY KEY REFERENCES yz_legacy_packages (seq),
  phone             TEXT,
  venue_id          TEXT,
  light             TEXT,
  expired_sessions  INTEGER NOT NULL DEFAULT 0,
  loaded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_yz_legacy_package_meta_phone ON yz_legacy_package_meta (phone);
`;

async function ensureSchema(db) {
  await db.query(SCHEMA_SQL);
}

const normInvoice = (v) => String(v ?? '').normalize('NFKC').replace(/\s+/g, '').toUpperCase();
const normCoach = (v) => String(v ?? '').normalize('NFKC').replace(/[(（][^)）]*[)）]/g, '').replace(/\s+/g, '');
const normName = (v) => String(v ?? '').normalize('NFKC').replace(/\s+/g, '');
const parseSeqs = (v) => [...new Set((Array.isArray(v) ? v : String(v ?? '').split(/[\s,，、;；]+/))
  .map((s) => String(s).trim()).filter((s) => /^\d{1,10}$/.test(s)))];

/** 付款單的子訂單全部是「舊系統轉移」才算；混了別種回 'mixed'（正常不會發生：一次手動建檔＝一張付款單）。 */
function legacyKind(children) {
  const legacy = children.filter((r) => String(r.payment_method || '').trim() === LEGACY_PAYMENT_METHOD).length;
  if (!legacy) return null;
  return legacy === children.length ? 'legacy' : 'mixed';
}

/** 哪些舊單號已經建過（連到有效訂單）。回傳 Map(seq → { enrollment_id, at, source })。 */
async function builtMap(db, seqs) {
  if (!seqs.length) return new Map();
  const { rows } = await db.query(
    `SELECT l.seq, l.enrollment_id, l.linked_at AS at, 'manual' AS source
       FROM yz_legacy_links l JOIN admin_enrollments ae ON ae.id = l.enrollment_id
      WHERE l.seq = ANY($1::text[]) AND COALESCE(ae.status, '') <> ALL($2::text[])
     UNION ALL
     SELECT substring(ae.external_order_no FROM 9), ae.id, ae.created_at, 'import'
       FROM admin_enrollments ae
      WHERE ae.external_order_no = ANY($3::text[]) AND COALESCE(ae.status, '') <> ALL($2::text[])
      ORDER BY 3`,
    [seqs, VOID_STATUSES, seqs.map((s) => `ABLEPOS:${s}`)]
  );
  const out = new Map();
  for (const r of rows) if (!out.has(r.seq)) out.set(r.seq, { enrollment_id: r.enrollment_id, at: r.at, source: r.source });
  return out;
}

const usedOf = (p) => (p.used_sessions != null ? Number(p.used_sessions)
  : Math.max(0, (Number(p.total_sessions) || 0) - (Number(p.remaining_sessions) || 0)));

function view(p, built) {
  const b = built.get(p.seq);
  return {
    seq: p.seq,
    invoice: p.invoice || null,
    coach: p.coach || null,
    students: p.student_names || [],
    course_name: p.course_name || null,
    course_type: p.course_type,
    total_sessions: p.total_sessions,
    remaining_sessions: p.remaining_sessions,
    used_sessions: usedOf(p),
    built: b ? { enrollment_id: b.enrollment_id, at: b.at, source: b.source } : null,
  };
}

/**
 * 比對（YZM-05）。children：付款單子訂單（要有 coach）。input：{ invoice } 或 { seqs }（改打舊單號）。
 * 回傳 { status, packages, options, selectable, remaining_total }：
 *   MATCH       對到 1 包，或同一學員的好幾包（一次買多包）→ 全部轉入
 *   CHOOSE      同發票＋同教練但不同學員 → options 讓櫃台點選（可多選）
 *   ALL_BUILT   對到的都已經建過
 *   NOT_FOUND   找不到（發票不在快照、或教練對不上）
 *   SEQS        改打舊單號模式：逐一列出，找不到或已建過的會標出來
 */
async function matchLegacy(db, children, input, { lock = false } = {}) {
  const coaches = new Set(children.map((c) => normCoach(c.coach)).filter(Boolean));
  const seqMode = input && input.seqs != null && parseSeqs(input.seqs).length > 0;
  let rows;
  if (seqMode) {
    const seqs = parseSeqs(input.seqs);
    rows = (await db.query(
      `SELECT * FROM yz_legacy_packages WHERE seq = ANY($1::text[]) ORDER BY seq${lock ? ' FOR UPDATE' : ''}`, [seqs])).rows;
    const built = await builtMap(db, seqs);
    const found = new Set(rows.map((r) => r.seq));
    const packages = rows.map((r) => view(r, built));
    const missing = seqs.filter((s) => !found.has(s));
    const selectable = packages.filter((p) => !p.built).map((p) => p.seq);
    return {
      status: 'SEQS', mode: 'seqs', packages, missing, selectable,
      ok: missing.length === 0 && selectable.length === seqs.length,
      remaining_total: packages.filter((p) => !p.built).reduce((s, p) => s + (p.remaining_sessions || 0), 0),
    };
  }
  const invoice = normInvoice(input && input.invoice);
  if (!invoice) return { status: 'NOT_FOUND', mode: 'invoice', reason: 'EMPTY', packages: [], selectable: [], ok: false };
  const all = (await db.query(
    `SELECT * FROM yz_legacy_packages
      WHERE invoice = $1 OR $1 = ANY(invoice_candidates)
      ORDER BY seq${lock ? ' FOR UPDATE' : ''}`, [invoice])).rows;
  const sameCoach = all.filter((r) => coaches.has(normCoach(r.coach)));
  if (!sameCoach.length) {
    return {
      status: 'NOT_FOUND', mode: 'invoice', reason: all.length ? 'COACH_MISMATCH' : 'INVOICE_NOT_FOUND',
      other_coaches: [...new Set(all.map((r) => r.coach).filter(Boolean))], packages: [], selectable: [], ok: false,
    };
  }
  const built = await builtMap(db, sameCoach.map((r) => r.seq));
  const packages = sameCoach.map((r) => view(r, built));
  const open = packages.filter((p) => !p.built);
  if (!open.length) return { status: 'ALL_BUILT', mode: 'invoice', packages, selectable: [], ok: false };
  const byStudents = new Map();
  for (const p of open) {
    const key = p.students.map(normName).sort().join('、');
    byStudents.set(key, [...(byStudents.get(key) || []), p]);
  }
  const options = [...byStudents.values()].map((ps) => ({
    students: ps[0].students, seqs: ps.map((p) => p.seq),
    remaining_total: ps.reduce((s, p) => s + (p.remaining_sessions || 0), 0),
  }));
  const remaining = open.reduce((s, p) => s + (p.remaining_sessions || 0), 0);
  if (options.length === 1) {
    return { status: 'MATCH', mode: 'invoice', packages, options, selectable: options[0].seqs, ok: true, remaining_total: remaining };
  }
  return { status: 'CHOOSE', mode: 'invoice', packages, options, selectable: open.map((p) => p.seq), ok: false, remaining_total: remaining };
}

/**
 * 對帳送出時決定最終要連結的舊單號（伺服器重新比對，不相信前端）。
 * legacy：{ invoice, seqs?（CHOOSE 時點選的、或改打舊單號模式）, mode? }
 * 回傳 { seqs, match } 或 { error, code }。
 */
async function resolveForReconcile(db, children, legacy) {
  const mode = legacy && legacy.mode === 'seqs' ? 'seqs' : 'invoice';
  const picked = parseSeqs(legacy && legacy.seqs);
  const match = await matchLegacy(db, children, mode === 'seqs' ? { seqs: picked } : { invoice: legacy && legacy.invoice }, { lock: true });
  if (mode === 'seqs') {
    if (!picked.length) return { error: '請輸入舊單號', code: 'LEGACY_SEQS_REQUIRED' };
    if (match.missing.length) return { error: `快照裡找不到舊單 ${match.missing.join('、')}`, code: 'LEGACY_SEQ_NOT_FOUND' };
    const built = match.packages.filter((p) => p.built);
    if (built.length) return { error: `舊單 ${built.map((p) => p.seq).join('、')} 已經建過`, code: 'LEGACY_ALREADY_BUILT' };
    return { seqs: picked, match };
  }
  if (match.status === 'NOT_FOUND') {
    return {
      error: match.reason === 'COACH_MISMATCH' ? '這張舊發票的課程包不是這位教練的，請確認教練或改打舊單號' : '快照裡找不到這張舊發票，請回 GPT 網站確認或改打舊單號',
      code: match.reason === 'COACH_MISMATCH' ? 'LEGACY_COACH_MISMATCH' : 'LEGACY_INVOICE_NOT_FOUND',
    };
  }
  if (match.status === 'ALL_BUILT') return { error: '這張舊發票對到的課程包都已經建過', code: 'LEGACY_ALREADY_BUILT' };
  if (match.status === 'MATCH') {
    if (picked.length && !picked.every((s) => match.selectable.includes(s))) {
      return { error: '選擇的舊單號不在這張發票的可轉課程包裡', code: 'LEGACY_SELECTION_INVALID' };
    }
    return { seqs: picked.length ? picked : match.selectable, match };
  }
  if (!picked.length) return { error: '這張舊發票有不同學員的課程包，請點選要轉的學員', code: 'LEGACY_SELECTION_REQUIRED' };
  if (!picked.every((s) => match.selectable.includes(s))) {
    return { error: '選擇的舊單號不在這張發票的可轉課程包裡', code: 'LEGACY_SELECTION_INVALID' };
  }
  return { seqs: picked, match };
}

/** 對帳交易內：寫連結（每個舊單號 × 付款單每筆子訂單）並在備註開頭加雅正轉標記。 */
async function linkForReconcile(db, { seqs, children, checkoutId, invoice, by }) {
  for (const row of children) {
    for (const seq of seqs) {
      await db.query(
        `INSERT INTO yz_legacy_links (seq, enrollment_id, checkout_id, invoice_entered, linked_by)
         VALUES ($1, $2, $3, $4, $5) ON CONFLICT (seq, enrollment_id) DO NOTHING`,
        [seq, row.id, checkoutId, invoice || null, String(by || '').slice(0, 80)]
      );
    }
    const tag = `雅正轉｜舊單 ${seqs.join(',')}${invoice ? `｜舊發票 ${invoice}` : ''}`;
    await db.query(
      `UPDATE admin_enrollments
          SET notes = CASE WHEN COALESCE(notes, '') = '' THEN $2 ELSE $2 || '｜' || notes END,
              updated_at = NOW()
        WHERE id = $1`,
      [row.id, tag]
    );
    await db.query(
      `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user) VALUES ($1, $2, $3)`,
      [row.id, `雅正轉對帳：涵蓋舊單 ${seqs.join(',')}${invoice ? `（舊發票 ${invoice}）` : ''}`, String(by || '').slice(0, 80)]
    );
  }
}

// ── v1.1（YZM-08，B 方案）：對帳時帶入舊系統堂數＋補舊上課紀錄 ─────────────────────────

const LEGACY_SOURCE = 'legacy_import'; // 和匯入工具同一個來源值：不計薪資、不發評鑑、前端標「舊系統轉移」

// 家長要有真實 LINE 綁定，對帳才開得了課期（條件和 periodProvisioning.ensureSoloCoursePeriod 一致）。
const BOUND_PARENT_SQL = `SELECT 1 FROM parents
  WHERE phone = $1 AND is_active = TRUE
    AND line_uid IS NOT NULL AND line_uid <> ''
    AND line_uid NOT LIKE 'demo:%' AND line_uid NOT LIKE 'DEMOTEST_%'
  LIMIT 1`;

/** 對帳前就知道會被擋的原因（D9 一次 1 期、D10 家長未綁 LINE）。預覽與對帳共用。 */
async function reconcileBlockers(db, children) {
  const out = [];
  if (children.length !== 1) {
    out.push({ code: 'LEGACY_ONE_PERIOD', message: `舊系統轉移一次只能建 1 期，這張付款單有 ${children.length} 期。請取消後重建，堂數填 6 以內即可，對帳時系統會自動帶入舊包堂數` });
  }
  const phones = [...new Set(children.map((c) => c.parent_phone).filter(Boolean))];
  for (const phone of phones) {
    if (!(await db.query(BOUND_PARENT_SQL, [phone])).rowCount) {
      out.push({ code: 'LEGACY_PARENT_NOT_BOUND', message: '家長還沒加入新系統（綁 LINE），系統開不了課期。請家長先加入，再回來對帳' });
    }
  }
  return out;
}

/**
 * 所選舊單號的堂數試算（D7）：總＝各包「已用＋剩餘」加總；uses＝舊系統每一堂，依時間排序。
 * 快照的 uses 筆數必須等於已用，不然補出來的紀錄會和剩餘堂數對不上 → 回 error。
 */
async function planForReconcile(db, seqs) {
  const { rows } = await db.query(
    `SELECT seq, total_sessions, remaining_sessions, used_sessions, uses FROM yz_legacy_packages
      WHERE seq = ANY($1::text[]) ORDER BY seq`, [seqs]);
  if (rows.length !== seqs.length) return { error: '快照裡找不到部分舊單號', code: 'LEGACY_SEQ_NOT_FOUND' };
  let used = 0;
  let remaining = 0;
  const uses = [];
  for (const r of rows) {
    const u = usedOf(r);
    const list = Array.isArray(r.uses) ? r.uses : [];
    if (list.length !== u || list.some((x) => !x || Number.isNaN(Date.parse(x.at)))) {
      return { error: `舊單 ${r.seq} 的快照缺上課紀錄（已用 ${u} 堂，紀錄 ${list.length} 筆），請洽工程`, code: 'LEGACY_SNAPSHOT_INCOMPLETE' };
    }
    used += u;
    remaining += Number(r.remaining_sessions) || 0;
    for (const x of list) uses.push({ at: x.at, coach: x.coach || null, seq: r.seq });
  }
  if (remaining <= 0) return { error: '所選的舊課程包已經沒有剩餘堂數', code: 'LEGACY_NOTHING_LEFT' };
  uses.sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.seq.localeCompare(b.seq));
  return { total: used + remaining, used, remaining, uses };
}

/** 舊系統那一堂的教練：新系統有唯一一位同名教練（排除佔位；同名多位時取唯一在職）才用，否則用課期教練。 */
function coachResolver(coaches, fallbackId) {
  const byName = new Map();
  for (const c of coaches) {
    const k = normCoach(c.name);
    if (k) byName.set(k, [...(byName.get(k) || []), c]);
  }
  return (name) => {
    const real = (byName.get(normCoach(name)) || []).filter((c) => !c.is_placeholder);
    if (real.length === 1) return real[0].id;
    const active = real.filter((c) => c.is_active);
    return active.length === 1 ? active[0].id : fallbackId;
  };
}

/**
 * 對帳交易內、課期開好之後（D8）：舊系統每一堂補一筆已完成、已扣課的 course_sessions（形狀與匯入工具 legacy_import.js 相同，
 * 建立時間也記那一堂的時間），
 * 全班學員各一筆 checkin_records（legacy_import、ATTENDED）；已用堂數由出席紀錄重算（和 usageSync 同一真相），
 * 寫回課期與訂單。課期沒開成（家長未綁 LINE、教練對不到）→ 回 error，呼叫端整筆 ROLLBACK。
 */
async function applyLegacyUsage(db, { enrollment, plan, seqs, by }) {
  const period = (await db.query(
    `SELECT id, coach_id, total_sessions FROM course_periods
      WHERE admin_enrollment_id = $1 AND group_order_id IS NULL ORDER BY created_at, id LIMIT 1 FOR UPDATE`,
    [enrollment.id])).rows[0];
  if (!period) {
    return { error: '課期開不起來：家長還沒加入新系統（綁 LINE），或教練對不到。這筆沒有對帳，請處理後再試', code: 'LEGACY_PERIOD_NOT_OPENED' };
  }
  const students = (await db.query(
    `SELECT student_id FROM course_period_enrollments WHERE course_period_id = $1 AND status = 'active' ORDER BY student_id`,
    [period.id])).rows.map((r) => r.student_id);
  if (!students.length) {
    return { error: '課期沒有學員，無法補舊上課紀錄。這筆沒有對帳，請洽工程', code: 'LEGACY_PERIOD_NO_STUDENTS' };
  }
  const coaches = (await db.query(
    `SELECT id, name, is_active, COALESCE(is_placeholder, FALSE) AS is_placeholder FROM coaches`)).rows;
  const coachFor = coachResolver(coaches, period.coach_id);
  for (const use of plan.uses) {
    const sess = (await db.query(
      `INSERT INTO course_sessions
         (course_period_id, coach_id, scheduled_at, duration_minutes, status, completed_at,
          session_deducted, created_at, updated_at)
       VALUES ($1, $2, $3::timestamptz, 60, 'completed', $3::timestamptz, TRUE, $3::timestamptz, $3::timestamptz)
       RETURNING id`, [period.id, coachFor(use.coach), use.at])).rows[0];
    for (const sid of students) {
      await db.query(
        `INSERT INTO checkin_records
           (course_session_id, student_id, checked_in_by_student_id, is_auto_linked,
            checked_in_source, checked_in_at, attendance_status)
         VALUES ($1, $2, $2, FALSE, $3, $4::timestamptz, 'ATTENDED')`, [sess.id, sid, LEGACY_SOURCE, use.at]);
    }
  }
  const used = Number((await db.query(
    `SELECT COUNT(DISTINCT cs.id)::int AS n FROM course_sessions cs
       JOIN checkin_records cr ON cr.course_session_id = cs.id
      WHERE cs.course_period_id = $1 AND cs.status::text NOT LIKE 'cancelled%' AND cr.attendance_status = 'ATTENDED'`,
    [period.id])).rows[0].n);
  if (used !== plan.used) throw new Error(`雅正轉補舊紀錄後已用 ${used} 堂，應為 ${plan.used}`);
  await db.query(`UPDATE course_periods SET used_sessions = $2, updated_at = NOW() WHERE id = $1`, [period.id, used]);
  await db.query(`UPDATE admin_enrollments SET used_sessions = $2, updated_at = NOW() WHERE id = $1`, [enrollment.id, used]);
  await db.query(
    `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user) VALUES ($1, $2, $3)`,
    [enrollment.id, `雅正轉帶入舊系統堂數：共 ${plan.total} 堂（舊系統已用 ${plan.used}、剩 ${plan.remaining}），`
      + `補 ${plan.used} 筆舊上課紀錄（舊單 ${seqs.join(',')}）`, String(by || '').slice(0, 80)]
  );
  return { period_id: period.id, total: plan.total, used, remaining: plan.remaining, sessions: plan.uses.length };
}

module.exports = {
  LEGACY_PAYMENT_METHOD, LEGACY_SOURCE, SCHEMA_SQL, ensureSchema, legacyKind, matchLegacy, resolveForReconcile,
  linkForReconcile, builtMap, normInvoice, normCoach, parseSeqs,
  reconcileBlockers, planForReconcile, applyLegacyUsage,
};
