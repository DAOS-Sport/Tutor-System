/**
 * 把每週營業時間壓成緊湊的可讀字串。
 *
 * 教練端只是要「知道依據是什麼」，不是要編輯。七天各一行會把排課總表擠爆，
 * 所以把「連續且時間相同」的星期合併成一段：
 *   週一~週五 05:30–22:00 / 週六 08:00–17:00
 * 沒設定的星期＝休館，直接不出現在清單裡（另外統計成「休館：週日」）。
 */
const WD = ['日', '一', '二', '三', '四', '五', '六'];

export function summarizeWeeklyHours(hours) {
  const byWd = new Map();
  for (const h of hours || []) {
    // Number(null) 是 0——不先擋掉 null/undefined，缺 weekday 的髒資料會被
    // 當成「週日」，畫面上長出一行「週日 undefined–undefined」。
    if (h == null || h.weekday === null || h.weekday === undefined) continue;
    if (!h.open_time || !h.close_time) continue;
    const wd = Number(h.weekday);
    if (!Number.isInteger(wd) || wd < 0 || wd > 6) continue;
    // 同一天多筆（分段營業）時，各段都保留，用 + 串起來。
    const key = `${h.open_time}-${h.close_time}`;
    if (!byWd.has(wd)) byWd.set(wd, new Set());
    byWd.get(wd).add(key);
  }

  const sig = (wd) => {
    const set = byWd.get(wd);
    if (!set || set.size === 0) return null;
    return [...set].sort().join('+');
  };

  const groups = [];
  let start = null;
  for (let wd = 0; wd <= 7; wd += 1) {
    const cur = wd <= 6 ? sig(wd) : null;
    const prev = start === null ? null : sig(start);
    if (cur !== prev) {
      if (start !== null && prev !== null) groups.push({ from: start, to: wd - 1, sig: prev });
      start = wd <= 6 ? wd : null;
    }
  }

  const closedDays = [];
  for (let wd = 0; wd <= 6; wd += 1) if (!sig(wd)) closedDays.push(WD[wd]);

  return {
    // 例：[{ label: '週一~週五', time: '05:30–22:00' }]
    lines: groups.map((g) => ({
      label: g.from === g.to ? `週${WD[g.from]}` : `週${WD[g.from]}~週${WD[g.to]}`,
      time: g.sig.split('+').map((s) => s.replace('-', '–')).join('、'),
    })),
    closedLabel: closedDays.length ? `休館：週${closedDays.join('、週')}` : null,
    hasAny: groups.length > 0,
  };
}

/** 8/17（場地整修） */
export function formatClosedDate(c) {
  const [, m, d] = String(c.closed_date || '').split('-');
  const md = m && d ? `${Number(m)}/${Number(d)}` : String(c.closed_date || '');
  return c.reason ? `${md}（${c.reason}）` : md;
}