#!/usr/bin/env node
/**
 * Ragic + LINE 登入鏈路煙霧測試（READ-ONLY by default）
 *
 * 預設：只做 env 檢查 + 兩支 read API（getParentByLineUid / getParentByPhone）。
 * 寫入測試必須開啟 env：
 *   ENABLE_RAGIC_WRITE_SMOKE=1
 *   TEST_PHONE=09xxxxxxxx
 *   TEST_PARENT_NAME=測試家長
 *   TEST_LINE_UID=U_xxx
 * 並請使用 UAT / 測試帳號，不可在正式 Ragic 上跑。
 *
 * 用法：
 *   cd server && npm run smoke:ragic-auth
 *
 * 退出碼：0=全部 PASS，1=有 FAIL（缺 env / API 噴錯 / 違反預期）
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const REQUIRED_ENV = [
  'RAGIC_API_KEY',
  'RAGIC_BASE_URL',
  'RAGIC_FORM_Z01',
  'RAGIC_FORM_H01',
  'LINE_LOGIN_CHANNEL_ID',
];

const results = [];
function record(name, ok, info) {
  results.push({ name, ok, info: info || '' });
  const tag = ok ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}${info ? ' — ' + info : ''}`);
}

function summary() {
  const fails = results.filter((r) => !r.ok);
  console.log('');
  console.log(`Summary: ${results.length - fails.length} PASS / ${fails.length} FAIL`);
  if (fails.length) {
    console.log('Failed:');
    fails.forEach((r) => console.log('  -', r.name, r.info ? '— ' + r.info : ''));
  }
  process.exit(fails.length ? 1 : 0);
}

(async () => {
  console.log('=== Ragic + LINE auth smoke (read-only by default) ===');

  // 1) Env presence
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  record('env.required', missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : 'all present');
  if (missing.length) return summary();

  // 2) Ragic LINE UID field IDs — 一律取自凍結點 config/ragicSchema.js。
  //    H01 教練 uid 固定 1003633，不允許 env 覆寫或欄名猜測。
  const { LINE_UID_FIELD } = require('../config/ragicSchema');
  const z01Field = LINE_UID_FIELD.Z01;
  const h01Field = LINE_UID_FIELD.H01;
  record('env.z01_line_uid_field', !!z01Field, `Z01 = ${z01Field}`);
  record('env.h01_line_uid_field', h01Field === '1003633', `H01 = ${h01Field} (固定 1003633)`);

  // 3) Ragic module loads + functions present
  let ragic;
  try {
    ragic = require('../services/ragic');
    record('ragic.module.loaded', true);
  } catch (e) {
    record('ragic.module.loaded', false, e.message);
    return summary();
  }
  ['getParentByLineUid', 'getParentByPhone', 'createParentWithStudentsInRagic']
    .forEach((fn) => record(`ragic.has.${fn}`, typeof ragic[fn] === 'function'));

  // 4) READ: getParentByLineUid 用一個不存在的 UID → 預期 null（或 undefined）
  try {
    const r = await ragic.getParentByLineUid('__smoke_no_such_uid__');
    record('ragic.getParentByLineUid(nonexistent)→null', r == null,
      r == null ? 'returned nullish' : 'unexpected result, type=' + typeof r);
  } catch (e) {
    record('ragic.getParentByLineUid(nonexistent)→null', false, e.message);
  }

  // 5) READ: getParentByPhone 用測試假號 → 不應寫入；查到也只回報
  const SAFE_NONEXISTENT_PHONE = '0999999999';
  try {
    const r = await ragic.getParentByPhone(SAFE_NONEXISTENT_PHONE);
    if (r == null) {
      record('ragic.getParentByPhone(0999999999)→null', true, 'expected null');
    } else {
      // 查到了：read-only 模式只回報，不修改、不視為失敗
      record('ragic.getParentByPhone(0999999999)→null', true,
        `WARNING: a record actually exists for ${SAFE_NONEXISTENT_PHONE} (no write performed)`);
    }
  } catch (e) {
    record('ragic.getParentByPhone(0999999999)→null', false, e.message);
  }

  // 6) Write smoke（env-gated）
  const enableWrite = process.env.ENABLE_RAGIC_WRITE_SMOKE === '1';
  if (!enableWrite) {
    console.log('');
    console.log('[skip] write smoke disabled (set ENABLE_RAGIC_WRITE_SMOKE=1 + TEST_PHONE/TEST_PARENT_NAME/TEST_LINE_UID to enable)');
    return summary();
  }

  const TEST_PHONE = process.env.TEST_PHONE;
  const TEST_NAME  = process.env.TEST_PARENT_NAME;
  const TEST_UID   = process.env.TEST_LINE_UID;
  const writeMissing = ['TEST_PHONE', 'TEST_PARENT_NAME', 'TEST_LINE_UID']
    .filter((k) => !process.env[k]);
  if (writeMissing.length) {
    record('write.env.required', false, `missing: ${writeMissing.join(', ')}`);
    return summary();
  }

  console.log('');
  console.log('!!! ENABLE_RAGIC_WRITE_SMOKE=1 → 即將寫入 Ragic Z01（不可逆）!!!');
  console.log(`    parent.name=${TEST_NAME}  phone=${TEST_PHONE}  line_uid=${TEST_UID}`);
  console.log('    若這是正式環境，請立即 Ctrl+C 中止。');
  // 給 operator 3 秒中止
  await new Promise((r) => setTimeout(r, 3000));

  try {
    const out = await ragic.createParentWithStudentsInRagic({
      parent: { name: TEST_NAME, phone: TEST_PHONE, gender: '不方便透露', email: null, primary_venue_id: null },
      students: [{ name: TEST_NAME + '-測試學員', id_number: null, birth_date: null, gender: null }],
      lineUid: TEST_UID,
    });
    record('ragic.createParentWithStudentsInRagic', !!out?.ragicRecordId,
      out?.ragicRecordId ? `recordId=${out.ragicRecordId}` : 'no ragicRecordId');
  } catch (e) {
    record('ragic.createParentWithStudentsInRagic', false, e.message);
  }

  return summary();
})().catch((e) => {
  console.error('smoke crashed:', e);
  process.exit(1);
});
