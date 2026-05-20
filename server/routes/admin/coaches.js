/**
 * F-C-Admin 教練資料 (DEPRECATED, Task #91)
 * ────────────────────────────────────────────────────────────────
 * 教練資料已合併進「員工帳號管理 (F-A02)」單一事實來源。
 * 所有 endpoint 一律回 410 Gone + 友善訊息，指向新的 staff API：
 *   - 教練清單 / 編輯：用 `/api/admin/staff?role=coach`、`/api/admin/staff/:id`、PATCH /api/admin/staff/:id
 *   - 教練 lookup（給報名 / 排課用）：`/api/admin/staff/coaches?venueId=&status=active`
 *   - 教練介紹送審：`/api/admin/learn/intros`（F-C06 保留）
 *
 * 保留路由的目的：明確告訴尚未更新的 client（含舊瀏覽器快取）此功能已搬家，
 * 而非 404 讓使用者誤以為是 bug。
 */
const express = require('express');
const router = express.Router();

const GONE_MESSAGE = {
  error: 'F-C-Admin 教練資料已合併進「員工帳號管理 (F-A02)」',
  code: 'ENDPOINT_GONE',
  migrated_to: {
    list_or_filter: 'GET /api/admin/staff?role=coach',
    detail: 'GET /api/admin/staff/:id',
    update: 'PATCH /api/admin/staff/:id  (body 可帶 coach_profile)',
    lookup_by_venue: 'GET /api/admin/staff/coaches?venueId=&status=active',
    intros_review: 'GET /api/admin/learn/intros',
  },
};

router.all('*', (req, res) => {
  res.status(410).json(GONE_MESSAGE);
});

module.exports = router;
