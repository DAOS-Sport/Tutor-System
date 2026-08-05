/**
 * 推播安全閥（services/pushGate.js）。
 *
 * 這道閘是「改好 LINE token key 之後不會對全體客戶群發」的唯一保障，
 * 所以最關鍵的性質是 fail-closed：沒設定、設定讀不到、用量查不到 —— 一律不送。
 * 需要真實 Postgres（會讀寫 admin_settings 與 line_push_log），屬 DB 層測試。
 */
const assert = require('assert');
const { pool } = require('../server/models/db');
const gate = require('../server/services/pushGate');

const set = (k, v) => pool.query(
  `INSERT INTO admin_settings (key, value, updated_at) VALUES ($1,$2,NOW())
   ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()`, [k, v]);
const clearSettings = () => pool.query(`DELETE FROM admin_settings WHERE key LIKE 'push\\_%' ESCAPE '\\'`);

let n = 0;
const t = async (name, fn) => { await fn(); n += 1; console.log('  PASS  ' + name); };

(async () => {
  await pool.query(`CREATE TABLE IF NOT EXISTS line_push_log (
    id BIGSERIAL PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    event TEXT NOT NULL, venue_id TEXT, recipient_uid TEXT, recipient_kind TEXT,
    ref_id TEXT, status TEXT NOT NULL, reason TEXT, http_status INT, duration_ms INT)`);
  await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_push_log_dedupe
    ON line_push_log(event, ref_id, recipient_uid) WHERE ref_id IS NOT NULL AND status <> 'failed'`);
  await clearSettings();
  delete process.env.LINE_PUSH_TEST_UID;

  await t('沒有任何設定時什麼都不送', async () => {
    const d = await gate.decide({ event: 'enrollment_success', uid: 'Utest' });
    assert.strictEqual(d.allow, false);
    assert.strictEqual(d.reason, 'DISABLED_GLOBAL');
  });

  await t('只開總開關不夠，分事件也必須明確開啟', async () => {
    await set('push_enabled', 1);
    const d = await gate.decide({ event: 'enrollment_success', uid: 'Utest' });
    assert.strictEqual(d.allow, false);
    assert.ok(String(d.reason).startsWith('DISABLED_EVENT'), d.reason);
  });

  await t('開啟某事件不會連帶開啟其他事件', async () => {
    await set('push_event_enrollment_success', 1);
    assert.strictEqual((await gate.decide({ event: 'enrollment_success', uid: 'U' })).allow, true);
    assert.strictEqual((await gate.decide({ event: 'checkin_confirmed', uid: 'U' })).allow, false);
  });

  await t('放行後預設仍是演練模式（只寫紀錄不送出）', async () => {
    const d = await gate.decide({ event: 'enrollment_success', uid: 'U' });
    assert.strictEqual(d.dryRun, true, '預設就實際送出的話，安全閥等於沒有');
  });

  await t('設了測試收訊者，真實客戶的 uid 會被改寫', async () => {
    process.env.LINE_PUSH_TEST_UID = 'Uonlyme';
    const d = await gate.decide({ event: 'enrollment_success', uid: 'Ureal_customer' });
    assert.strictEqual(d.uid, 'Uonlyme');
    assert.strictEqual(d.redirected, true);
    delete process.env.LINE_PUSH_TEST_UID;
  });

  await t('去重：同一事件+主鍵+收訊者只佔得到一次位', async () => {
    await pool.query(`DELETE FROM line_push_log WHERE event='t_gate'`);
    const a = await gate.claim({ event: 't_gate', refId: 'R1', uid: 'U1', venueId: 'B' });
    const b = await gate.claim({ event: 't_gate', refId: 'R1', uid: 'U1', venueId: 'B' });
    const c = await gate.claim({ event: 't_gate', refId: 'R1', uid: 'U2', venueId: 'B' });
    assert.ok(a, '第一次應該佔得到');
    assert.strictEqual(b, null, '重複的必須被擋');
    assert.ok(c, '不同收訊者不該被連坐');
    // failed 之後要能重試，否則一次網路抖動就永久漏送
    await gate.finish({ id: a, status: 'failed', reason: 'test' });
    assert.ok(await gate.claim({ event: 't_gate', refId: 'R1', uid: 'U1', venueId: 'B' }));
  });

  await t('時窗上限會擋下超量', async () => {
    await set('push_max_per_hour', 0);
    const d = await gate.decide({ event: 'enrollment_success', uid: 'U' });
    assert.strictEqual(d.allow, false);
    assert.ok(String(d.reason).startsWith('RATE_LIMIT'), d.reason);
  });

  // 突變防護：若有人把預設值改成「開」，第一個測試就會紅。
  await t('還原設定後回到 fail-closed', async () => {
    await pool.query(`DELETE FROM line_push_log WHERE event='t_gate'`);
    await clearSettings();
    const d = await gate.decide({ event: 'enrollment_success', uid: 'U' });
    assert.strictEqual(d.allow, false);
    assert.strictEqual(d.reason, 'DISABLED_GLOBAL');
  });

  console.log('\n' + n + ' 個測試全數通過');
  await pool.end();
})().catch(async (e) => {
  console.error('\nFAIL: ' + e.message);
  try { await clearSettings(); await pool.end(); } catch (_) {}
  process.exit(1);
});