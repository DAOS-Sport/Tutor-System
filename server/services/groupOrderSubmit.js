/**
 * 團購送審 — 資格判定、狀態轉換與送審通知的唯一入口。
 *
 * 三條路徑共用同一份條件：
 *   1. 團主在 LIFF 手動送審             routes/groupOrders.js        POST /:id/submit
 *   2. 最後一家補齊付款且已滿團 → 自動送審  routes/groupOrders.js        POST /:id/my-proof
 *   3. 櫃檯在後台代為送審                routes/admin/groupOrders.js  POST /:id/submit
 *
 * 條件只寫這一份是刻意的：三條路徑散在兩個檔案，各自複製一份判斷遲早會漂移
 * （改了「付款齊備」的定義卻只改到其中一條），而漂移的症狀是「有的團送得出去、
 * 有的送不出去」這種極難重現的客訴。
 *
 * 呼叫端必須已在同一個交易內對 group_orders 該列取得 FOR UPDATE —— 加入、上傳付款、
 * 取消、送審都鎖同一列，判定與轉換之間才不會被插隊。
 */
const { pool } = require('../models/db');
const line = require('./line');
const routing = require('./lineRouting');
const { logGroupOrderAudit } = require('./groupOrderAudit');

/**
 * 讀取送審資格。
 *
 * 回傳 { ok, code, total, unpaid }：
 *   ok=false 時 code 為 NOT_FORMING / BELOW_MIN / OVER_CAPACITY / MISSING_PAYMENT_PROOF，
 *   由呼叫端決定要回什麼錯誤，或（自動送審那條）靜默略過。
 *   unpaid 是付款資料不齊的成員列，未遮罩；要不要遮姓名由呼叫端決定
 *   （團主看得到「誰還沒交」但看不到完整個資，櫃檯則看得到）。
 */
async function evaluateSubmitReadiness(client, order) {
  if (!order || order.status !== 'forming') {
    return { ok: false, code: 'NOT_FORMING', total: 0, unpaid: [] };
  }
  const cur = await client.query(
    `SELECT COALESCE(SUM(COALESCE(array_length(student_names,1),0)),0) AS total
       FROM group_order_members WHERE group_order_id = $1`,
    [order.id]
  );
  const total = Number(cur.rows[0].total);
  if (total < order.min_students) {
    return { ok: false, code: 'BELOW_MIN', total, unpaid: [] };
  }
  if (total > order.max_students) {
    return { ok: false, code: 'OVER_CAPACITY', total, unpaid: [] };
  }
  // 「付款齊備」在送審端比後台核准端嚴：核准端維持「末 5 碼或證明擇一」以相容既有
  // 已送審單，送審端要求兩者都有，把不完整的團擋在家長端而不是送進後台才被退。
  const unpaid = await client.query(
    `SELECT m.id, p.name AS parent_name
       FROM group_order_members m
       JOIN parents p ON p.id = m.parent_id
      WHERE m.group_order_id = $1
        AND (m.payment_proof_url IS NULL
             OR NULLIF(TRIM(COALESCE(m.transfer_last_5, '')), '') IS NULL)
      ORDER BY m.is_leader DESC, m.joined_at ASC`,
    [order.id]
  );
  if (unpaid.rowCount) {
    return { ok: false, code: 'MISSING_PAYMENT_PROOF', total, unpaid: unpaid.rows };
  }
  return { ok: true, code: null, total, unpaid: [] };
}

/**
 * 自動送審的額外門檻：必須滿團（人數達 max_students）。
 *
 * 用 max 而不是 min 是刻意的 —— 送審會鎖名單（加入端要求 status='forming'），
 * 一對三（min 2 / max 3）若在第 2 家付完款當下就自動送出，第 3 家永遠加不進來。
 * 現況佐證：已送審／已核准的 35 個團有 31 個是滿團送出，一對三有 8/9 團收滿 3 人；
 * 且六種組別裡有四種本來就是 min == max（1/1、2/2、4/4、5/5），滿團門檻對它們
 * 與「全員付款齊備」完全等價。
 *
 * 未滿團但全員已付款的（一對三 2/3、一對六 5/6）不自動送：團主在 LIFF 仍可自己按
 * 送審決定提早成團，櫃檯也看得到（後台「揪團中·已收齊款」分頁可代為送審）。
 */
function isFullHouse(order, total) {
  return Number(total) >= Number(order.max_students);
}

/**
 * 實際轉換 forming → submitted。
 *
 * 條件式 UPDATE（WHERE status='forming'）：狀態已被別的請求改掉就回 null，
 * 讓併發的兩條路徑 —— 例如最後一家上傳的同一瞬間團主也按了送審 —— 只有一邊成功，
 * 不會寫出兩筆送審稽核，也不會覆蓋掉已核准／已取消的終態。
 */
async function markSubmitted(client, order, { action, by }) {
  const r = await client.query(
    `UPDATE group_orders SET status='submitted', submitted_at=NOW(), updated_at=NOW()
      WHERE id = $1 AND status = 'forming' RETURNING *`,
    [order.id]
  );
  if (!r.rowCount) return null;
  await logGroupOrderAudit(client, { groupOrderId: order.id, action, by });
  return r.rows[0];
}

/**
 * 團報送審完成 → 通知全團每個家庭。
 *
 * 每位家長各自依「自己的來源 provider」路由（services/lineRouting）—— 不可用
 * group_orders.venue_id 當 channel：那是團購所屬場館，不是家長 uid 的歸屬，
 * 拿它去查 token 會送出一整排 404。
 *
 * 去重用 refId = 'gs:<order_id>:<parent_id>'，同一團同一家長只會通知一次
 * （送審→退回→再送審時，refId 相同故不重複打擾；要重送請走退回流程的通知）。
 * 全程 best-effort：送審已經 COMMIT，推播失敗不該影響它。
 */
async function notifyGroupSubmitted(orderId, totalStudentCount) {
  const r = await pool.query(
    `SELECT m.parent_id, p.line_uid, p.primary_venue_id,
            go.course_type, v.name AS venue_name
       FROM group_order_members m
       JOIN group_orders go ON go.id = m.group_order_id
       JOIN parents p ON p.id = m.parent_id
       LEFT JOIN venues v ON v.id = go.venue_id
      WHERE m.group_order_id = $1
        AND p.line_uid IS NOT NULL AND p.line_uid <> ''`,
    [orderId]);
  if (!r.rowCount) return;

  const liffBase = (process.env.LIFF_URL_PARENT || process.env.LIFF_URL || '').replace(/\/$/, '');
  const liffUrl = liffBase ? liffBase + '/group/' + orderId : '';

  for (const row of r.rows) {
    const ch = (await routing.resolveChannel({ kind: 'parent', venueId: row.primary_venue_id })).channel;
    if (!ch) continue;   // 路由查不到就跳過；pushGate 那層也會記錄原因
    try {
      await line.pushMessage(
        row.line_uid,
        line.templates.groupSubmitted({
          total: totalStudentCount,
          venueName: row.venue_name,
          courseType: row.course_type ? '1 對 ' + row.course_type : null,
          liffUrl,
        }),
        ch,
        { event: 'group_submitted', refId: 'gs:' + orderId + ':' + row.parent_id, recipientKind: 'parent' });
    } catch (e) {
      console.warn('[group submit push] parent=' + row.parent_id + ' ' + e.message);
    }
  }
}

module.exports = { evaluateSubmitReadiness, isFullHouse, markSubmitted, notifyGroupSubmitted };
