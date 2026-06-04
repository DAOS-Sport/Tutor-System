/**
 * 建立第二個 Demo 測試教練「(測試帳號)教練2」，供 demo 帳號 coach2 登入測試
 * 「課程轉換教練（後台改派）」與「教練端寫授課日誌」用。
 *
 * 背景：教練資料已不再從 Ragic 同步（見 ragicAdmin.js / cron），故第一個測試教練
 * 「(測試帳號)教練」只存在於本地 DB。要測「A 教練 → B 教練」的改派，必須再有一個
 * 不同教練可登入。本腳本以 coach1 為範本建 coach2，並複製其 coach_venues（同場館）。
 *
 * 冪等：ragic_employee_id / coach_venues 皆 ON CONFLICT DO NOTHING，可重複執行。
 * 用法：node server/scripts/seed-demo-coach2.js   （需環境有 DATABASE_URL）
 */
const { pool } = require('../models/db');

const COACH2 = {
  ragic_employee_id: '0605066',     // 排序需 > coach1(0605065)，確保 demo 'coach' 仍取到 coach1
  name: '(測試帳號)教練2',           // demo 'coach2' 以此名稱精準比對
  phone: '0900000001',              // 與 coach1(0900000000) 不衝突
};

// 額外掛上的測試場館：後台「轉換教練」以 coachId 改派時會驗證教練屬於目標場館，
// 故 coach2 需掛在測試課程所在場館才能被指派。現有測試課程都在「新北高中(B)」。
const EXTRA_VENUE_IDS = ['B'];

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1) 取第一個測試教練當範本（複製其場館歸屬）
    const c1 = await client.query(
      `SELECT id, ragic_employee_id, name, pricing_multiplier
         FROM coaches
        WHERE name LIKE '%測試帳號%'
        ORDER BY ragic_employee_id ASC
        LIMIT 1`
    );
    if (!c1.rowCount) {
      throw new Error('找不到第一個測試教練（name LIKE %測試帳號%），請先確認 coach1 存在');
    }
    const coach1 = c1.rows[0];

    // 2) 冪等插入 coach2
    await client.query(
      `INSERT INTO coaches
         (ragic_employee_id, name, phone, is_senior, pricing_multiplier, is_active, intro_review_status)
       VALUES ($1, $2, $3, FALSE, $4, TRUE, 'published')
       ON CONFLICT (ragic_employee_id) DO NOTHING`,
      [COACH2.ragic_employee_id, COACH2.name, COACH2.phone, coach1.pricing_multiplier]
    );

    const c2 = await client.query(
      `SELECT id FROM coaches WHERE ragic_employee_id = $1`,
      [COACH2.ragic_employee_id]
    );
    const coach2Id = c2.rows[0].id;

    // 3) 複製 coach1 的場館歸屬到 coach2（同場館，方便後台同場館改派）
    await client.query(
      `INSERT INTO coach_venues (coach_id, venue_id)
       SELECT $1, venue_id FROM coach_venues WHERE coach_id = $2
       ON CONFLICT DO NOTHING`,
      [coach2Id, coach1.id]
    );

    // 3b) 兩個測試教練都掛上測試場館（僅當該場館存在），確保「測試教練1 → 測試教練2」
    //     的後台改派可在同場館(新北高中 B)互轉。
    for (const coachId of [coach1.id, coach2Id]) {
      for (const vid of EXTRA_VENUE_IDS) {
        await client.query(
          `INSERT INTO coach_venues (coach_id, venue_id)
           SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM venues WHERE id = $2)
           ON CONFLICT DO NOTHING`,
          [coachId, vid]
        );
      }
    }

    await client.query('COMMIT');

    const venues = await pool.query(
      `SELECT venue_id FROM coach_venues WHERE coach_id = $1 ORDER BY venue_id`,
      [coach2Id]
    );
    console.log('[seed-demo-coach2] OK');
    console.log('  coach1:', coach1.name, coach1.ragic_employee_id);
    console.log('  coach2:', COACH2.name, COACH2.ragic_employee_id, 'id=' + coach2Id);
    console.log('  coach2 venues:', venues.rows.map((r) => r.venue_id).join(', ') || '(none)');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[seed-demo-coach2] FAILED:', err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();
