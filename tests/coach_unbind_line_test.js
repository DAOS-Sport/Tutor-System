/**
 * 教練 LINE 解綁（POST /api/admin/staff/:id/unbind-line）。
 *
 * 這支端點原本每一次呼叫都是 500：查詢寫成
 *   FROM admin_staff s LEFT JOIN coaches c ... FOR UPDATE OF c
 * 而 Postgres 不允許鎖 outer join 可為 null 的那一側（0A000）。
 * 錯誤發生在跑 SQL 的當下，連「這個員工存不存在」都還沒判到，
 * 所以不管傳什麼 id 都一樣爆 —— 功能從上線起沒有成功過一次。
 *
 * 打真的 HTTP，不掃原始碼。
 */
const assert = require('assert');
const path = require('path');
const { pool } = require(path.resolve(__dirname, '../server/models/db'));
const { signToken } = require(path.resolve(__dirname, '../server/middlewares/adminAuth'));

const BASE = process.env.TEST_BASE || 'http://localhost:3001';
let n = 0;
const t = async (name, fn) => { await fn(); n += 1; console.log('  PASS  ' + name); };

async function unbind(id, token) {
  const r = await fetch(`${BASE}/api/admin/staff/${encodeURIComponent(id)}/unbind-line`, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
  });
  let body = null;
  try { body = await r.json(); } catch { /* 500 有時不是 JSON */ }
  return { status: r.status, body };
}

