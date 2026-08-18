/**
 * 報名成功推播 —— 只推給「教練」。
 *
 * 家長端走 Email（services/reconcileNotify.js），這裡不碰家長。兩條線刻意分開：
 * 家長要的是發票與金額，教練要的是「誰要來上課、上幾期」。
 *
 * ── 觸發時機 ──
 * 對帳通過的同一個位置（admin/enrollments.js、admin/checkouts.js 的
 * enqueueReconcileMail 旁）。報名送出時不推 —— 那時還沒收到錢。
 *
 * ── 一則 = 一個 enrollment_batch_id ──
 * 不是一列，也不是 (batch, period)。一次報三期就是一則寫「報名 3 期」，
 * 不是三則。這與教練端「報名記錄」頁的筆數口徑刻意不同：那一頁要看每期進度，
 * 所以拆開；推播是一次性通知，合併才不吵。
 * 正式庫實測：以 batch 為單位，八月約 100 則／月。
 *
 * ── 團報為什麼「不」合併成一則（2026-08-18 驗工結論）──
 * 團報是一個家庭一個 batch、一張付款單、一張發票。實測 16 個多-batch 團報，
 * batch 數 = checkout 數，一個都不例外 —— 也就是各家庭「分開對帳」，在單一次
 * 路由呼叫裡根本湊不齊。
 * 若改成以 group_order_id 去重、只推一則：先對帳的那家觸發推播，之後對帳的
 * 家庭會被去重擋掉，教練「完全收不到」。16 個團裡有 4 個會中招（3 個同日不同時、
 * 1 個相隔 30.8 天）。漏掉通知比多收一則嚴重得多。
 * 所以維持一家一則，改為在內容帶上「同班已報 N／M 位」——
 * 教練看得出這是同一個班在陸續填滿，而不是四個各自獨立的班。
 * 名冊只算「這位教練自己帶的」，不會把別位教練的學生端給他看。
 *
 * ── period_count 欄位不可信 ──
 * 2026-08-18 實測：69 個多期訂單的 period_count 全部與實際期數不符，
 * 單期的 269 個裡也有 6 個錯。期數一律 count(DISTINCT period_number) 數出來。
 *
 * ── 不放金額 ──
 * 教練端訂單 API 本來就不回金額／發票／匯款資訊，推播不在這裡開後門。
 * 下面的 SQL 沒有 SELECT 任何金額欄位，是刻意的。
 */
const line = require('./line');
const routing = require('./lineRouting');
const { pool } = require('../models/db');

const EVENT = 'enrollment_success_coach';

const COURSE_TYPE_LABEL = (n) => {
  const v = Number(n);
  return Number.isFinite(v) && v >= 1 && v <= 6 ? `1 對 ${v}` : null;
};

/**
 * 撈一個 batch 的推播素材。
 * 回 null＝這批不該推（沒對到教練、教練沒綁 LINE、或沒有 confirmed 的列）。
 */
