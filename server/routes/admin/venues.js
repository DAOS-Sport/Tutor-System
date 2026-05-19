/**
 * 場館設定 (F-A03)
 *  GET    /api/admin/venues       → 全部場館（先 sync Ragic H05；best-effort）
 *  PATCH  /api/admin/venues/:id   → 更新場館資訊
 *
 * mock.js shape：
 *   { id, code, name, address, line_token,
 *     bank_institution_name, bank_branch_name, account_holder, account_number }
 */
const express = require('express');
const { pool } = require('../../models/db');
const { requireAdminAuth, requireAdminRole } = require('../../middlewares/adminAuth');
const {
  syncVenuesFromRagic,
  diffVenuesFromRagic, applyVenueSync, VENUE_SYNC_FIELDS, ragicEnabled,
} = require('../../services/ragicAdmin');

const router = express.Router();

function rowToVenueFull(r) {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    address: r.address || '',
    line_token: r.line_token || '',
    bank_institution_name: r.bank_institution_name || '',
    bank_branch_name: r.bank_branch_name || '',
    account_holder: r.account_holder || '',
    account_number: r.account_number || '',
    is_active: r.is_active !== false,
    is_active_overridden_at: r.is_active_overridden_at || null,
  };
}

// 非 admin 角色只能看到顯示名稱用的安全欄位（給 venueMap[id]→name 之類顯示用）。
// LINE token / 銀行帳戶屬機敏資料，僅 admin 可看到。
function rowToVenuePublic(r) {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    address: r.address || '',
    line_token: '',
    bank_institution_name: '',
    bank_branch_name: '',
    account_holder: '',
    account_number: '',
    is_active: r.is_active !== false,
  };
}

router.get('/', requireAdminAuth, async (req, res) => {
  try {
    // Task #54：場館同步改走「立即同步 Ragic」按鈕的兩階段 dry-run + confirm 流程；
    // 列表載入不再 auto-kickoff 寫入，避免在使用者確認前就動到 DB（覆寫保護仍會被
    // legacy syncVenuesFromRagic 尊重，但同步時機仍應由人工觸發）。
    const r = await pool.query(`SELECT * FROM admin_venues ORDER BY id`);
    const isAdmin = req.adminUser?.role === 'admin';
    res.json(r.rows.map(isAdmin ? rowToVenueFull : rowToVenuePublic));
  } catch (err) {
    console.error('[admin/venues]', err);
    res.status(500).json({ error: 'list venues failed' });
  }
});

// Task #53：admin 立即同步 H05（同步等待結果，無 diff confirm；保留供 cron / 相容）
router.post('/sync', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  try {
    const result = await syncVenuesFromRagic('manual');
    if (result && result.error) return res.status(502).json(result);
    res.json(result);
  } catch (err) {
    console.error('[admin/venues/sync]', err);
    res.status(500).json({ error: 'sync failed' });
  }
});

// Task #54：兩階段同步 — 預設 dry-run；body.confirm=true 時依 selections 寫入。
router.post('/sync-ragic', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  try {
    if (!ragicEnabled()) {
      return res.status(502).json({ error: 'Ragic 未設定 (RAGIC_API_KEY / RAGIC_BASE_URL)' });
    }
    const body = req.body || {};
    if (body.confirm === true) {
      const selections = body.selections || {};
      const applied = await applyVenueSync(selections);
      return res.json({ confirmed: true, ...applied });
    }
    const diff = await diffVenuesFromRagic();
    return res.json(diff);
  } catch (err) {
    console.error('[admin/venues/sync-ragic]', err);
    res.status(502).json({ error: err.message || 'Ragic 同步失敗' });
  }
});

// Task #84：場館啟用 / 停用 — 同步寫 admin_venues + venues，並標記 is_active_overridden_at
// 已售出 (admin_enrollments) 的課程一律不取消；只阻擋未來的新報名 (server/routes/enrollments.js)。
router.patch('/:id/active', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  const { id } = req.params;
  // 強制要求 is_active 為明確 boolean — 避免 payload 漏欄位被當成「停用」誤觸發
  if (!req.body || typeof req.body.is_active !== 'boolean') {
    return res.status(400).json({ error: 'is_active (boolean) required' });
  }
  const isActive = req.body.is_active;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(`SELECT * FROM admin_venues WHERE id = $1 FOR UPDATE`, [id]);
    if (!cur.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'venue not found' });
    }
    const r = await client.query(
      `UPDATE admin_venues
          SET is_active = $2,
              is_active_overridden_at = NOW(),
              updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [id, isActive]
    );
    // 同步 LIFF 用的 venues 表（若該 row 不存在則 INSERT，避免日後 LIFF 看不到）
    await client.query(
      `INSERT INTO venues (id, name, full_address, is_active)
         VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET is_active = EXCLUDED.is_active, updated_at = NOW()`,
      [id, r.rows[0].name, r.rows[0].address || '', isActive]
    );
    await client.query('COMMIT');
    res.json(rowToVenueFull(r.rows[0]));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[admin/venues/:id/active]', err);
    res.status(500).json({ error: 'toggle active failed' });
  } finally {
    client.release();
  }
});

router.patch('/:id', requireAdminAuth, requireAdminRole('admin'), async (req, res) => {
  try {
    const { id } = req.params;
    const patch = req.body || {};
    const curR = await pool.query(`SELECT * FROM admin_venues WHERE id = $1`, [id]);
    if (!curR.rowCount) return res.status(404).json({ error: 'venue not found' });
    const cur = curR.rows[0];

    const fields = ['name', 'address', 'line_token', 'bank_institution_name',
                    'bank_branch_name', 'account_holder', 'account_number'];
    const values = fields.map((f) => patch[f] !== undefined ? patch[f] : cur[f]);

    // Task #54：標記覆寫旗標 — 對 Ragic 同步範圍內、且本次值與 DB 不同的欄位，
    // 紀錄手動覆寫時間，下次 sync confirm 寫入時會跳過。
    const overrideSets = [];
    for (const f of VENUE_SYNC_FIELDS) {
      if (patch[f] === undefined) continue;
      const newVal = patch[f] || '';
      const oldVal = cur[f] || '';
      if (newVal !== oldVal) overrideSets.push(`${f}_overridden_at = NOW()`);
    }
    const extra = overrideSets.length ? `, ${overrideSets.join(', ')}` : '';

    const r = await pool.query(
      `UPDATE admin_venues SET
         name = $2,
         address = $3,
         line_token = $4,
         bank_institution_name = $5,
         bank_branch_name = $6,
         account_holder = $7,
         account_number = $8,
         updated_at = NOW()${extra}
       WHERE id = $1 RETURNING *`,
      [id, ...values]
    );
    res.json(rowToVenueFull(r.rows[0]));
  } catch (err) {
    console.error('[admin/venues/:id PATCH]', err);
    res.status(500).json({ error: 'update venue failed' });
  }
});

module.exports = router;
