/**
 * LIFF 報名建立 (POST /api/enrollments)
 *
 * 為 Phase 6（上）F-S02「補充購課套用」串接後端寫入路徑：
 *   1. 接收 LIFF EnrollmentPage 送出的 payload
 *   2. 後端「重新計算」優惠折抵（不信任 client 傳來的 final_price），
 *      避免被竄改；不一致時直接以伺服器計算結果為準。
 *   3. 同一交易內：INSERT admin_enrollments + (有優惠則) services.recordUsage
 *      → 確保 promotion_usages 與 promotions.current_uses 同步、原子。
 *
 * 不在本任務範圍：core course_periods 真實寫入；本路由只建立 admin_enrollments
 * (pending_payment) 等管理後台對帳通過後再 promote 為正式 course_period。
 */
const express = require('express');
const { pool } = require('../models/db');
const promotions = require('../services/promotions');

const router = express.Router();

function genEnrollmentId() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, '0');
  return `E${ts}${rand}`;
}

router.post('/', async (req, res) => {
  const p = req.body || {};
  if (!p.parent_name || !p.parent_phone || !p.coach || !p.venue || !p.course_type
      || !Array.isArray(p.students) || !p.students.length) {
    return res.status(400).json({ error: '報名資料不完整' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── 後端重算 (server-authoritative) ────────────────────────────────
    const original = Math.max(0, Math.round(Number(p.original_price) || 0));
    const couponCode = p.promotion && p.promotion.coupon_code ? String(p.promotion.coupon_code).trim() : null;
    let preview;
    try {
      preview = await promotions.previewBestDiscount({
        originalPrice: original,
        courseType: Number(p.course_type),
        venueId: p.venue.id || null,
        periodCount: 1,
        couponCode,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      if (err.code && err.code.startsWith('COUPON_')) {
        return res.status(400).json({ error: '折價券無法使用，請確認代碼或重新試算', code: 'COUPON_INVALID' });
      }
      throw err;
    }

    const enrollmentId = genEnrollmentId();
    const studentNames = p.students.map((s) => s.name);
    const submittedAt = new Date();

    await client.query(
      `INSERT INTO admin_enrollments
         (id, parent_name, parent_phone, students, coach, venue_id, course_type,
          original_price, final_price, transfer_last_5, status, submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending_payment',$11)`,
      [
        enrollmentId, p.parent_name, p.parent_phone, studentNames,
        p.coach.name || String(p.coach), p.venue.id, Number(p.course_type),
        preview.originalPrice, preview.finalPrice, p.transfer_last_5 || null,
        submittedAt,
      ]
    );

    let usage = null;
    if (preview.promotion && preview.discountAmount > 0) {
      usage = await promotions.recordUsage({
        promotionId: preview.promotion.id,
        parentId: null, // LIFF 端目前無 parents.id 對應 (mock parent)
        coursePeriodId: null, // 對帳通過後再產 course_period
        adminEnrollmentId: enrollmentId,
        originalPrice: preview.originalPrice,
        discountAmount: preview.discountAmount,
        finalPrice: preview.finalPrice,
      }, client);
    }

    await client.query(
      `INSERT INTO admin_enrollment_audit_logs (enrollment_id, action, by_user)
       VALUES ($1, $2, $3)`,
      [enrollmentId, '家長提交報名', p.parent_phone]
    );

    await client.query('COMMIT');

    res.status(201).json({
      id: enrollmentId,
      parent_id: p.parent_id || null,
      coach: p.coach,
      venue: p.venue,
      course_type: Number(p.course_type),
      students: p.students,
      total_sessions: 6,
      used_sessions: 0,
      original_price: preview.originalPrice,
      final_price: preview.finalPrice,
      payment_status: 'pending_payment',
      transfer_last_5: p.transfer_last_5 || null,
      promotion: preview.promotion ? {
        id: preview.promotion.id,
        name: preview.promotion.name,
        coupon_code: preview.promotion.coupon_code,
        discount: preview.discountAmount,
      } : null,
      promotion_usage_id: usage ? usage.id : null,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[enrollments create]', err);
    res.status(500).json({ error: 'enrollment create failed' });
  } finally {
    client.release();
  }
});

module.exports = router;
