'use strict';
/**
 * 模組 1 端到端測試（dev 庫，非唯讀）
 *
 * 驗證真實資料流，不是 mock：
 *   ① 場館營業時間 → 產生器 → 時段
 *   ② 特殊日期休館 → 該日不產生
 *   ③ 智慧記憶：上輪關閉 → 下輪同格自動 blocked
 *   ④ 旗標關閉 → 家長端查詢看不到 auto 時段
 *   ⑤ 首次提示 ack 冪等
 *   ⑥ 取消 24h 判斷
 *
 * 用完即清：所有測試資料以固定前綴建立，結尾一律刪除。
 */
const assert = require('assert');
const { pool } = require('../../server/models/db');
const gen = require('../../server/services/slotGenerator');
const { canSelfCancel } = require('../../server/services/bookingPolicy');

const TAG = 'E2E_SLOT_SUPPLY';
const VENUE = 'ZZ';                       // 測試用場館 id（不與正式 A~Z 常用碼衝突請自行確認）
let coachId; let periodId; let parentId; let studentId;

async function cleanup() {
  await pool.query(`UPDATE coach_availability_slots SET booked_session_id=NULL WHERE coach_id IN (SELECT id FROM coaches WHERE name=$1)`, [TAG]);
  await pool.query(`DELETE FROM checkin_records WHERE course_session_id IN (SELECT id FROM course_sessions WHERE coach_id IN (SELECT id FROM coaches WHERE name=$1))`, [TAG]);
  await pool.query(`DELETE FROM course_sessions WHERE coach_id IN (SELECT id FROM coaches WHERE name=$1)`, [TAG]);
  await pool.query(`DELETE FROM course_sessions WHERE course_period_id IN (SELECT id FROM course_periods WHERE course_type=999)`);
  await pool.query(`DELETE FROM coach_availability_slots WHERE coach_id IN (SELECT id FROM coaches WHERE name=$1)`, [TAG]);
  await pool.query(`DELETE FROM course_period_enrollments WHERE course_period_id IN (SELECT id FROM course_periods WHERE course_type=999)`);
  await pool.query(`DELETE FROM course_periods WHERE course_type=999`);
  await pool.query(`DELETE FROM students WHERE name=$1`, [TAG]);
  await pool.query(`DELETE FROM parents WHERE name=$1 OR phone='0999000002'`, [TAG]);
  await pool.query(`DELETE FROM coaches WHERE name=$1 OR phone='0999000001'`, [TAG]);
  await pool.query(`DELETE FROM venue_closed_dates WHERE venue_id=$1`, [VENUE]);
  await pool.query(`DELETE FROM venue_business_hours WHERE venue_id=$1`, [VENUE]);
  await pool.query(`DELETE FROM venues WHERE id=$1`, [VENUE]);
}

