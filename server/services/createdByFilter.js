'use strict';
/**
 * 訂單清單「只列我建的」（使用者 2026-11-03：手動建檔的「建檔記錄」要列出每個帳號自己建過的單）。
 * GET /api/admin/enrollments?createdBy=me → 只回 created_by＝登入帳號（token 的 sub）。
 * 只認 'me'：不接受前端指定別人的帳號。沒有帶 createdBy 時清單行為完全不變。
 * 回傳 false 代表帶了 createdBy=me 卻認不出登入帳號，呼叫端應回 403。
 */
function pushCreatedByMe(req, args, where) {
  if (String((req.query && req.query.createdBy) || '') !== 'me') return true;
  const me = String((req.adminUser && req.adminUser.sub) || '').trim();
  if (!me) return false;
  args.push(me);
  where.push('ae.created_by = $' + args.length);
  return true;
}

module.exports = { pushCreatedByMe };
