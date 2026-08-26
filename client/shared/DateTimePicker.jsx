import React, { useEffect, useRef, useState } from 'react';

/**
 * 共用日期／時間選擇器（取代原生 <input type="date|time|datetime-local">）
 *
 * 為什麼不用原生：彈出面板由瀏覽器畫，樣式完全無法控制，Chrome／Safari／Firefox
 * 各長一個樣，且中文環境下 Chrome 會出現「下午 02:58」這種與系統其他地方不一致的寫法。
 *
 * ⚠️ 這支放在 client/shared，兩個前端共用。Tailwind 的 content glob 必須含
 *    '../shared/**' 才掃得到這裡的 class（兩個 tailwind.config.js 都已加）。
 *    拿掉的話樣式會靜默消失 —— 建置不報錯，畫面直接裸奔。
 *
 * 值格式與原生 input 完全相同，所以呼叫端的驗證、min/max 比較、送出邏輯都不必改：
 *   mode="date"      → 'YYYY-MM-DD'
 *   mode="datetime"  → 'YYYY-MM-DDTHH:MM'
 *   mode="time"      → 'HH:MM'
 * 空字串一律代表「未指定」，與原生 input 的空值語意一致。
 *
 * 日期運算一律 Date.UTC + getUTC*：只是拿來算「幾號星期幾」「這個月幾天」，
 * 用本地時區的 Date 會在 UTC+8 的月底邊界差一天。
 */

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];
const MONTHS = ['1 月', '2 月', '3 月', '4 月', '5 月', '6 月', '7 月', '8 月', '9 月', '10 月', '11 月', '12 月'];
const pad2 = (n) => String(n).padStart(2, '0');

const RE = {
  date: /^(\d{4})-(\d{2})-(\d{2})$/,
  datetime: /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/,
  time: /^(\d{2}):(\d{2})$/,
};

function parse(value, mode) {
  const m = RE[mode].exec(String(value ?? '').trim());
  if (!m) return null;
  if (mode === 'time') return { y: 0, mo: 1, d: 1, hh: +m[1], mi: +m[2] };
  return { y: +m[1], mo: +m[2], d: +m[3], hh: mode === 'datetime' ? +m[4] : 0, mi: mode === 'datetime' ? +m[5] : 0 };
}
function compose(p, mode) {
  if (mode === 'time') return `${pad2(p.hh)}:${pad2(p.mi)}`;
  const day = `${p.y}-${pad2(p.mo)}-${pad2(p.d)}`;
  return mode === 'datetime' ? `${day}T${pad2(p.hh)}:${pad2(p.mi)}` : day;
}
const dayKey = (y, mo, d) => `${y}-${pad2(mo)}-${pad2(d)}`;
const daysInMonth = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
const firstDow = (y, mo) => new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();
const todayParts = () => {
  // 台北時間的今天。伺服器與櫃台電腦都在 UTC+8，但瀏覽器時區設錯時
  // 不該讓「今天」跟著飄，所以明確加 8 小時後取 UTC 部分。
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), hh: t.getUTCHours(), mi: t.getUTCMinutes() };
};

function TimeSelects({ cur, minP, maxP, sameMinDay, sameMaxDay, onPick, compact = false }) {
  const hourMin = sameMinDay ? minP.hh : 0;
  const hourMax = sameMaxDay ? maxP.hh : 23;
  const miMin = sameMinDay && cur.hh === minP.hh ? minP.mi : 0;
  const miMax = sameMaxDay && cur.hh === maxP.hh ? maxP.mi : 59;
  const cls = `rounded-lg border border-gray-300 bg-white py-1.5 pl-2 pr-6 font-mono text-sm tabular-nums focus:border-brand-teal focus:outline-none ${compact ? '' : ''}`;
  return (
    <>
      <select
        aria-label="時" value={cur.hh} className={cls}
        onChange={(e) => onPick({ ...cur, hh: Number(e.target.value) })}
      >
        {Array.from({ length: 24 }, (_, h) => (
          <option key={h} value={h} disabled={h < hourMin || h > hourMax}>{pad2(h)}</option>
        ))}
      </select>
      <span className="font-bold text-gray-400">:</span>
      <select
        aria-label="分" value={cur.mi} className={cls}
        onChange={(e) => onPick({ ...cur, mi: Number(e.target.value) })}
      >
        {Array.from({ length: 60 }, (_, m) => (
          <option key={m} value={m} disabled={m < miMin || m > miMax}>{pad2(m)}</option>
        ))}
      </select>
    </>
  );
}

