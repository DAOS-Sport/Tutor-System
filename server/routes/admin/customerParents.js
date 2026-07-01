/**
 * 客戶資料管理 — Z01 家長 & 學員關係 (F-A02C)
 *
 *   GET   /api/admin/customer-parents          → 家長清單（含啟用學員數、LINE 綁定狀態）
 *   GET   /api/admin/customer-parents/:id       → 單筆家長 + 旗下學員
 *   POST  /api/admin/customer-parents           → 新增家長（本地鏡像）
 *   PATCH /api/admin/customer-parents/:id        → 更新家長業務欄位 + 子表學員（本地鏡像）
 *
 * 真相分工（設計討論定案，見 services/parentSync.js 註解）：
 *   - 登入身分欄（line_uid / is_active）：Replit 為權威 → 此處「永不」改 line_uid。
 *   - 業務資料欄（name/gender/email/venue/identity/住家電話/地址/line_id）：Ragic 為權威，
 *     admin 編輯先寫本地鏡像；TODO 後續加 Option A 回寫 Ragic（ragic.syncParentProfileStrict）。
 *   - phone：值屬 Ragic、綁定關係屬 Replit；此處允許客服改號，唯一鍵衝突回 409。
 *
 * 權限：manager/staff 僅能存取「自己場館」的家長（依 primary_venue_id 收斂）；admin 全域。
 * PII：身分證/血型預設遮罩，需帶 ?reveal=1（並寫稽核）才回原值；遮罩字串不得寫回真值。
 */
const express = require('express');
const { pool } = require('../../models/db');
const { requireAdminAuth, getScopedVenueIds, isVenueInScope } = require('../../middlewares/adminAuth');
const { parseRocOrIso, maskId, maskBlood, looksMasked, wantReveal, auditReveal, diffChanges, writeStudentAudit, adminActorName } = require('./_customerShared');

const router = express.Router();

const PARENT_COLS = `p.id, p.line_uid, p.phone, p.name, p.gender, p.email,
  p.primary_venue_id, p.identity, p.home_phone, p.home_address, p.line_id,
  p.ragic_record_id, p.is_active, p.last_synced_at, p.family_id`;

function rowToParent(r, studentCount = 0) {
  return {
    id: r.id,
    line_uid: r.line_uid || null,
    line_bound: !!r.line_uid,
    phone: r.phone || '',
    name: r.name || '',
    gender: r.gender || '',
    email: r.email || '',
    primary_venue_id: r.primary_venue_id || '',
    identity: r.identity || '',
    home_phone: r.home_phone || '',
    home_address: r.home_address || '',
    line_id: r.line_id || '',
    ragic_record_id: r.ragic_record_id || null,
    is_active: r.is_active !== false,
    last_synced_at: r.last_synced_at || null,
    family_id: r.family_id || null,
    student_count: Number(studentCount) || 0,
  };
}

function rowToStudent(r, reveal) {
  return {
    id: r.id,
    parent_id: r.parent_id,
    name: r.name || '',
    id_number: reveal ? (r.id_number || '') : maskId(r.id_number),
    gender: r.gender || '',
    birth_date: r.birth_date ? new Date(r.birth_date).toISOString().slice(0, 10) : '',
    blood_type: reveal ? (r.blood_type || '') : maskBlood(r.blood_type),
    student_code: r.student_code || '',
    ragic_record_id: r.ragic_record_id || null,
    is_active: r.is_active !== false,
    last_synced_at: r.last_synced_at || null,
  };
}

const KID_COLS = `id, parent_id, name, id_number, gender, birth_date, blood_type,
  student_code, ragic_record_id, is_active, last_synced_at`;

// 取家長 venue 並檢查是否落在操作者範圍內；不在或不存在 → 回 null（caller 一律當 404）
async function parentInScope(client, req, id) {
  const r = await client.query(`SELECT primary_venue_id FROM parents WHERE id = $1`, [id]);
  if (!r.rowCount) return false;
  return isVenueInScope(req, r.rows[0].primary_venue_id);
}

