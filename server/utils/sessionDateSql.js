/**
 * 教練端課表／記錄的「日期範圍」SQL 片段（一律以台北日曆日為準）。
 *
 * ── 為什麼要抽出來 ──
 * 這些條件原本直接寫死在三支 route 的 SQL 字串裡，各寫各的：
 *   今日課程   以台北日曆日比對（正確）
 *   週課表     cs.scheduled_at >= $2，拿 timestamptz 直接比對日期字串
 *   授課記錄   台北日曆日，但多了一條「< 今天」
 * 三份各自演化的結果就是行為不一致，而且沒有任何測試能同時涵蓋它們。
 * 抽成函式之後，測試可以對「route 真正使用的那一份字串」求值 —— 另外抄一份來驗，
 * 綠燈只代表抄本沒壞。
 *
 * ── 修正紀錄 ──
 * 2026-08-10：授課記錄原本是 `< 今天`，把「今天」整天排除。多位教練回報
 * 「今天上完課也簽到了，記錄裡卻找不到」——而日期選擇器的預設結束日正是今天，
 * 畫面等於明示今天有包含。改為 `<= 今天`：未來的課仍不列（那是排課頁的事），
 * 今天的列。
 *
 * 2026-08-10：週課表改為明確做台北時區轉換。原本 `cs.scheduled_at >= $2` 是拿
 * timestamptz 比對日期字串，Postgres 會用「連線當下的 TimeZone」去解讀那個字串。
 * 正式庫的 TimeZone 剛好是 Asia/Taipei 所以結果正確 —— 但那是巧合不是保證，
 * 任何一個環境沒設對，整週就偏 8 小時（早上的課掉到前一天）。
 */
const TAIPEI = "AT TIME ZONE 'Asia/Taipei'";

/** 把一個 timestamptz 運算式轉成台北日曆日。 */
function taipeiDate(expr) {
  return `((${expr}) ${TAIPEI})::date`;
}

/** 今天（台北）。 */
function taipeiToday() {
  return taipeiDate('NOW()');
}

/** 今日課程：課程當天（台北）＝今天（台北）。 */
function todayWhere(col) {
  return `${taipeiDate(col)} = ${taipeiToday()}`;
}

/**
 * 授課記錄的日期範圍。
 * 不得晚於今天（未來的課屬於排課頁），再加上可選的 from / to。
 * from、to 為 NULL 時該條件不生效。
 */
function historyRangeWhere(col, fromParam, toParam) {
  const d = taipeiDate(col);
  return `${d} <= ${taipeiToday()}
         AND (${fromParam}::date IS NULL OR ${d} >= ${fromParam}::date)
         AND (${toParam}::date IS NULL OR ${d} <= ${toParam}::date)`;
}

/** 週課表：半開區間 [from, to)，以台北日曆日比對。 */
function weekRangeWhere(col, fromParam, toParam) {
  const d = taipeiDate(col);
  return `${d} >= ${fromParam}::date AND ${d} < ${toParam}::date`;
}

module.exports = { taipeiDate, taipeiToday, todayWhere, historyRangeWhere, weekRangeWhere };
