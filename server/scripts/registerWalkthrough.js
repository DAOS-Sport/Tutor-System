/**
 * 新戶註冊流程走查（需要一台跑著的伺服器；預設打 localhost:3001）。
 *
 *   PORT=3001 RAGIC_PARENT_OUTBOX=0 node server/index.js &
 *   node server/scripts/registerWalkthrough.js
 *
 * 用自簽 flowToken 驅動 S2→S5，跳過的只有 LINE 那段 id_token 驗證 ——
 * 那是 LINE 的，不是我們的。其餘每一步都走真正的 HTTP 端點與真正的資料庫。
 *
 * 為什麼要有這支：家長回報「註冊填一填就跳掉」，而後端那筆交易在 catch 裡
 * 把原始錯誤換成 LOCAL_LINK_FAILED 就丟了，log 一行線索都沒有 —— 靠讀程式
 * 是找不到的。實際跑一次才會看到它撞在哪。
 *
 * 只在 dev 跑：它會建立並刪除測試家長。務必確認連的是 dev 資料庫，
 * 而且 RAGIC_PARENT_OUTBOX 是關的 —— Ragic 只有一套，不分環境。
 */
const { signFlowToken } = require('../middlewares/flowAuth');
const { pool } = require('../models/db');

const BASE  = process.env.WALKTHROUGH_BASE || 'http://localhost:3001';

// 每次走查換一組新的 UID。verify-phone 有防列舉限流（ip+uid，5 分鐘 5 次），
// 固定 UID 連跑第二次就會被擋 —— 那是限流在做它該做的事，不是壞掉。
// 換個角度看這也更貼近現實：每個新家庭本來就是一組沒見過的 UID。
const RUN   = process.env.WALKTHROUGH_RUN || String(Date.now());
const UID   = 'DEMOTEST_REGWALK_' + RUN;
const UID2  = 'DEMOTEST_REGWALK_OTHER_' + RUN;
const PHONE = '0900000199';   // 電話固定，才測得到「同電話換一支 LINE」
const EMAIL = 'regwalk@example.test';

let pass = 0, fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' -> ' + detail : '')); }
}

async function call(path, body, token) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body || {}),
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}
async function get(path, token) {
  const r = await fetch(BASE + path, { headers: token ? { authorization: 'Bearer ' + token } : {} });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}
async function patch(path, body, token) {
  const r = await fetch(BASE + path, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: JSON.stringify(body || {}),
  });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
}

// outbox 沒有 parent_id：靠 claim_id 或 payload_reference 裡的 parent uuid 關聯。
const OUTBOX_BY_PARENT =
  "claim_id = $1::uuid OR payload_reference::text LIKE '%' || $1::text || '%'";

// 註冊會沿路建出好幾張表的資料（學員、Z03 認領、稽核…）。與其一張一張猜，
// 直接沿外鍵找出所有指向 parents/students 的子表再刪 —— 漏一張就會卡在 FK 上。
async function fkChildren(parentTable) {
  const q = `
    SELECT tc.table_name AS child, kcu.column_name AS col
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
     WHERE tc.constraint_type='FOREIGN KEY'
       AND ccu.table_name=$1 AND ccu.column_name='id'`;
  return (await pool.query(q, [parentTable])).rows;
}

async function cleanup() {
  // identity_claims 不會跟著 parent 一起被刪，而 source_record_id 是
  // PENDING:<uid+電話+學員姓名的雜湊> —— 留一筆下來，同一組資料就永遠註冊不了，
  // 錯誤還是看不懂的 LOCAL_LINK_FAILED。所以清理必須連它一起，且順序不能錯：
  // outbox → parent_identity_requests → identity_claims → 學員 → 家長。
  // 用 LIKE 掃掉所有歷次走查的殘留，不只這一輪的兩組 UID。
  const q = "SELECT id FROM parents WHERE phone=$1 OR line_uid LIKE 'DEMOTEST_REGWALK\\_%'";
  const pids = (await pool.query(q, [PHONE])).rows.map(r => r.id);
  const claimQ = 'SELECT id FROM identity_claims WHERE phone_canonical=$1'
               + (pids.length ? ' OR canonical_parent_id=ANY($2::uuid[])' : '');
  const cids = (await pool.query(claimQ, pids.length ? [PHONE, pids] : [PHONE])).rows.map(r => r.id);
  if (cids.length) {
    await pool.query('DELETE FROM ragic_sync_outbox WHERE claim_id=ANY($1::uuid[])', [cids]);
    await pool.query('DELETE FROM parent_identity_requests WHERE claim_id=ANY($1::uuid[])', [cids]);
  }
  if (!pids.length) {
    if (cids.length) await pool.query('DELETE FROM identity_claims WHERE id=ANY($1::uuid[])', [cids]);
    return cids.length ? -cids.length : 0;   // 負數＝只有殘骸沒有家長
  }

  const sids = (await pool.query('SELECT id FROM students WHERE parent_id=ANY($1::uuid[])', [pids]))
                 .rows.map(r => r.id);

  if (sids.length) {
    for (const c of await fkChildren('students')) {
      await pool.query(`DELETE FROM "${c.child}" WHERE "${c.col}"=ANY($1::uuid[])`, [sids]).catch(() => {});
    }
  }
  for (const c of await fkChildren('parents')) {
    if (c.child === 'students') continue;   // 學員最後才刪，子表清乾淨了才輪到它
    await pool.query(`DELETE FROM "${c.child}" WHERE "${c.col}"=ANY($1::uuid[])`, [pids]).catch(() => {});
  }
  if (cids.length) await pool.query('DELETE FROM identity_claims WHERE id=ANY($1::uuid[])', [cids]);
  await pool.query('DELETE FROM students WHERE parent_id=ANY($1::uuid[])', [pids]);
  await pool.query('DELETE FROM parents WHERE id=ANY($1::uuid[])', [pids]);

  // 清乾淨才算清乾淨：留下任何一筆，下一輪走查就會撞上而且看不出原因。
  const left = (await pool.query('SELECT count(*)::int n FROM identity_claims WHERE phone_canonical=$1', [PHONE]))
                 .rows[0].n;
  if (left) throw new Error('清理沒清乾淨：identity_claims 還剩 ' + left + ' 筆');
  return pids.length;
}