async function loadBatch(db, batchId) {
  const r = await db.query(
    `SELECT
        e.coach_id,
        c.line_uid                              AS coach_uid,
        max(e.course_type)                      AS course_type,
        max(e.venue_id)                         AS venue_id,
        max(v.name)                             AS venue_name,
        -- 期數：數實際出現過幾個 period_number。不可讀 e.period_count。
        count(DISTINCT e.period_number)         AS periods,
        -- 每期堂數：同一批各期一致（實測 0 筆不一致）；仍取 max 以防單筆髒資料。
        max(e.total_sessions)                   AS sessions_per_period,
        bool_or(e.group_order_id IS NOT NULL)   AS is_group,
        array_agg(DISTINCT e.parent_name)       AS parent_names,
        array_agg(DISTINCT s)                   AS student_names,
        max(e.group_order_id::text)             AS group_order_id
       FROM admin_enrollments e
       LEFT JOIN admin_venues v ON v.id = e.venue_id
       CROSS JOIN LATERAL unnest(COALESCE(e.students, ARRAY[]::text[])) AS s
       JOIN coaches c ON c.id = e.coach_id
      WHERE e.enrollment_batch_id = $1
        AND e.status = 'confirmed'
      GROUP BY e.coach_id, c.line_uid`,
    [batchId]
  );
  // 跨教練的 batch 正式庫是 0 筆，但真出現時寧可不推也不要推錯人。
  if (r.rows.length !== 1) return null;
  const row = r.rows[0];
  if (!row.coach_uid) return null;

  // 團報：算「同一團、同一位教練」目前已對帳的學員數，讓教練看得出班在填滿。
  // 只算自己帶的 —— 同團若有兩位教練（實測 2 例），不該把別人的學生端給他看。
  if (row.group_order_id) {
    const g = await db.query(
      `SELECT count(DISTINCT s) AS n
         FROM admin_enrollments e
         CROSS JOIN LATERAL unnest(COALESCE(e.students, ARRAY[]::text[])) AS s
        WHERE e.group_order_id = $1 AND e.coach_id = $2 AND e.status = 'confirmed'`,
      [row.group_order_id, row.coach_id]
    );
    row.group_done = Number(g.rows[0]?.n) || 0;
    // 班級容量＝課別（course_type = N 代表 1 對 N）。超出容量時不顯示分母，
    // 印「5／4 位」只會讓教練以為系統壞了。
    const cap = Number(row.course_type);
    row.group_cap = Number.isFinite(cap) && cap >= row.group_done ? cap : null;
  }
  return row;
}

/** 家長欄：一位就印名字，多位印「第一位 等 N 位」（團報跨家庭才會 >1）。 */
function parentLabelOf(names) {
  const list = (names || []).map((x) => String(x || '').trim()).filter(Boolean);
  if (!list.length) return null;
  return list.length === 1 ? list[0] : `${list[0]} 等 ${list.length} 位`;
}

async function notifyEnrollment(batchId, db = pool) {
  const out = { sent: 0, skipped: 0, failed: 0 };
  if (!batchId) return out;

  const row = await loadBatch(db, batchId);
  if (!row) { out.skipped += 1; return out; }

  const { channel } = await routing.resolveChannel({ kind: 'coach' });
  if (!channel) {
    out.skipped += 1;
    console.error('[enrollmentNotify] 找不到教練推播目的地，跳過。'
      + '請確認 services/lineRouting.js 的 STAFF_CHANNEL 有 token。');
    return out;
  }

  try {
    const res = await line.pushMessage(
      row.coach_uid,
      line.templates.enrollmentSuccessToCoach({
        studentNames: row.student_names || [],
        periods: Number(row.periods) || 1,
        sessionsPerPeriod: Number(row.sessions_per_period) || undefined,
        courseType: COURSE_TYPE_LABEL(row.course_type),
        venueName: row.venue_name || row.venue_id || null,
        parentLabel: parentLabelOf(row.parent_names),
        isGroup: !!row.is_group,
        groupDone: row.group_done,
        groupCap: row.group_cap,
      }),
      channel,
      // 去重鍵：同一位教練 + 同一個 batch 只推一次。對帳流程可能重跑
      // （重試、人工重按），沒有這層會重複打擾教練。
      { event: EVENT, refId: 'er:' + row.coach_id + ':' + batchId, recipientKind: 'coach' }
    );
    if (res && res.sent) out.sent += 1; else out.skipped += 1;
  } catch (e) {
    out.failed += 1;
    console.warn('[enrollmentNotify] 教練推播失敗：' + e.message);
  }
  return out;
}

/**
 * 呼叫端用這支：對帳已經 COMMIT，推播不該把它拖下水，也不該讓它 throw 出去。
 * 與 checkinNotify.notifyCheckinSafely 同一個約定。
 */
function notifyEnrollmentSafely(batchId, db) {
  Promise.resolve()
    .then(() => notifyEnrollment(batchId, db))
    .catch((e) => console.warn('[enrollmentNotify] 未預期例外：' + e.message));
}

module.exports = { EVENT, notifyEnrollment, notifyEnrollmentSafely, parentLabelOf, COURSE_TYPE_LABEL };