export default function DateTimePicker({
  id,
  mode = 'date',
  value,
  min,
  max,
  onChange,
  clearable = false,
  placeholder,
  disabled = false,
  className = '',
}) {
  const [open, setOpen] = useState(false);
  const [pickingMonth, setPickingMonth] = useState(false);
  const boxRef = useRef(null);

  const parsed = parse(value, mode);
  const minP = parse(min, mode);
  const maxP = parse(max, mode);
  const today = todayParts();

  // 空值時面板要停在一個合理的月份：優先今天，被 min/max 擋掉就靠過去。
  const anchor = parsed || (() => {
    const t = { ...today, hh: 0, mi: 0 };
    if (maxP && dayKey(t.y, t.mo, t.d) > dayKey(maxP.y, maxP.mo, maxP.d)) return maxP;
    if (minP && dayKey(t.y, t.mo, t.d) < dayKey(minP.y, minP.mo, minP.d)) return minP;
    return t;
  })();

  const [viewY, setViewY] = useState(anchor.y);
  const [viewMo, setViewMo] = useState(anchor.mo);

  // 每次打開都跳回目前選到的月份 —— 上次翻到哪不該被記住。
  useEffect(() => {
    if (!open) { setPickingMonth(false); return; }
    setViewY(anchor.y);
    setViewMo(anchor.mo);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  // 面板座標。改成 fixed + 實測值，是為了兩件原本各自會壞的事：
  //   1. 原本 `absolute left-0 w-[292px]`：面板固定 292px 又貼齊觸發鈕左緣，
  //      觸發鈕只要不在最左邊就爆版。SessionsPage 的「迄日」起點約 x=176，
  //      右緣算到 468px，375px 螢幕上切掉 93 px —— 右下角那顆「完成」整顆在畫面外，
  //      而面板本身沒有捲動，使用者只能重整頁面。
  //   2. absolute 會被任何 overflow-y-auto 祖先裁掉。modal 內層補上可捲動之後
  //      （ConfirmDialog 正好被 SessionsPage 拿來包這支選擇器）面板會被切一半。
  // fixed 不吃祖先的 overflow，座標自己夾在視窗內；桌機的觸發鈕碰不到夾擠邊界，
  // 算出來就是原本的 left / top+8，所以桌機視覺與行為維持不變。
  const [panel, setPanel] = useState(null);
  useEffect(() => {
    if (!open) { setPanel(null); return undefined; }
    const place = () => {
      const r = boxRef.current?.getBoundingClientRect();
      if (!r) return;
      const M = 8;              // 與視窗邊緣的最小留白
      const GAP = 8;            // 觸發鈕與面板的距離（等同原本的 mt-2）
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = Math.min(292, vw - M * 2);   // 桌機維持 292；窄到放不下才縮
      const below = vh - r.bottom - GAP - M;
      const above = r.top - GAP - M;
      // 812 高的手機上，長在頁面下半部的觸發鈕往下展開會把日曆推出畫面底部，
      // 「完成」一樣按不到。下方不夠就翻到上方，兩邊都不夠取較寬的一側，
      // 再用 maxHeight + 內捲兜底（與 modal 用的是同一招）。
      const flip = below < 300 && above > below;
      setPanel({
        left: Math.min(Math.max(M, r.left), Math.max(M, vw - w - M)),
        top: flip ? undefined : r.bottom + GAP,
        bottom: flip ? vh - r.top + GAP : undefined,
        width: w,
        maxHeight: Math.max(200, flip ? above : below),
      });
    };
    place();
    // fixed 不會自己黏著觸發鈕，捲動與轉向都要重算。
    // 第三參數 true＝捕獲階段，這樣祖先容器（modal 內層）的捲動也收得到。
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => { window.removeEventListener('scroll', place, true); window.removeEventListener('resize', place); };
  }, [open]);

  const minDay = minP ? dayKey(minP.y, minP.mo, minP.d) : null;
  const maxDay = maxP ? dayKey(maxP.y, maxP.mo, maxP.d) : null;
  const todayKey = dayKey(today.y, today.mo, today.d);
  const selKey = parsed ? dayKey(parsed.y, parsed.mo, parsed.d) : null;

  function emit(next) {
    let out = compose(next, mode);
    // 夾回界線：選到 min/max 當天時，時分可能越界。
    if (max && out > max) out = max;
    if (min && out < min) out = min;
    onChange?.(out);
  }

  // ── mode="time"：沒有日曆可畫，直接內嵌兩個下拉，少一次點擊。 ──
  if (mode === 'time') {
    const cur = parsed || { hh: 0, mi: 0 };
    return (
      <span id={id} className={`inline-flex items-center gap-1.5 ${className}`}>
        <TimeSelects cur={cur} minP={minP} maxP={maxP} sameMinDay={!!minP} sameMaxDay={!!maxP} onPick={emit} compact />
      </span>
    );
  }

  const yearFrom = minP ? minP.y : today.y - 100;
  const yearTo = maxP ? maxP.y : today.y + 5;

  function pickDay(d) {
    emit({ ...(parsed || { hh: 0, mi: 0 }), y: viewY, mo: viewMo, d });
    if (mode === 'date') setOpen(false);   // 純日期選完就沒別的事了
  }

  function shiftMonth(delta) {
    let y = viewY;
    let mo = viewMo + delta;
    if (mo < 1) { mo = 12; y -= 1; }
    if (mo > 12) { mo = 1; y += 1; }
    setViewY(y);
    setViewMo(mo);
  }

  const prevBlocked = !!minDay && dayKey(viewY, viewMo, 1) <= minDay;
  const nextBlocked = !!maxDay && dayKey(viewY, viewMo, daysInMonth(viewY, viewMo)) >= maxDay;

  const lead = firstDow(viewY, viewMo);
  const total = daysInMonth(viewY, viewMo);
  const label = parsed
    ? (mode === 'datetime'
      ? `${parsed.y}/${pad2(parsed.mo)}/${pad2(parsed.d)}  ${pad2(parsed.hh)}:${pad2(parsed.mi)}`
      : `${parsed.y}/${pad2(parsed.mo)}/${pad2(parsed.d)}`)
    : '';

  return (
    <div className={`relative ${className}`} ref={boxRef}>
      <button
        id={id}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-sm transition ${
          open ? 'border-brand-teal ring-2 ring-brand-teal/20' : 'border-gray-300 hover:border-gray-400'
        } ${disabled ? 'cursor-not-allowed bg-gray-50 text-gray-400' : 'bg-white'}`}
      >
        <span className={`truncate font-mono tabular-nums ${label ? 'text-gray-800' : 'text-gray-400'}`}>
          {label || placeholder || '選擇日期'}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {clearable && label && !disabled && (
            <span
              role="button"
              tabIndex={-1}
              aria-label="清除"
              onClick={(e) => { e.stopPropagation(); onChange?.(''); }}
              className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-3.5 w-3.5"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </span>
          )}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4 text-gray-400" aria-hidden="true">
            <rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" />
          </svg>
        </span>
      </button>

      {/* panel 要等 effect 量完才有值：先畫再修正會在 375px 上看到面板從畫面外
          彈回來的那一幀。寧可晚一個 frame 出現。 */}
      {open && panel && (
        <div
          className="fixed z-30 overflow-y-auto overscroll-contain rounded-xl border border-gray-200 bg-white p-3 shadow-lg"
          style={panel}
        >
          <div className="mb-2 flex items-center justify-between">
            <button type="button" onClick={() => shiftMonth(-1)} disabled={prevBlocked || pickingMonth} aria-label="上個月"
              className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 disabled:cursor-not-allowed disabled:text-gray-200 disabled:hover:bg-transparent">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="m15 18-6-6 6-6" /></svg>
            </button>
            {/* 標題可點＝年月快速跳轉。生日這種要回到 2015 年的欄位，
                只靠上下月箭頭要按超過 100 次。 */}
            <button type="button" onClick={() => setPickingMonth((v) => !v)}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-sm font-bold text-brand-primary hover:bg-gray-100">
              {viewY} 年 {viewMo} 月
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
                className={`h-3 w-3 text-gray-400 transition ${pickingMonth ? 'rotate-180' : ''}`}><path d="m6 9 6 6 6-6" /></svg>
            </button>
            <button type="button" onClick={() => shiftMonth(1)} disabled={nextBlocked || pickingMonth} aria-label="下個月"
              className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 disabled:cursor-not-allowed disabled:text-gray-200 disabled:hover:bg-transparent">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4"><path d="m9 18 6-6-6-6" /></svg>
            </button>
          </div>

          {pickingMonth ? (
            <div>
              <select
                aria-label="年份" value={viewY}
                onChange={(e) => setViewY(Number(e.target.value))}
                className="mb-2 w-full rounded-lg border border-gray-300 px-2 py-1.5 text-sm font-mono tabular-nums focus:border-brand-teal focus:outline-none"
              >
                {Array.from({ length: yearTo - yearFrom + 1 }, (_, i) => yearTo - i).map((y) => (
                  <option key={y} value={y}>{y} 年</option>
                ))}
              </select>
              <div className="grid grid-cols-3 gap-1">
                {MONTHS.map((m, i) => {
                  const mo = i + 1;
                  const blocked = (!!maxDay && dayKey(viewY, mo, 1) > maxDay)
                    || (!!minDay && dayKey(viewY, mo, daysInMonth(viewY, mo)) < minDay);
                  return (
                    <button key={m} type="button" disabled={blocked}
                      onClick={() => { setViewMo(mo); setPickingMonth(false); }}
                      className={`rounded-lg py-2 text-[13px] transition ${
                        mo === viewMo ? 'bg-brand-primary font-bold text-white'
                          : blocked ? 'cursor-not-allowed text-gray-200'
                            : 'font-medium text-gray-700 hover:bg-gray-100'
                      }`}>{m}</button>
                  );
                })}
              </div>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-7 text-center text-[11px] font-bold">
                {WEEKDAY.map((w, i) => (
                  <div key={w} className={`py-1.5 ${i === 0 || i === 6 ? 'text-brand-teal' : 'text-gray-400'}`}>{w}</div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-y-0.5">
                {Array.from({ length: lead }, (_, i) => <div key={'lead' + i} />)}
                {Array.from({ length: total }, (_, i) => {
                  const d = i + 1;
                  const k = dayKey(viewY, viewMo, d);
                  const dow = (lead + i) % 7;
                  const isSel = k === selKey;
                  const isToday = k === todayKey;
                  const blocked = (!!maxDay && k > maxDay) || (!!minDay && k < minDay);
                  return (
                    <button key={k} type="button" disabled={blocked} onClick={() => pickDay(d)}
                      className={`mx-auto flex h-9 w-9 items-center justify-center rounded-lg text-[13px] tabular-nums transition ${
                        isSel ? 'bg-brand-primary font-bold text-white'
                          : blocked ? 'cursor-not-allowed font-normal text-gray-200'
                            : isToday ? 'font-bold text-brand-teal ring-1 ring-brand-teal/40 hover:bg-brand-teal/10'
                              : `font-medium hover:bg-gray-100 ${dow === 0 || dow === 6 ? 'text-brand-teal' : 'text-gray-700'}`
                      }`}>{d}</button>
                  );
                })}
              </div>
            </>
          )}

          {mode === 'datetime' && !pickingMonth && (
            <div className="mt-3 flex items-center gap-2 border-t border-gray-100 pt-3">
              <span className="text-xs font-medium text-gray-500">時間</span>
              <TimeSelects
                cur={parsed || { ...anchor, hh: 0, mi: 0 }}
                minP={minP} maxP={maxP}
                sameMinDay={!!minDay && selKey === minDay}
                sameMaxDay={!!maxDay && selKey === maxDay}
                onPick={emit}
              />
              <button type="button" onClick={() => setOpen(false)}
                className="ml-auto rounded-lg bg-brand-primary px-3 py-1.5 text-xs font-bold text-white hover:bg-brand-primary/90">完成</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
