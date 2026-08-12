/**
 * 客戶資料管理 — Z01 家長 & 學員關係 (F-A02C)
 *
 *   GET   /api/admin/customer-parents          → 家長清單（含啟用學員數、LINE 綁定狀態）
 *   GET   /api/admin/customer-parents/:id       → 單筆家長 + 旗下學員
 *   POST  /api/admin/customer-parents           → 新增家長（本地鏡像）
 *   PATCH /api/admin/customer-parents/:id        → 更新家長業務欄位 + 子表學員（本地鏡像）
 *
 * 真相分工（設計討論定案，見 services/parentSync.js 註解）：
 *   - 登入身分欄（line_uid / is_active）：Replit 為權威 → 一般編輯「永不」改 line_uid。
 *     唯一例外是 POST /:id/unbind-line（客服解除綁定），見該端點上方說明。
 *   - 業務資料欄（name/gender/email/venue/identity/住家電話/地址/line_id）：Ragic 為權威，
 *     admin 編輯先寫本地鏡像（交易內標記 last_synced_at = NULL），提交後即時回寫 Ragic
 *     （services/ragicWriteback，best-effort）；失敗列保持待同步，由每日備份排程重試。
 *   - phone：值屬 Ragic、綁定關係屬 Replit；此處允許客服改號，唯一鍵衝突回 409。
 *
 * 權限：manager/staff 僅能存取「自己場館」的家長（依 primary_venue_id 收斂）；admin 全域。
 * PII：身分證/血型預設遮罩，需帶 ?reveal=1（並寫稽核）才回原值；遮罩字串不得寫回真值。
 */
const express = require('express');
const { formatPlainDate } = require('../../utils/dateTime');
const { pool } = require('../../models/db');
const { requireAdminAuth, getScopedVenueIds, isVenueInScope } = require('../../middlewares/adminAuth');
const { parseRocOrIso, maskId, maskBlood, looksMasked, wantReveal, auditReveal, diffChanges, writeStudentAudit, adminActorName } = require('./_customerShared');
const ragicWriteback = require('../../services/ragicWriteback');
const ragicWriter = require('../../services/ragicWriter');
const ragic = require('../../services/ragic');
const crypto = require('crypto');

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
    birth_date: formatPlainDate(r.birth_date),
    blood_type: reveal ? (r.blood_type || '') : maskBlood(r.blood_type),
    student_code: r.student_code || '',
    ragic_record_id: r.ragic_record_id || null,
    is_active: r.is_active !== false,
    last_synced_at: r.last_synced_at || null,
  };
}

const KID_COLS = `id, parent_id, name, id_number, gender, birth_date, blood_type,
  student_code, ragic_record_id, is_active, last_synced_at`;

function isRealLineUid(uid) {
  const s = String(uid || '').trim();
  return !!s && !s.startsWith('demo:') && !s.startsWith('DEMOTEST_');
}

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
    where.push(`COALESCE(p.name, '') <> 'ZZ-CANARY'`);
    where.push(`COALESCE(p.phone, '') <> 'ZZ-CANARY'`);
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

// POST / — 新增家長：已依「Z01 只收已綁 LINE UID」政策停用。
// 本地鏡像是「登入真相鏡像」，手建列必然未綁 UID → 進了鏡像就是殘留、推上 Ragic 就是
// 未綁資料進 Z01（夜間 pull 又分流進 Z03，清不完的循環）。正確流程：櫃台在 Ragic Z01
// 建檔 → 客戶 LINE 註冊綁定 → 下一輪 pull（或註冊當下刷新）自動進本地鏡像。
router.post('/', requireAdminAuth, (req, res) => {
  res.status(410).json({
    error: '手動新增家長已停用：請於 Ragic Z01 建檔，客戶完成 LINE 註冊綁定後會自動進入本系統',
    code: 'PARENT_CREATE_VIA_RAGIC',
  });
});