async function setup() {
  await cleanup();
  await pool.query(`INSERT INTO venues (id, name, is_active) VALUES ($1,$2,TRUE)`, [VENUE, `${TAG}場館`]);
  // 每天 09:00-12:00、60 分 → 每天 3 格
  for (let wd = 0; wd <= 6; wd++) {
    await pool.query(
      `INSERT INTO venue_business_hours (venue_id, weekday, open_time, close_time, slot_minutes)
       VALUES ($1,$2,'09:00','12:00',60)`, [VENUE, wd]);
  }
  coachId = (await pool.query(
    `INSERT INTO coaches (ragic_employee_id, name, phone, is_active)
     VALUES ($1,$2,'0999000001',TRUE) RETURNING id`, [`${TAG}_EMP`, TAG])).rows[0].id;
  await pool.query(`INSERT INTO coach_venues (coach_id, venue_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [coachId, VENUE]);
  parentId = (await pool.query(
    `INSERT INTO parents (name, phone, line_uid, is_active) VALUES ($1,'0999000002',$2,TRUE) RETURNING id`,
    [TAG, `${TAG}_UID`])).rows[0].id;
  studentId = (await pool.query(
    `INSERT INTO students (parent_id, name) VALUES ($1,$2) RETURNING id`, [parentId, TAG])).rows[0].id;
  periodId = (await pool.query(
    `INSERT INTO course_periods (coach_id, venue_id, course_type, total_sessions, used_sessions,
                                 expires_at, status, original_price, final_price)
     VALUES ($1,$2,999,10,0,CURRENT_DATE+365,'active',0,0) RETURNING id`, [coachId, VENUE])).rows[0].id;
  await pool.query(
    `INSERT INTO course_period_enrollments (course_period_id, student_id, status) VALUES ($1,$2,'active')`,
    [periodId, studentId]);
}

function ymd(d) { return new Date(d.getTime() + 8 * 3600000).toISOString().slice(0, 10); }

(async () => {
  try {
    await setup();
    const today = ymd(new Date());
    const tomorrow = gen.addDays(today, 1);

    // ① 產生器：2 天 × 3 格 = 6
    let r = await gen.generateForCoach({
      coachId, fromDate: today, toDate: tomorrow,
      hours: gen.unionHours((await pool.query(
        `SELECT weekday, to_char(open_time,'HH24:MI') open_time, to_char(close_time,'HH24:MI') close_time, slot_minutes
           FROM venue_business_hours WHERE venue_id=$1`, [VENUE])).rows),
    }, pool);
    assert.strictEqual(r.inserted, 6, `① 應產生 6 格，實際 ${r.inserted}`);
    let cnt = (await pool.query(
      `SELECT count(*)::int n FROM coach_availability_slots WHERE coach_id=$1 AND generated_by='auto'`, [coachId])).rows[0].n;
    assert.strictEqual(cnt, 6, '① DB 應有 6 筆 auto 時段');
    assert.strictEqual((await pool.query(
      `SELECT count(*)::int n FROM coach_availability_slots WHERE coach_id=$1 AND venue_id IS NULL`, [coachId])).rows[0].n,
      6, '① auto 時段的 venue_id 必須為 NULL（預約時才認領）');

    // ② 特殊日期休館：明天休館 → 重跑只會補今天（已存在）→ 0 筆新增
    await pool.query(`INSERT INTO venue_closed_dates (venue_id, closed_date, reason) VALUES ($1,$2::date,'E2E')`,
      [VENUE, tomorrow]);
    const closed = await gen.loadClosedDates(pool, today, tomorrow);
    assert.ok(closed.get(VENUE).has(tomorrow), '② 休館日期應被載入');
    await pool.query(`DELETE FROM coach_availability_slots WHERE coach_id=$1`, [coachId]);
    r = await gen.generateForCoach({
      coachId, fromDate: today, toDate: tomorrow, closedDates: closed.get(VENUE),
      hours: gen.unionHours((await pool.query(
        `SELECT weekday, to_char(open_time,'HH24:MI') open_time, to_char(close_time,'HH24:MI') close_time, slot_minutes
           FROM venue_business_hours WHERE venue_id=$1`, [VENUE])).rows),
    }, pool);
    assert.strictEqual(r.inserted, 3, `② 休館一天後應只剩 3 格，實際 ${r.inserted}`);

    // ③ 智慧記憶：關掉一格 → 清空重產 → 同星期幾同時刻自動 blocked
    const one = (await pool.query(
      `SELECT id, start_at FROM coach_availability_slots WHERE coach_id=$1 ORDER BY start_at LIMIT 1`, [coachId])).rows[0];
    await pool.query(`UPDATE coach_availability_slots SET status='blocked' WHERE id=$1`, [one.id]);
    const prevBlocked = await pool.query(
      `SELECT start_at FROM coach_availability_slots WHERE coach_id=$1 AND status='blocked'`, [coachId]);
    const keys = gen.buildBlockedKeys(prevBlocked.rows);
    assert.strictEqual(keys.size, 1, '③ carry-forward 應記住 1 格');

    // ④ 旗標關閉時，家長端查詢條件應濾掉 NULL venue
    const visibleWhenOff = (await pool.query(
      `SELECT count(*)::int n FROM coach_availability_slots cas
        WHERE cas.coach_id=$1 AND ((cas.venue_id IS NULL AND $2::boolean) OR cas.venue_id=$3)
          AND cas.status='available'`, [coachId, false, VENUE])).rows[0].n;
    assert.strictEqual(visibleWhenOff, 0, '④ 旗標關閉時家長不得看到任何 auto 時段');
    const visibleWhenOn = (await pool.query(
      `SELECT count(*)::int n FROM coach_availability_slots cas
        WHERE cas.coach_id=$1 AND ((cas.venue_id IS NULL AND $2::boolean) OR cas.venue_id=$3)
          AND cas.status='available'`, [coachId, true, VENUE])).rows[0].n;
    assert.ok(visibleWhenOn > 0, '④ 旗標開啟時應看得到');

    // ⑤ 首次提示 ack：冪等，重複呼叫不改時間戳
    await pool.query(
      `UPDATE course_period_enrollments SET booking_notice_ack_at = COALESCE(booking_notice_ack_at, NOW())
        WHERE course_period_id=$1`, [periodId]);
    const t1 = (await pool.query(
      `SELECT booking_notice_ack_at FROM course_period_enrollments WHERE course_period_id=$1`, [periodId])).rows[0].booking_notice_ack_at;
    assert.ok(t1, '⑤ ack 應寫入時間戳');
    await pool.query(
      `UPDATE course_period_enrollments SET booking_notice_ack_at = COALESCE(booking_notice_ack_at, NOW())
        WHERE course_period_id=$1`, [periodId]);
    const t2 = (await pool.query(
      `SELECT booking_notice_ack_at FROM course_period_enrollments WHERE course_period_id=$1`, [periodId])).rows[0].booking_notice_ack_at;
    assert.strictEqual(t1.getTime(), t2.getTime(), '⑤ 重複 ack 不得覆蓋原時間戳');

    // ⑥ 取消 24h 判斷（與後端同一支純函式）
    const now = new Date();
    assert.strictEqual(canSelfCancel(new Date(now.getTime() + 25 * 3600000), now).allowed, true, '⑥ 25h 可取消');
    assert.strictEqual(canSelfCancel(new Date(now.getTime() + 2 * 3600000), now).allowed, false, '⑥ 2h 不可取消');

    // ⑦ 取消並發：同一筆預約同時取消兩次，堆數只能退一次
    {
      const slot = (await pool.query(
        `SELECT id FROM coach_availability_slots WHERE coach_id=$1 AND status='available' ORDER BY start_at LIMIT 1`,
        [coachId])).rows[0];
      const future = new Date(Date.now() + 72 * 3600000);
      await pool.query(`UPDATE coach_availability_slots SET start_at=$2 WHERE id=$1`, [slot.id, future]);
      const sess = (await pool.query(
        `INSERT INTO course_sessions (course_period_id, availability_slot_id, scheduled_at, duration_minutes, status, coach_id)
         VALUES ($1,$2,$3,60,'confirmed',$4) RETURNING id`,
        [periodId, slot.id, future, coachId])).rows[0];
      await pool.query(
        `UPDATE coach_availability_slots SET status='booked', booked_session_id=$1 WHERE id=$2`, [sess.id, slot.id]);
      await pool.query(`UPDATE course_periods SET used_sessions=1 WHERE id=$1`, [periodId]);

      const slots = require('../../server/services/slots');
      const results = await Promise.allSettled([
        slots.cancelSession(sess.id, 'normal'),
        slots.cancelSession(sess.id, 'normal'),
      ]);
      const okCount = results.filter((x) => x.status === 'fulfilled').length;
      const used = Number((await pool.query(
        `SELECT used_sessions FROM course_periods WHERE id=$1`, [periodId])).rows[0].used_sessions);
      const st = (await pool.query(
        `SELECT status, booked_session_id FROM coach_availability_slots WHERE id=$1`, [slot.id])).rows[0];
      assert.ok(okCount >= 1, '⑦ 至少一次取消應成功');
      assert.strictEqual(used, 0, `⑦ 堆數只能退一次，實際 used_sessions=${used}`);
      assert.strictEqual(st.status, 'available', '⑦ 槽位應釋回');
      assert.strictEqual(st.booked_session_id, null, '⑦ booked_session_id 應清空');
    }

    // ⑧ 休館日清除規則：只刪 auto+available+未預約，其餘一律保留
    {
      const day = gen.addDays(today, 5);
      const at = (h) => new Date(day + 'T' + String(h).padStart(2, '0') + ':00:00+08:00');
      // 循環外鍵：course_sessions.availability_slot_id ↔ slots.booked_session_id
      await pool.query("UPDATE coach_availability_slots SET booked_session_id=NULL WHERE coach_id=$1", [coachId]);
      await pool.query('DELETE FROM course_sessions WHERE coach_id=$1', [coachId]);
      await pool.query('DELETE FROM coach_availability_slots WHERE coach_id=$1', [coachId]);
      await pool.query(
        `INSERT INTO coach_availability_slots (coach_id, venue_id, start_at, duration_minutes, status, generated_by)
         VALUES ($1,NULL,$2,60,'available','auto'),
                ($1,NULL,$3,60,'blocked','auto'),
                ($1,$4,$5,60,'available',NULL)`,
        [coachId, at(9), at(10), VENUE, at(11)]);
      const bookedSlot = (await pool.query(
        `INSERT INTO coach_availability_slots (coach_id, venue_id, start_at, duration_minutes, status, generated_by)
         VALUES ($1,NULL,$2,60,'available','auto') RETURNING id`, [coachId, at(12)])).rows[0];
      const bs = (await pool.query(
        `INSERT INTO course_sessions (course_period_id, availability_slot_id, scheduled_at, duration_minutes, status, coach_id)
         VALUES ($1,$2,$3,60,'confirmed',$4) RETURNING id`, [periodId, bookedSlot.id, at(12), coachId])).rows[0];
      await pool.query(
        `UPDATE coach_availability_slots SET status='booked', booked_session_id=$1 WHERE id=$2`, [bs.id, bookedSlot.id]);
      await pool.query(
        `INSERT INTO venue_closed_dates (venue_id, closed_date, reason) VALUES ($1,$2::date,'E2E') ON CONFLICT DO NOTHING`,
        [VENUE, day]);
      const del = await pool.query(
        `DELETE FROM coach_availability_slots cas
          WHERE cas.generated_by = 'auto'
            AND cas.status = 'available'
            AND cas.venue_id IS NULL
            AND cas.booked_session_id IS NULL
            AND (cas.start_at AT TIME ZONE 'Asia/Taipei')::date = $1::date
            AND EXISTS (SELECT 1 FROM coach_venues cv
                         WHERE cv.coach_id = cas.coach_id AND cv.venue_id = $2)
            AND NOT EXISTS (
              SELECT 1 FROM coach_venues cv2
               JOIN venues v2 ON v2.id = cv2.venue_id AND v2.is_active
               WHERE cv2.coach_id = cas.coach_id
                 AND NOT EXISTS (SELECT 1 FROM venue_closed_dates c2
                                  WHERE c2.venue_id = cv2.venue_id AND c2.closed_date = $1::date))
          RETURNING cas.id`, [day, VENUE]);
      assert.strictEqual(del.rowCount, 1, '8 only auto+available+unbooked may be deleted, got ' + del.rowCount);
      const left = (await pool.query(
        'SELECT status, generated_by, booked_session_id FROM coach_availability_slots WHERE coach_id=$1 ORDER BY start_at',
        [coachId])).rows;
      assert.strictEqual(left.length, 3, '8 three rows must remain');
      assert.ok(left.some((x) => x.status === 'blocked' && x.generated_by === 'auto'), '8 coach-blocked must survive');
      assert.ok(left.some((x) => x.generated_by === null), '8 coach-made must survive');
      assert.ok(left.some((x) => x.status === 'booked'), '8 booked must survive');
    }
    console.log('slot_supply_e2e: PASS（8 項全通過）');
  } catch (err) {
    console.error('slot_supply_e2e: FAIL —', err.message);
    process.exitCode = 1;
  } finally {
    await cleanup();
    await pool.end();
  }
})();