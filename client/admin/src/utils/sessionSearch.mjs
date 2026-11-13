// 上課紀錄查詢的快速搜尋（2026-11-03 使用者需求）。
// 只篩「這次查詢已載入」的課堂，所以起訖日與場館條件自然一起套用；打字即時生效，不用再按查詢。
// 空白分開的每個詞都要命中（AND），不分大小寫、全半形。

export function normalizeSearch(value) {
  return String(value == null ? '' : value).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function searchTokens(query) {
  const q = normalizeSearch(query);
  return q ? q.split(' ') : [];
}

// 日期多種寫法都要搜得到：2026-11-01、2026/11/01、11/01、11/1、11-01、1101。
export function dateVariants(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  if (!m) return [];
  const y = m[1], mo = m[2], d = m[3];
  const mn = String(Number(mo)), dn = String(Number(d));
  return [y + '-' + mo + '-' + d, y + '/' + mo + '/' + d, mo + '/' + d, mn + '/' + dn, mo + '-' + d, mo + d];
}

// fields：這一列要被搜尋的文字（呼叫端負責組，讓這裡不依賴畫面格式化函式）。
export function rowMatches(fields, tokens) {
  if (!tokens.length) return true;
  const text = normalizeSearch([fields].flat(Infinity)
    .filter((v) => v !== null && v !== undefined && v !== '').join(' '));
  return tokens.every((t) => text.includes(t));
}

export function filterSessions(list, query, toFields) {
  if (!Array.isArray(list)) return list;
  const tokens = searchTokens(query);
  if (!tokens.length) return list;
  return list.filter((row) => rowMatches(toFields(row), tokens));
}
