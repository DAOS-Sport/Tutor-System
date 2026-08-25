/**
 * 清單分頁參數（?limit=&offset=）。
 *
 * ── 為什麼不是「加大 LIMIT」──
 * 後台幾張表已經破千。原本的做法是寫死 `LIMIT 500`，那等於**靜默截斷**：
 * 學員 850 筆只回 500，畫面看起來完全正常，只是有 350 筆永遠看不到，
 * 沒有任何訊息告訴任何人。把數字調大只是把同一個問題推到更後面。
 *
 * ── 為什麼回傳形狀不變 ──
 * 前端用「這一批回傳筆數 < 要求筆數」判斷到底了，不需要總數。
 * 所以端點照舊回陣列，既有呼叫端一個都不用改。代價是剛好整除時多一次空請求，
 * 那是一次很便宜的請求，換不動介面。
 *
 * defaultLimit 給 null＝沒帶參數就不分頁（維持原行為）；
 * 原本有寫死上限的端點請把它設成原本那個數字，才不會讓舊呼叫端突然多吃資料。
 */
function parsePaging(req, { defaultLimit = null, maxLimit = 500 } = {}) {
  const rawLimit = Number(req.query.limit);
  const rawOffset = Number(req.query.offset);
  const limit = Number.isInteger(rawLimit) && rawLimit > 0
    ? Math.min(rawLimit, maxLimit)
    : defaultLimit;
  const offset = Number.isInteger(rawOffset) && rawOffset > 0 ? rawOffset : 0;
  return { limit, offset };
}

/**
 * 產生 LIMIT/OFFSET 尾巴，並把值 push 進 args。
 * 一定要在其他參數都 push 完之後才呼叫，否則 $n 的編號會對不上。
 */
function pagingSql(args, { limit, offset }) {
  if (limit === null || limit === undefined) return '';
  args.push(limit);
  let sql = ` LIMIT $${args.length}`;
  args.push(offset);
  sql += ` OFFSET $${args.length}`;
  return sql;
}

module.exports = { parsePaging, pagingSql };