// GET / — 家長清單（+ 學員數）
router.get('/', requireAdminAuth, async (req, res) => {
  try {
    const { status = 'all', venueId = '', name = '', phone = '', identity = '' } = req.query;
    const where = [];
    const args = [];
    const scope = getScopedVenueIds(req);
    if (scope) { args.push(scope); where.push(`p.primary_venue_id = ANY($${args.length}::text[])`); }
    if (status === 'active')   where.push('p.is_active = TRUE');
    if (status === 'inactive') where.push('p.is_active = FALSE');
    if (venueId)  { args.push(venueId);     where.push(`p.primary_venue_id = $${args.length}`); }
    if (name)     { args.push(`%${name}%`);  where.push(`p.name ILIKE $${args.length}`); }
    if (phone)    { args.push(`%${phone}%`); where.push(`p.phone ILIKE $${args.length}`); }
    if (identity) { args.push(identity);     where.push(`p.identity = $${args.length}`); }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const r = await pool.query(
      `SELECT ${PARENT_COLS}, COUNT(s.id) AS student_count
         FROM parents p
         LEFT JOIN students s ON s.parent_id = p.id
         ${whereSql}
         GROUP BY p.id
         ORDER BY p.updated_at DESC NULLS LAST, p.created_at DESC NULLS LAST
         LIMIT 500`,
      args
    );
    res.json(r.rows.map((row) => rowToParent(row, row.student_count)));
  } catch (err) {
    console.error('[admin/customer-parents] list', err);
    res.status(500).json({ error: '讀取家長清單失敗' });
  }
});

// GET /:id — 家長 + 旗下學員
router.get('/:id', requireAdminAuth, async (req, res) => {
  try {
    const p = await pool.query(`SELECT ${PARENT_COLS} FROM parents p WHERE p.id = $1`, [req.params.id]);
    if (!p.rowCount || !isVenueInScope(req, p.rows[0].primary_venue_id)) {
      return res.status(404).json({ error: '找不到此家長' });
    }
    const reveal = wantReveal(req);
    const kids = await pool.query(`SELECT ${KID_COLS} FROM students WHERE parent_id = $1 ORDER BY is_active DESC, created_at ASC`, [req.params.id]);
    if (reveal && kids.rowCount) auditReveal(req, 'parent-students', kids.rowCount);
    res.json({ ...rowToParent(p.rows[0]), students: kids.rows.map((k) => rowToStudent(k, reveal)) });
  } catch (err) {
    console.error('[admin/customer-parents] get', err);
    res.status(500).json({ error: '讀取家長失敗' });
  }
});

// POST / — 新增家長（本地鏡像）
router.post('/', requireAdminAuth, async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  const phone = String(b.phone || '').trim();
  if (!name)  return res.status(400).json({ error: '家長姓名必填', code: 'INPUT_INVALID' });
  if (!phone) return res.status(400).json({ error: '行動電話必填', code: 'INPUT_INVALID' });
  if (!isVenueInScope(req, b.primary_venue_id)) {
    return res.status(403).json({ error: '無權在此場館建立家長', code: 'OUT_OF_SCOPE' });
  }
  try {
    const r = await pool.query(
      `INSERT INTO parents (phone, name, gender, email, primary_venue_id, identity,
                            home_phone, home_address, line_id, is_active)
       VALUES ($1,$2,NULLIF($3,''),NULLIF($4,''),NULLIF($5,''),NULLIF($6,''),
               NULLIF($7,''),NULLIF($8,''),NULLIF($9,''), TRUE)
       RETURNING ${PARENT_COLS.replace(/p\./g, '')}`,
      [phone, name, b.gender || '', b.email || '', b.primary_venue_id || '',
       b.identity || '', b.home_phone || '', b.home_address || '', b.line_id || '']
    );
    res.json(rowToParent(r.rows[0]));
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: '此行動電話已被其他家長使用', code: 'PHONE_DUPLICATE' });
    console.error('[admin/customer-parents] create', err);
    res.status(500).json({ error: '建立家長失敗' });
  }
});

