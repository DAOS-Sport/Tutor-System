/**
 * 註冊交易撞到唯一鍵時，家長該被導去人工複核，而不是撞上一堵沒有出口的牆。
 *
 * 2026-08-29 在 dev 實際重現：新戶註冊回 409 LOCAL_LINK_FAILED，
 * 那個碼帶 retryable:false + loginAllowed:false —— 對家長就是死路一條。
 * 真正撞到的是 identity_claims 上的 5 欄唯一索引
 *   (purpose, student_name_normalized, source_system, source_table, source_record_id)
 * 而 _classifyConstraint 的對照表裡沒有這個名字，於是掉進兜底。
 *
 * 對照表是靠「約束名字串」比對的，字串打錯不會有任何人告訴你 ——
 * 只會安靜地把人擋在門外。所以這裡逐一釘住。
 *
 * 另外釘住：不認得的錯誤仍須回 LOCAL_LINK_FAILED（兜底不能被改成放行），
 * 且非 23505 的錯誤不可以被誤判成「資料待對帳」。
 */
const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { __test__ } = require(path.join(ROOT, 'server/services/z03IdentityClaim'));
const classify = __test__.classifyConstraint;

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log('  PASS  ' + name); };

// 名字取自 production 的 pg_indexes / pg_constraint，不是憑印象寫的
const 真實唯一鍵 = [
  'parents_phone_key',
  'parents_line_uid_key',
  'uq_parents_ragic_record_id',
  'uq_students_ragic_record_id',
  'uq_identity_claims_active_source',
  'identity_claims_purpose_source_system_source_table_source_r_key',
];

t('每一個真實存在的唯一鍵都導向人工處理，不是死路', () => {
  for (const name of 真實唯一鍵) {
    const code = classify({ code: '23505', constraint: name });
    assert.notStrictEqual(code, 'LOCAL_LINK_FAILED',
      name + ' 落到兜底 LOCAL_LINK_FAILED —— 那個碼是 retryable:false + loginAllowed:false，'
      + '家長會被永遠擋在門外');
  }
});

t('新戶註冊實際會撞到的那條，歸類為資料待對帳', () => {
  assert.strictEqual(
    classify({ code: '23505', constraint: 'identity_claims_purpose_source_system_source_table_source_r_key' }),
    'DATA_RECONCILIATION_PENDING');
});

t('LINE UID 撞號要走帳號救援（跟一般對帳不同處理）', () => {
  assert.strictEqual(classify({ code: '23505', constraint: 'parents_line_uid_key' }),
    'ACCOUNT_RECOVERY_REQUIRED');
});

t('不認得的唯一鍵仍回兜底，不可以放行', () => {
  assert.strictEqual(classify({ code: '23505', constraint: 'some_index_we_have_never_seen' }),
    'LOCAL_LINK_FAILED');
});

t('不是唯一鍵衝突就不算對帳問題', () => {
  for (const e of [{ code: '23503' }, { code: '42P01' }, { code: undefined }, null, undefined]) {
    assert.strictEqual(classify(e), 'LOCAL_LINK_FAILED', JSON.stringify(e));
  }
});

console.log('\n' + n + ' 個測試全數通過');

