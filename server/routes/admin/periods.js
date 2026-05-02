/**
 * /api/admin/periods — course_periods 狀態維運（spec F-S09 對齊）
 *
 * 此處的 POST /:id/activate 是「狀態 → active」的 canonical 路由切口：
 * 走 chatRooms.transitionPeriodToActive() 同時翻牌 + 冪等建立 chat_room，
 * 避免依賴 cron backfill 才補建房間。任何後續會走「期數轉 active」的
 * UI/服務都應改打這個端點，而不是直接 UPDATE course_periods.status。
 *
 * 權限：admin / manager（manager 必須是該 period 所屬場館）。
 */
const express = require('express');
const { pool } = require('../../models/db');
const { requireAdminAuth, requireAdminRole } = require('../../middlewares/adminAuth');
const chatRooms = require('../../services/chatRooms');

const router = express.Router();

router.post('/:id/activate', requireAdminAuth, requireAdminRole('admin', 'manager'), async (req, res) => {
  try {
    const owns = await pool.query(
      `SELECT id, venue_id, status FROM course_periods WHERE id = $1`, [req.params.id]
    );
    if (!owns.rowCount) return res.status(404).json({ error: 'period not found' });
    if (req.adminUser.role === 'manager' && owns.rows[0].venue_id !== req.adminUser.venue_id) {
      return res.status(403).json({ error: 'forbidden' });
    }
    const out = await chatRooms.transitionPeriodToActive(req.params.id);
    res.json({ period_id: req.params.id, activated: out.activated, room: out.room });
  } catch (err) {
    console.error('[admin/periods/activate]', err);
    res.status(500).json({ error: 'activate failed' });
  }
});

module.exports = router;