// PATCH /:id — 更新家長業務欄位 + 子表學員（單一交易）
router.patch('/:id', requireAdminAuth, async (req, res) => {
  const b = req.body || {};
  // NOT NULL 前置驗證：清空 name/phone 直接 400（而非讓 23502 中斷整筆交易）
  if (b.name !== undefined && !String(b.name).trim())   return res.status(400).json({ error: '家長姓名不可為空', code: 'INPUT_INVALID' });
  if (b.phone !== undefined && !String(b.phone).trim())  return res.status(400).json({ error: '行動電話不可為空', code: 'INPUT_INVALID' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!(await parentInScope(client, req, req.params.id))) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: '找不到此家長' });
    }

    // 1) 家長業務欄位（白名單；line_uid 屬登入身分，永不在此更動）
    const sets = [];
    const args = [];
    const allow = {
      name: b.name, phone: b.phone, gender: b.gender, email: b.email,
      primary_venue_id: b.primary_venue_id, identity: b.identity,
      home_phone: b.home_phone, home_address: b.home_address, line_id: b.line_id,
    };
    for (const [col, val] of Object.entries(allow)) {
      if (val === undefined) continue;
      args.push(val === '' ? null : val);
      sets.push(`${col} = $${args.length}`);
    }
    if (typeof b.is_active === 'boolean') { args.push(b.is_active); sets.push(`is_active = $${args.length}`); }
    if (sets.length) {
      args.push(req.params.id);
      await client.query(`UPDATE parents SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${args.length}`, args);
    }

    // 2) 子表學員 upsert（id 命中→就地更新，保留 student.id 不斷活動紀錄鏈）
    if (Array.isArray(b.students)) {
      for (const s of b.students) {
        if (!s) continue;
        const bd = parseRocOrIso(s.birth_date);
        // 遮罩字串不得寫回真值（reveal 關閉時前端送回的是遮罩值）
        const idNum = looksMasked(s.id_number) ? undefined : s.id_number;
        const blood = looksMasked(s.blood_type) ? undefined : s.blood_type;
        if (s.id) {
          const hit = await client.query(
            `SELECT id, name, gender, birth_date, id_number, blood_type, student_code
               FROM students WHERE id = $1 AND parent_id = $2`,
            [s.id, req.params.id]
          );
          if (hit.rowCount) {
            const before = hit.rows[0];
            // id_number/blood_type：被遮罩（touch=false）→ 保留原值；未遮罩→以新值寫入（空字串→NULL 清空）。
            const upd = await client.query(
              `UPDATE students SET name=$2, gender=NULLIF($3,''), birth_date=$4::date,
                     id_number  = CASE WHEN $5::boolean THEN NULLIF($6,'')  ELSE id_number  END,
                     blood_type = CASE WHEN $7::boolean THEN NULLIF($8,'')  ELSE blood_type END,
                     student_code=NULLIF($9,''), is_active=$10, updated_at=NOW() WHERE id=$1
               RETURNING name, gender, birth_date, id_number, blood_type, student_code`,
              [s.id, s.name || '', s.gender || '', bd,
               idNum !== undefined, idNum || '', blood !== undefined, blood || '',
               s.student_code || '', s.is_active !== false]
            );
            const changes = diffChanges(before, upd.rows[0], ['name', 'gender', 'birth_date', 'id_number', 'blood_type', 'student_code']);
            await writeStudentAudit(client, s.id, 'edit', { byUser: adminActorName(req), byRole: req.adminUser?.role, changes })
              .catch((err) => console.warn('[student-audit] 家長頁編輯學員稽核寫入失敗:', err.message));
            continue;
          }
        }
        if (!String(s.name || '').trim()) continue; // 新列需有姓名才建
        const ins = await client.query(
          `INSERT INTO students (parent_id, name, gender, birth_date, id_number, blood_type, student_code, is_active)
           VALUES ($1,$2,NULLIF($3,''),$4::date,NULLIF($5,''),NULLIF($6,''),NULLIF($7,''), $8)
           RETURNING id`,
          [req.params.id, s.name, s.gender || '', bd,
           idNum === undefined ? '' : (idNum || ''), blood === undefined ? '' : (blood || ''),
           s.student_code || '', s.is_active !== false]
        );
        await writeStudentAudit(client, ins.rows[0].id, 'create', { byUser: adminActorName(req), byRole: req.adminUser?.role })
          .catch((err) => console.warn('[student-audit] 家長頁新增學員稽核寫入失敗:', err.message));
      }
    }

    // 讀回最新狀態（用交易連線，於 COMMIT 前完成；避免 COMMIT 後另開連線讀失敗誤報 500）
    const p = await client.query(`SELECT ${PARENT_COLS} FROM parents p WHERE p.id = $1`, [req.params.id]);
    const kids = await client.query(`SELECT ${KID_COLS} FROM students WHERE parent_id = $1 ORDER BY is_active DESC, created_at ASC`, [req.params.id]);
    await client.query('COMMIT');
    const reveal = wantReveal(req);
    // TODO(Option A 寫回 Ragic)：ragic.syncParentProfileStrict + updateStudentZ01Z02Strict，資料清洗後接上。
    res.json({ ...rowToParent(p.rows[0]), students: kids.rows.map((k) => rowToStudent(k, reveal)) });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') {
      const msg = /phone/.test(err.detail || '') ? '此行動電話已被其他家長使用' : '唯一值衝突（電話 / 身分證 / Ragic 連結重複）';
      return res.status(409).json({ error: msg, code: 'UNIQUE_CONFLICT' });
    }
    if (err.code === '23502') return res.status(400).json({ error: '姓名與行動電話必填', code: 'INPUT_INVALID' });
    console.error('[admin/customer-parents] patch', err);
    res.status(500).json({ error: '更新家長失敗' });
  } finally {
    client.release();
  }
});

module.exports = router;