const student = {
  name: '走查測試學員', id_number: 'A123456789',
  birth_date: '2019-10-05',
  gender: '男', blood_type: 'O',
};

(async () => {
  console.log('=== 清掉上次殘留 ===');
  console.log('  刪除 ' + (await cleanup()) + ' 筆');

  const venue = (await pool.query('SELECT id,name FROM venues WHERE is_active=TRUE ORDER BY id LIMIT 1')).rows[0];
  console.log('  館別：' + venue.id + ' / ' + venue.name);
  const baseParent = { name: '走查測試家長', phone: PHONE, email: EMAIL, gender: '女', primary_venue_id: venue.id };

  console.log('');
  console.log('=== S2 電話驗證：全新電話應走註冊分支 ===');
  const vp = await call('/api/auth/verify-phone', { phone: PHONE }, signFlowToken({ lineUid: UID }));
  console.log('  ' + vp.status + ' ' + JSON.stringify(vp.body));
  ok('全新電話走註冊分支', vp.status === 200 && /not_found|register/i.test(JSON.stringify(vp.body)),
     JSON.stringify(vp.body));

  console.log('');
  console.log('=== S5 表單驗證：該擋的要擋 ===');
  const noEmail = await call('/api/auth/register',
    { parent: { ...baseParent, email: '' }, students: [student] }, signFlowToken({ lineUid: UID }));
  ok('缺 Email 擋下（EMAIL_REQUIRED）', noEmail.status === 400 && noEmail.body?.code === 'EMAIL_REQUIRED',
     noEmail.status + ' ' + JSON.stringify(noEmail.body));

  const badDate = await call('/api/auth/register',
    { parent: baseParent, students: [{ ...student, birth_date: '2019-10' }] }, signFlowToken({ lineUid: UID }));
  ok('生日只填到月份被擋（不是靜默存壞）',
     badDate.status === 400 && /BIRTH_DATE/.test(badDate.body?.code || ''),
     badDate.status + ' ' + JSON.stringify(badDate.body));

  const badId = await call('/api/auth/register',
    { parent: baseParent, students: [{ ...student, id_number: 'A12345678' }] }, signFlowToken({ lineUid: UID }));
  ok('身分證格式錯誤被擋', badId.status === 400 && /ID_NUMBER|STUDENT_ID/.test(badId.body?.code || ''),
     badId.status + ' ' + JSON.stringify(badId.body));

  console.log('');
  console.log('=== S5 正式註冊 ===');
  const reg = await call('/api/auth/register', { parent: baseParent, students: [student] },
                          signFlowToken({ lineUid: UID }));
  console.log('  ' + reg.status + ' status=' + reg.body?.status + ' code=' + (reg.body?.code || '-'));
  ok('註冊成功', reg.status === 200 && !!reg.body?.token, reg.status + ' ' + JSON.stringify(reg.body).slice(0, 400));
  const token = reg.body?.token;
  ok('回應帶 email（橫幅靠這個欄位判斷）', !!reg.body?.parent && ('email' in reg.body.parent),
     JSON.stringify(Object.keys(reg.body?.parent || {})));
  ok('學員一併建立', Array.isArray(reg.body?.parent?.students) && reg.body.parent.students.length === 1,
     JSON.stringify(reg.body?.parent?.students || []));
  ok('生日 2019-10-05 完整存下',
     String(reg.body?.parent?.students?.[0]?.birth_date || '').startsWith('2019-10-05'),
     String(reg.body?.parent?.students?.[0]?.birth_date));

  console.log('');
  console.log('=== 落地檢查（DB） ===');
  const rowQ = 'SELECT p.id,p.name,p.phone,p.email,p.line_uid,p.primary_venue_id,p.is_active,'
             + ' (SELECT count(*) FROM students s WHERE s.parent_id=p.id) AS n_students'
             + ' FROM parents p WHERE p.line_uid=$1';
  const row = (await pool.query(rowQ, [UID])).rows[0];
  console.log('  ' + JSON.stringify(row));
  ok('本地 parent 建好且 active', !!row && row.is_active === true);
  ok('LINE UID 有寫進去（不是空的）', row?.line_uid === UID, String(row?.line_uid));
  ok('Email 有寫進去', row?.email === EMAIL, String(row?.email));
  ok('學員 1 位', Number(row?.n_students) === 1, String(row?.n_students));

  // outbox 沒有 parent_id，靠 claim_id 接回 identity_claims 才找得到這位家長的那一筆。
  const obQ = 'SELECT o.state,o.attempts,o.operation,o.source_record_id'
            + '  FROM ragic_sync_outbox o'
            + '  JOIN identity_claims c ON c.id = o.claim_id'
            + ' WHERE c.canonical_parent_id = $1 ORDER BY o.created_at DESC';
  const ob = (await pool.query(obQ, [row.id])).rows;
  console.log('  outbox: ' + JSON.stringify(ob));
  ok('有排進 outbox 等回寫 Ragic', ob.length >= 1, JSON.stringify(ob));
  ok('dev 沒有真的往 Ragic 寫（旗標關著）', ob.every(r => r.state !== 'synced'), JSON.stringify(ob));

  console.log('');
  console.log('=== 重複註冊：中途跳掉再重來不可以壞掉 ===');
  const again = await call('/api/auth/register', { parent: baseParent, students: [student] },
                            signFlowToken({ lineUid: UID }));
  console.log('  ' + again.status + ' status=' + again.body?.status + ' code=' + (again.body?.code || '-'));
  ok('同一支 LINE 再送一次：直接登入，不會建出第二筆',
     again.status === 200 && again.body?.status === 'registered_and_logged_in',
     again.status + ' ' + JSON.stringify(again.body).slice(0, 200));
  const cnt = (await pool.query('SELECT count(*)::int n FROM parents WHERE phone=$1', [PHONE])).rows[0].n;
  ok('資料庫裡仍然只有一筆', cnt === 1, 'count=' + cnt);

  console.log('');
  console.log('=== 別人拿同一支電話註冊 ===');
  const other = await call('/api/auth/register', { parent: baseParent, students: [student] },
                            signFlowToken({ lineUid: UID2 }));
  ok('同電話換一支 LINE：擋下',
     other.status === 409 && /PHONE_ALREADY_BOUND|PHONE_EXISTS/.test(other.body?.code || ''),
     other.status + ' ' + JSON.stringify(other.body));

  console.log('');
  console.log('=== 登入後的 /parents/me：橫幅判斷的資料來源 ===');
  const me = await get('/api/parents/me', token);
  const p0 = me.body?.parent || me.body;
  ok('/parents/me 200', me.status === 200, me.status + ' ' + JSON.stringify(me.body).slice(0, 200));
  ok('me 帶 email', !!p0 && ('email' in p0), JSON.stringify(Object.keys(p0 || {})));

  console.log('');
  console.log('=== 缺 Email 的家長 -> 自己補 ===');
  await pool.query('UPDATE parents SET email=NULL WHERE id=$1', [row.id]);
  const meNoMail = await get('/api/parents/me', token);
  const p1 = meNoMail.body?.parent || meNoMail.body;
  ok('清空後 me 回 email=null（橫幅會亮）', !!p1 && ('email' in p1) && !p1.email, JSON.stringify(p1?.email));

  // 送出的欄位對齊 ProfilePage 的 saveParent（整包 parentForm，含必填的館別）——
  // 少送 primary_venue_id 會被 FIELD_REQUIRED 擋下，那是測試沒照著真實表單送。
  const fix = await patch('/api/parents/me',
    { name: row.name, phone: PHONE, gender: '女', email: 'fixed@example.test',
      primary_venue_id: venue.id }, token);
  console.log('  PATCH ' + fix.status + ' ' + JSON.stringify(fix.body).slice(0, 250));
  const after = (await pool.query('SELECT email FROM parents WHERE id=$1', [row.id])).rows[0];
  ok('家長自己補的 Email 有存進去（橫幅會消失）', after?.email === 'fixed@example.test', String(after?.email));

  console.log('');
  console.log('=== 收尾：刪掉走查資料 ===');
  console.log('  刪除 ' + (await cleanup()) + ' 筆');

  console.log('');
  console.log(pass + ' 通過 / ' + fail + ' 失敗');
  await pool.end();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('走查中斷：', e); try { await cleanup(); } catch {} process.exit(2); });