(async () => {
  const admin = (await pool.query(
    `SELECT id, username FROM admin_users WHERE role = 'admin' AND is_active LIMIT 1`
  )).rows[0];
  assert.ok(admin, 'dev 上要有一個啟用中的 admin');
  const token = signToken({ id: admin.id, username: admin.username, role: 'admin' });

  await t('查無此員工 → 404，不是 500', async () => {
    const r = await unbind('__no_such_staff__', token);
    assert.strictEqual(r.status, 404,
      '收到 ' + r.status + '：SQL 在判斷員工存不存在之前就爆了（原本的 FOR UPDATE OF c）');
    assert.strictEqual(r.body.error, '找不到該員工');
  });

  // 有 admin_staff 但沒有對應 coaches 的員工
  const notCoach = (await pool.query(
    `SELECT s.id FROM admin_staff s
      WHERE NOT EXISTS (SELECT 1 FROM coaches c WHERE c.ragic_employee_id = s.id)
      LIMIT 1`
  )).rows[0];
  if (notCoach) {
    await t('員工不是教練 → 400 NOT_A_COACH', async () => {
      const r = await unbind(notCoach.id, token);
      assert.strictEqual(r.status, 400, '收到 ' + r.status);
      assert.strictEqual(r.body.code, 'NOT_A_COACH');
    });
  } else {
    console.log('  （dev 上每個員工都有教練資料，略過 NOT_A_COACH）');
  }

  // 是教練但沒綁 LINE
  const unbound = (await pool.query(
    `SELECT s.id FROM admin_staff s
       JOIN coaches c ON c.ragic_employee_id = s.id
      WHERE c.line_uid IS NULL OR btrim(c.line_uid) = ''
      LIMIT 1`
  )).rows[0];
  if (unbound) {
    await t('教練沒綁 LINE → 400 NOT_BOUND', async () => {
      const r = await unbind(unbound.id, token);
      assert.strictEqual(r.status, 400, '收到 ' + r.status);
      assert.strictEqual(r.body.code, 'NOT_BOUND');
    });
  } else {
    console.log('  （dev 上每個教練都綁了 LINE，略過 NOT_BOUND）');
  }

  // 真的解綁一次，然後綁回去 —— 這是唯一能證明「成功路徑」會動的方法
  const bound = (await pool.query(
    `SELECT s.id AS staff_id, c.id AS coach_id, c.line_uid
       FROM admin_staff s JOIN coaches c ON c.ragic_employee_id = s.id
      WHERE c.line_uid IS NOT NULL AND btrim(c.line_uid) <> ''
      LIMIT 1`
  )).rows[0];
  if (bound) {
    await t('有綁 LINE 的教練可以真的解綁，且寫進 audit', async () => {
      const before = bound.line_uid;
      try {
        const r = await unbind(bound.staff_id, token);
        assert.strictEqual(r.status, 200, '收到 ' + r.status + ' ' + JSON.stringify(r.body));
        assert.strictEqual(r.body.ok, true);
        assert.strictEqual(r.body.previous_uid_tail, before.slice(-4));

        const now = await pool.query('SELECT line_uid FROM coaches WHERE id = $1', [bound.coach_id]);
        assert.strictEqual(now.rows[0].line_uid, null, '資料庫裡的 line_uid 沒有真的被清掉');

        const audit = await pool.query(
          `SELECT count(*)::int AS n FROM audit_logs
            WHERE action = 'COACH_LINE_UNBIND' AND $1 = ANY(target_ids)`, [String(bound.staff_id)]);
        assert.ok(audit.rows[0].n > 0, '沒有寫 audit —— 身分綁定變更一定要查得到是誰解的');

        await t('已經解綁的再解一次 → 400 NOT_BOUND（不會重複寫 audit）', async () => {
          const again = await unbind(bound.staff_id, token);
          assert.strictEqual(again.status, 400);
          assert.strictEqual(again.body.code, 'NOT_BOUND');
        });
      } finally {
        // 一律把資料放回去，測試不留痕跡
        await pool.query('UPDATE coaches SET line_uid = $1 WHERE id = $2', [before, bound.coach_id]);
        await pool.query(
          `DELETE FROM audit_logs WHERE action = 'COACH_LINE_UNBIND' AND $1 = ANY(target_ids)`,
          [String(bound.staff_id)]);
      }
    });
  } else {
    console.log('  （dev 上沒有已綁定 LINE 的教練，略過成功路徑）');
  }

  // ── 併發：兩個管理員同時按解綁 ──
  // 鎖的價值只有在併發下才看得出來。循序測試怎麼跑都會過，
  // 所以少了這一條，FOR UPDATE 被拿掉也不會有人發現。
  const race = (await pool.query(
    `SELECT s.id AS staff_id, c.id AS coach_id, c.line_uid
       FROM admin_staff s JOIN coaches c ON c.ragic_employee_id = s.id
      WHERE c.line_uid IS NOT NULL AND btrim(c.line_uid) <> ''
      LIMIT 1`
  )).rows[0];
  if (race) {
    await t('兩個管理員同時解綁，只有一個會成功', async () => {
      const before = race.line_uid;
      try {
        const [a, b] = await Promise.all([
          unbind(race.staff_id, token),
          unbind(race.staff_id, token),
        ]);
        const ok = [a, b].filter((x) => x.status === 200).length;
        const dup = [a, b].filter((x) => x.status === 400 && x.body?.code === 'NOT_BOUND').length;
        assert.strictEqual(ok, 1,
          '有 ' + ok + ' 個成功。沒鎖住的話兩邊都會讀到舊的 line_uid，各自寫一筆 audit');
        assert.strictEqual(dup, 1, '另一個應該收到 NOT_BOUND，實際 ' + JSON.stringify([a.status, b.status]));

        const audit = await pool.query(
          `SELECT count(*)::int AS n FROM audit_logs
            WHERE action = 'COACH_LINE_UNBIND' AND $1 = ANY(target_ids)`, [String(race.staff_id)]);
        assert.strictEqual(audit.rows[0].n, 1, '寫了 ' + audit.rows[0].n + ' 筆 audit，同一次解綁只該有一筆');
      } finally {
        await pool.query('UPDATE coaches SET line_uid = $1 WHERE id = $2', [before, race.coach_id]);
        await pool.query(
          `DELETE FROM audit_logs WHERE action = 'COACH_LINE_UNBIND' AND $1 = ANY(target_ids)`,
          [String(race.staff_id)]);
      }
    });
  } else {
    console.log('  （dev 上沒有已綁定 LINE 的教練，略過併發測試）');
  }

  // ── 鎖：確定性版本 ──
  // 上面那條「兩個同時按」靠的是請求真的重疊，時序不保證，拿掉 FOR UPDATE
  // 它有時候還是會過。這一條自己把鎖握在手上，結果是確定的：
  //
  //   1. 測試 BEGIN，對那一列 SELECT ... FOR UPDATE（握住）
  //   2. 發出解綁請求（不等它）
  //   3. 等一下，確保路由的 SELECT 已經送出去了
  //   4. 測試把 line_uid 改成 NULL 然後 COMMIT
  //
  // 路由有 FOR UPDATE  → 它的 SELECT 一直被擋，等我 COMMIT 之後讀到的是新值
  //                      （FOR UPDATE 會重讀最新已提交的那一版）→ NOT_BOUND
  // 路由沒有 FOR UPDATE → 它的 SELECT 在第 2 步就拿到舊的 UID，照樣往下解綁 → 200
  const lockCase = (await pool.query(
    `SELECT s.id AS staff_id, c.id AS coach_id, c.line_uid
       FROM admin_staff s JOIN coaches c ON c.ragic_employee_id = s.id
      WHERE c.line_uid IS NOT NULL AND btrim(c.line_uid) <> ''
      LIMIT 1`
  )).rows[0];
  if (lockCase) {
    await t('解綁會鎖住那一列：別人先解掉了，自己不會再解一次', async () => {
      const before = lockCase.line_uid;
      const holder = await pool.connect();
      let pending = null;
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT line_uid FROM coaches WHERE id = $1 FOR UPDATE', [lockCase.coach_id]);
        pending = unbind(lockCase.staff_id, token);
        await new Promise((r) => setTimeout(r, 700));
        await holder.query('UPDATE coaches SET line_uid = NULL WHERE id = $1', [lockCase.coach_id]);
        await holder.query('COMMIT');
        const r = await pending;
        assert.strictEqual(r.status, 400,
          '收到 ' + r.status + '：路由讀到的是鎖住之前的舊值，等於沒有鎖 —— 會覆蓋掉別人剛做的解綁');
        assert.strictEqual(r.body.code, 'NOT_BOUND');
      } finally {
        try { await holder.query('ROLLBACK'); } catch { /* 已 COMMIT */ }
        holder.release();
        if (pending) { try { await pending; } catch { /* noop */ } }
        await pool.query('UPDATE coaches SET line_uid = $1 WHERE id = $2', [before, lockCase.coach_id]);
        await pool.query(
          `DELETE FROM audit_logs WHERE action = 'COACH_LINE_UNBIND' AND $1 = ANY(target_ids)`,
          [String(lockCase.staff_id)]);
      }
    });
  }

  console.log('\n' + n + ' 個測試全數通過');
  await pool.end();
})().catch(async (e) => {
  console.error('FAIL ' + e.message);
  try { await pool.end(); } catch { /* noop */ }
  process.exit(1);
});