// PATCH /:id — 更新家長業務欄位 + 子表學員（單一交易）
/**
 * POST /api/admin/customer-parents/:id/unbind-line — 客服解除 LINE 綁定
 *
 * 用途：家長換手機／換 LINE 帳號／誤綁，需要讓他重新走一次電話驗證。
 *
 * ── 為什麼要清「兩邊」──
 * 只清本地的話，家長確實會被導回電話驗證（登入只看本地 parents.line_uid，
 * 見 auth.js 的 parent-line-login，2026-07-03 定案），但他若是用**另一支**
 * LINE 重綁，寫回 Ragic 時會撞上 _assertNoZ01LineUidConflict：
 * Z01 上還留著舊 UID → 判定「已綁定其他 LINE UID，拒絕覆蓋」→ 綁不完成。
 * 所以 Ragic Z01 的 UID 欄位也要一起清掉。
 *
 * ── 為什麼 Ragic 那步是 best-effort ──
 * 本地清除必須先成功並 COMMIT，否則「Ragic 清了、本地沒清」會變成
 * 家長還登得進去、但下次同步就衝突。反過來（本地清了、Ragic 沒清）
 * 只影響「換別支 LINE」這一種情況，而且回應會明講，客服看得到。
 *
 * 不動的東西：學員、報名、上課紀錄、家長的業務資料全部保留。
 * 這個動作只解除「哪一支 LINE 可以登入這個帳號」。
 */
