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
  purchase_date       DATE,
  snapshot_at         TIMESTAMPTZ NOT NULL,
  loaded_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
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

module.exports = {
  LEGACY_PAYMENT_METHOD, SCHEMA_SQL, ensureSchema, legacyKind, matchLegacy, resolveForReconcile,
  linkForReconcile, builtMap, normInvoice, normCoach, parseSeqs,
};
