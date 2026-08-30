/**
 * 前端診斷回報接收端。
 *
 * 為什麼需要：家長回報「註冊填生日就跳掉」，查了好幾週查不到任何東西 ——
 * 因為畫面在送出前就壞掉了，伺服器端根本沒收到請求，當然沒有 log。
 * 八月有 71 個人登入 LINE 之後從未完成建檔（佔 24%），全部沒有痕跡。
 *
 * 這支就是把那段空白補起來：前端偵測到「面板自己關掉、使用者什麼都沒選」
 * 這類異常時，把事件序列送回來存著，之後用 SQL 就查得到。
 *
 * ── 刻意的設計取捨 ──
 * · 不需要登入：註冊流程本來就還沒有身分，要求登入等於收不到最需要的那些。
 * · 嚴格限量：欄位白名單、每欄長度上限、事件最多 20 筆，超過直接截斷。
 *   這是一個對外開放的端點，能寫進資料庫的東西必須是有界的。
 * · 只收「發生了什麼」，不收「填了什麼」：事件字串是元件自己產生的分類詞
 *   （像 pointerdown ← body），不含姓名、生日、電話。前端也不會送。
 * · 失敗一律安靜：診斷回報自己出錯，絕不可以影響正在註冊的家長。
 */
const express = require('express');
const { pool } = require('../models/db');
const { clientIp, hit } = require('../middlewares/rateLimit');

const router = express.Router();

// 每個 IP 每 5 分鐘最多 20 筆。正常情況一次註冊頂多回報一兩筆；
// 超過這個量不是使用者，是有人在灌。
const BUCKET = new Map();
const RATE = { max: 20, windowMs: 5 * 60 * 1000 };

const KINDS = new Set([
  'picker_closed_without_pick',   // 面板自己關掉，使用者還沒選到日期
  'picker_panel_never_shown',     // 點了欄位但面板始終沒出現
]);

const cut = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);

router.post('/client', async (req, res) => {
  // 不論如何都回 204：這是回報通道，不該讓呼叫端有任何理由重試或顯示錯誤。
  const done = () => res.status(204).end();
  try {
    const ip = clientIp(req);
    if (hit(BUCKET, ip, RATE)) return done();

    const body = req.body || {};
    const kind = cut(body.kind, 40);
    if (!kind || !KINDS.has(kind)) return done();

    const events = Array.isArray(body.events)
      ? body.events.slice(0, 20).map((e) => cut(String(e), 120)).filter(Boolean)
      : [];

    await pool.query(
      `INSERT INTO client_diagnostics (kind, reason, path, user_agent, events)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [kind, cut(body.reason, 60), cut(body.path, 120),
       cut(req.get('user-agent'), 300), JSON.stringify(events)]
    );
    console.warn('[client-diag] ' + kind + ' reason=' + (cut(body.reason, 60) || '-')
      + ' path=' + (cut(body.path, 120) || '-') + ' events=' + events.length);
  } catch (err) {
    // 安靜吞掉：診斷壞掉不可以連累正在註冊的人。
    console.warn('[client-diag] 收取失敗（已忽略）:', err.code || err.message);
  }
  return done();
});

module.exports = router;