router.post('/:id/unbind-line', requireAdminAuth, async (req, res) => {
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: '請填寫解除綁定的原因', code: 'REASON_REQUIRED' });
  if (reason.length > 500) return res.status(400).json({ error: '原因過長（上限 500 字）', code: 'REASON_TOO_LONG' });

  const actor = adminActorName(req);
  const client = await pool.connect();
  let parent;
  try {
    await client.query('BEGIN');
    if (!(await parentInScope(client, req, req.params.id))) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: '找不到此家長' });
    }
    const cur = await client.query(
      `SELECT id, name, phone, line_uid, ragic_record_id FROM parents WHERE id = $1 FOR UPDATE`,
      [req.params.id]
    );
    parent = cur.rows[0];
    if (!parent) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: '找不到此家長' });
    }
    if (!isRealLineUid(parent.line_uid)) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: '此家長目前沒有綁定 LINE，不需要解除',
        code: 'NOT_BOUND',
      });
    }

    const oldUid = parent.line_uid;
    await client.query(
      // last_synced_at 一併清成 NULL：讓下次同步視為「未同步過」，
      // 不會拿舊鏡像去覆蓋家長重新驗證後填的東西。
      `UPDATE parents SET line_uid = NULL, last_synced_at = NULL, updated_at = NOW() WHERE id = $1`,
      [req.params.id]
    );

    // 稽核：只落雜湊，完整 UID 屬 PII，不進資料庫也不進 log。
    // new_uid_hash 是 NOT NULL，這裡放一個看得懂的哨兵值，之後查表一眼認得出
    // 「這筆是解除綁定，不是換綁」。
    const sha = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
    await client.query(
      `INSERT INTO parent_line_uid_rebind_audit
         (canonical_parent_id, ragic_record_id, old_uid_hash, new_uid_hash,
          verification_method, initiated_by, reason, reason_code,
          correlation_id, verified_at, committed_at)
       VALUES ($1,$2,$3,$4,'ADMIN_BACKOFFICE',$5,$6,'ADMIN_UNBIND',gen_random_uuid(),NOW(),NOW())`,
      [parent.id, parent.ragic_record_id || null, sha(oldUid), sha('ADMIN_UNBIND'), actor, reason]
    );
    await client.query('COMMIT');

    // ── COMMIT 之後才動 Ragic（順序不可顛倒，理由見上方說明）──
    let ragicCleared = false;
    let ragicError = null;
    if (parent.ragic_record_id) {
      try {
        await ragicWriter.writeField(
          'Z01', parent.ragic_record_id, ragic.FIELD.Z01.LINE_UID, '',
          actor, 'admin-unbind-line', { reason }
        );
        ragicCleared = true;
      } catch (e) {
        ragicError = e.message;
        console.warn('[unbind-line] Ragic Z01 UID 清除失敗（本地已解除）:', parent.id, e.message);
      }
    } else {
      ragicError = '此家長在 Ragic 沒有對應紀錄（ragic_record_id 為空）';
    }

    console.log(JSON.stringify({
      event: 'admin_unbind_line',
      parent_id: parent.id,
      ragic_record_id: parent.ragic_record_id || null,
      ragic_cleared: ragicCleared,
      by: actor,
      at: new Date().toISOString(),
    }));

    return res.json({
      ok: true,
      ragic_cleared: ragicCleared,
      ragic_error: ragicError,
      // 客服要據此決定「要不要請家長務必用原本那支 LINE」
      note: ragicCleared
        ? '已解除。家長下次開啟系統會走電話驗證重新綁定，可換用不同的 LINE 帳號。'
        : 'Replit 端已解除，但 Ragic 上的舊 UID 沒清掉。家長若用「原本那支 LINE」重綁沒問題；'
          + '若要換一支 LINE，會在寫回 Ragic 時被擋下，請先人工清掉 Z01 的 LINE UID 欄位。',
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[admin/customer-parents/unbind-line]', err);
    return res.status(500).json({ error: '解除綁定失敗', code: 'UNBIND_FAILED' });
  } finally {
    client.release();
  }
});

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
    const targetParent = await client.query(`SELECT line_uid FROM parents WHERE id = $1`, [req.params.id]);
    const parentHasRealLineUid = isRealLineUid(targetParent.rows[0]?.line_uid);

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
    if (typeof b.is_active === 'boolean') {
      // 未綁 LINE UID 的列不得重新啟用：active 鏡像只收已綁列（夜間 pull 掃尾也會再停用，
      // 這裡直接擋下並說明，避免「啟用→隔天又被停用」的困惑）。
      if (b.is_active === true) {
        if (!parentHasRealLineUid) {
          await client.query('ROLLBACK');
          return res.status(409).json({
            error: '此家長尚未綁定真實 LINE，無法啟用；請客戶完成 LINE 註冊綁定後會自動啟用',
            code: 'PARENT_UNBOUND_CANNOT_ACTIVATE',
          });
        }
      }
      args.push(b.is_active); sets.push(`is_active = $${args.length}`);
    }
    // 本地鏡像有異動 → 交易內先標記待同步（last_synced_at = NULL），COMMIT 後即時回寫 Ragic；
    // 回寫成功才蓋回 NOW()，失敗保持 NULL 由每日備份排程重試。
    const parentTouched = sets.length > 0;
    if (sets.length) {
      args.push(req.params.id);
      await client.query(`UPDATE parents SET ${sets.join(', ')}, last_synced_at = NULL, updated_at = NOW() WHERE id = $${args.length}`, args);
    }

    // 2) 子表學員 upsert（id 命中→就地更新，保留 student.id 不斷活動紀錄鏈）
    const touchedStudentIds = []; // 本次更新/新增的學員 → COMMIT 後即時回寫 Ragic
    if (Array.isArray(b.students)) {
      if (!parentHasRealLineUid && b.students.some((s) => s && (!s.id || s.is_active !== false))) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: '此家長尚未綁定真實 LINE，無法新增或啟用學員',
          code: 'PARENT_UNBOUND_CANNOT_ACTIVATE_STUDENT',
        });
      }
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
                     student_code=NULLIF($9,''), is_active=$10, last_synced_at=NULL, updated_at=NOW() WHERE id=$1
               RETURNING name, gender, birth_date, id_number, blood_type, student_code`,
              [s.id, s.name || '', s.gender || '', bd,
               idNum !== undefined, idNum || '', blood !== undefined, blood || '',
               s.student_code || '', s.is_active !== false]
            );
            touchedStudentIds.push(s.id);
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
        touchedStudentIds.push(ins.rows[0].id); // 新列 last_synced_at 預設 NULL（待同步）
        await writeStudentAudit(client, ins.rows[0].id, 'create', { byUser: adminActorName(req), byRole: req.adminUser?.role })
          .catch((err) => console.warn('[student-audit] 家長頁新增學員稽核寫入失敗:', err.message));
      }
    }

    // 讀回最新狀態（用交易連線，於 COMMIT 前完成；避免 COMMIT 後另開連線讀失敗誤報 500）
    const p = await client.query(`SELECT ${PARENT_COLS} FROM parents p WHERE p.id = $1`, [req.params.id]);
    const kids = await client.query(`SELECT ${KID_COLS} FROM students WHERE parent_id = $1 ORDER BY is_active DESC, created_at ASC`, [req.params.id]);
    await client.query('COMMIT');
    const reveal = wantReveal(req);
    // Option A 寫回 Ragic：COMMIT 後即時回寫（best-effort、fire-and-forget）；
    // 失敗列已在交易內標記 last_synced_at = NULL，由每日備份排程重試。
    ragicWriteback.scheduleWriteback({
      parentId: parentTouched ? req.params.id : null,
      studentIds: touchedStudentIds,
      reason: 'admin-parent-patch',
    });
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
