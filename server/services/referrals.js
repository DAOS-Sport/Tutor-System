/**
 * MGM 推薦裂變服務
 *  - generateToken(): URL-safe 隨機 token
 *  - createReferralLink({ parentId, coachId }): 建立 pending 紀錄
 *  - findByToken(token): 取連結資訊（含 referrer / coach 名稱）
 *  - bindReferee({ token, refereeParentId, refereePhone }): 註冊完寫入 referee
 *  - markTrialPaid({ refereeParentId, enrollmentId }): /api/enrollments 成功時更新
 *  - issueReward({ enrollmentId }): 體驗課簽到 → 建 9 折券 + 推 Flex
 *
 * 防刷：
 *  - UNIQUE(referee_phone, coach_id) 由 schema 擔保（同手機同教練不可重複）
 *  - bindReferee 拒絕 referrer.phone === referee.phone（自我推薦）
 *  - issueReward 僅在 status='trial_paid' 才會觸發；reward 一旦發出後不可重發
 */
const crypto = require('crypto');
const { pool } = require('../models/db');
const promotions = require('./promotions');

const REWARD_PERCENTAGE = 0.9; // 9 折
const TOKEN_BYTES = 16; // 22~24 char base64url

function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('base64url');
}

async function createReferralLink({ parentId, coachId }) {
  // 同教練 + 同 referrer 若已有 pending 連結（尚未綁 referee），重複利用
  const existing = await pool.query(
    `SELECT id, token FROM referral_records
      WHERE referrer_parent_id = $1 AND coach_id = $2 AND referee_phone IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [parentId, coachId]
  );
  if (existing.rowCount) return existing.rows[0];
  // 嘗試插入；極端衝突就重試一次
  for (let i = 0; i < 3; i += 1) {
    const tk = generateToken();
    try {
      const r = await pool.query(
        `INSERT INTO referral_records (token, referrer_parent_id, coach_id)
         VALUES ($1, $2, $3) RETURNING id, token`,
        [tk, parentId, coachId]
      );
      return r.rows[0];
    } catch (err) {
      if (err.code !== '23505') throw err;
    }
  }
  throw new Error('referral token collision');
}

async function findByToken(token) {
  const r = await pool.query(
    `SELECT rr.id, rr.token, rr.status, rr.coach_id, rr.referrer_parent_id,
            rr.referee_phone, rr.referee_parent_id,
            c.name AS coach_name, c.is_senior, c.pricing_multiplier,
            p.name AS referrer_name, p.phone AS referrer_phone
       FROM referral_records rr
       JOIN coaches c ON c.id = rr.coach_id
       JOIN parents p ON p.id = rr.referrer_parent_id
      WHERE rr.token = $1`,
    [String(token || '').trim()]
  );
  return r.rowCount ? r.rows[0] : null;
}

async function bindReferee({ token, refereeParentId, refereePhone }) {
  const link = await findByToken(token);
  if (!link) {
    const e = new Error('推薦連結無效'); e.code = 'REF_INVALID'; throw e;
  }
  if (link.referrer_phone === refereePhone) {
    const e = new Error('不可自我推薦'); e.code = 'REF_SELF'; throw e;
  }
  // 單次綁定：只允許 status='pending' 且尚未綁定 referee 的連結被佔用，避免覆寫先前綁定
  try {
    const r = await pool.query(
      `UPDATE referral_records
          SET referee_parent_id = $2, referee_phone = $3,
              status = 'registered',
              registered_at = NOW()
        WHERE id = $1
          AND status = 'pending'
          AND referee_phone IS NULL
          AND referee_parent_id IS NULL
        RETURNING id, status`,
      [link.id, refereeParentId, refereePhone]
    );
    if (!r.rowCount) {
      const e = new Error('此推薦連結已被使用'); e.code = 'REF_ALREADY_USED'; throw e;
    }
    return r.rows[0];
  } catch (err) {
    if (err.code === '23505') {
      const e = new Error('此手機號碼已被推薦過'); e.code = 'REF_DUPLICATE'; throw e;
    }
    throw err;
  }
}

async function markTrialPaid({ refereeParentId, coachId, enrollmentId }, client) {
  const db = client || pool;
  // 只更新 (referee, coach) 唯一的那筆 referral，避免影響其他教練的推薦
  const r = await db.query(
    `UPDATE referral_records
        SET status = 'trial_paid',
            trial_paid_at = NOW(),
            experience_enrollment_id = $3
      WHERE referee_parent_id = $1
        AND coach_id = $2
        AND status IN ('pending','registered')
      RETURNING id`,
    [refereeParentId, coachId, enrollmentId]
  );
  return r.rowCount > 0;
}

/**
 * 體驗課簽到 → 推薦方獎勵發放（9 折正期券 + Flex push）
 * 找對應 referral 後，於同一 transaction 建立 promotion 並更新 referral_records。
 */
async function issueRewardForEnrollment(enrollmentId, { line, BRAND_LIFF_URL } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. 在交易內 SELECT FOR UPDATE，鎖定唯一可發獎的 referral row（reward_promotion_id IS NULL）
    const ref = await client.query(
      `SELECT rr.id, rr.referrer_parent_id, rr.referee_parent_id, rr.coach_id,
              p.name AS referrer_name, p.line_uid AS referrer_line_uid,
              p.primary_venue_id AS referrer_venue,
              ref.name AS referee_name
         FROM referral_records rr
         JOIN parents p   ON p.id = rr.referrer_parent_id
    LEFT JOIN parents ref ON ref.id = rr.referee_parent_id
        WHERE rr.experience_enrollment_id = $1
          AND rr.status IN ('trial_paid','checked_in')
          AND rr.reward_promotion_id IS NULL
        FOR UPDATE OF rr`,
      [enrollmentId]
    );
    if (!ref.rowCount) {
      await client.query('ROLLBACK');
      return null;
    }
    const r = ref.rows[0];

    // 2. 先把 referral 推進到 checked_in（顯式狀態機 trial_paid → checked_in）
    await client.query(
      `UPDATE referral_records
          SET status = 'checked_in',
              checked_in_at = COALESCE(checked_in_at, NOW())
        WHERE id = $1 AND status = 'trial_paid'`,
      [r.id]
    );

    // 3. 建立綁 referrer parent_id 的 9 折 promotion（coupon_code 採每筆唯一）
    const code = `MGM${Date.now().toString(36).toUpperCase().slice(-6)}${Math.floor(Math.random()*36).toString(36).toUpperCase()}`;
    const promoIns = await client.query(
      // applicable_course_types = NULL ＝ 全組別（含 1對4/1對5/1對6 及日後新增品相），
      // 推薦獎勵券對任何組別皆可折抵，不再寫死 [1,2,3,4] 而漏掉新品相。
      `INSERT INTO promotions
         (name, description, type, discount_value, applicable_course_types,
          coupon_code, eligible_parent_id, start_date, end_date, max_uses,
          status, created_at, updated_at)
       VALUES ($1, $2, 'PERCENTAGE', $3, NULL,
               $4, $5, CURRENT_DATE, CURRENT_DATE + INTERVAL '60 days', 1,
               'active', NOW(), NOW())
       RETURNING id`,
      [
        `MGM 推薦獎勵 9 折券（${r.referrer_name}）`,
        '感謝您成功推薦新學員，可於 60 天內使用一次（僅限本人）',
        REWARD_PERCENTAGE, code, r.referrer_parent_id,
      ]
    );
    const promoId = promoIns.rows[0].id;

    // 4. 條件式更新到 reward_issued（只在尚未發獎時成立 → 防止 race 重發）
    const upd = await client.query(
      `UPDATE referral_records
          SET status = 'reward_issued',
              reward_issued_at = NOW(),
              reward_promotion_id = $2
        WHERE id = $1
          AND reward_promotion_id IS NULL
        RETURNING id`,
      [r.id, promoId]
    );
    if (!upd.rowCount) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query('COMMIT');

    // 3. 推 LINE Flex（失敗不影響 reward 已發；只 log）
    try {
      if (line && r.referrer_line_uid && r.referrer_venue) {
        const messages = line.templates.mgmRewardIssued({
          refereeName: r.referee_name || '您的推薦對象',
          couponDetails: `折價券代碼 ${code}（9 折，60 天內可用）`,
          liffUrl: BRAND_LIFF_URL || process.env.LIFF_URL_PARENT || process.env.LIFF_URL || '/liff/',
        });
        await line.pushMessage(r.referrer_line_uid, messages, r.referrer_venue);
      }
    } catch (e) {
      console.warn('[referrals.issueReward] LINE push failed:', e.message);
    }

    return { promotionId: promoId, couponCode: code, referralId: r.id };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  generateToken,
  createReferralLink,
  findByToken,
  bindReferee,
  markTrialPaid,
  issueRewardForEnrollment,
  _internal: { REWARD_PERCENTAGE },
};
