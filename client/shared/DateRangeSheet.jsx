import React, { useEffect, useMemo, useRef, useState } from 'react';

/**
 * 日期區間選擇（機票 App 那種：一個入口 → 底部月曆 → 點起日再點迄日）。
 *
 * 為什麼不是兩個日期框並排：那樣在手機上每個只有半個螢幕寬，日期字串加上
 * 日曆圖示塞不下就破版（390px 寬實測會被切掉）。而且「選區間」本來就是一件事，
 * 拆成兩個欄位等於要使用者自己在腦中把它們關聯起來。
 *
 * 值格式與原生 date input 一致（YYYY-MM-DD），空字串＝不限。
 * 日期運算一律 Date.UTC + getUTC*：只是算「幾號星期幾」「這個月幾天」，
 * 用本地時區的 Date 會在 UTC+8 的月底邊界差一天。
 */

const WEEKDAY = ['日', '一', '二', '三', '四', '五', '六'];
const pad2 = (n) => String(n).padStart(2, '0');
const key = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const firstDow = (y, m) => new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
const todayParts = () => {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const shiftMonth = (y, m, delta) => {
  const t = m - 1 + delta;
  return { y: y + Math.floor(t / 12), m: (((t % 12) + 12) % 12) + 1 };
};
const fmt = (s) => (s ? s.slice(5).replace('-', '/') : '');

function Month({ y, m, from, to, maxDay, onPick }) {
  const lead = firstDow(y, m);
  const total = daysInMonth(y, m);
  const today = todayParts();
  return (
    <div className="px-3 pb-4">
      {/* 不用 sticky：上個月的標題會黏在頂端，但它的日期格早就捲過去了，
          畫面上就變成「7 月」底下一整片空白再接「8 月」，看起來像沒載入。 */}
      <div className="py-2 text-center text-sm font-bold text-brand-primary">
        {y} 年 {m} 月
      </div>
      <div className="grid grid-cols-7">
        {Array.from({ length: lead }, (_, i) => <div key={'lead' + i} />)}
        {Array.from({ length: total }, (_, i) => {
          const d = i + 1;
          const k = key(y, m, d);
          const dow = (lead + i) % 7;
          const blocked = !!maxDay && k > maxDay;
          const isFrom = !!from && k === from;
          const isTo = !!to && k === to;
          const inRange = !!from && !!to && k > from && k < to;
          const isToday = k === key(today.y, today.m, today.d);
          const band = inRange ? 'bg-brand-teal/10'
            : (isFrom && to) ? 'rounded-l-full bg-brand-teal/10'
              : isTo ? 'rounded-r-full bg-brand-teal/10' : '';
          const dot = (isFrom || isTo) ? 'bg-brand-primary font-bold text-white'
            : blocked ? 'font-normal text-gray-200'
              : isToday ? 'font-bold text-brand-teal ring-1 ring-brand-teal/40'
                : `font-medium ${dow === 0 || dow === 6 ? 'text-brand-teal' : 'text-gray-700'}`;
          return (
            <button key={k} type="button" disabled={blocked} onClick={() => onPick(k)}
              className={`flex h-11 items-center justify-center text-[13px] tabular-nums transition ${band}`}>
              <span className={`flex h-9 w-9 items-center justify-center rounded-full ${dot}`}>{d}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function DateRangeSheet({
  from, to, onChange, max, monthsBack = 14, monthsForward = 0, label = '日期區間',
}) {
  const [open, setOpen] = useState(false);
  // 草稿：面板裡改，按「完成」才送出。中途關掉不該改變外面的結果。
  const [draft, setDraft] = useState({ from, to });
  const scrollRef = useRef(null);
  const thisMonthRef = useRef(null);
  // 底部導覽（5 個分頁）的高度。面板從它的上緣往上長，不蓋住它 ——
  // 那排是使用者隨時要能離開這一頁的出口，蓋掉等於把人關在面板裡。
  // 用量的不用寫死：導覽有 safe-area padding，iPhone 與 Android 高度不同。
  const [navH, setNavH] = useState(0);

  useEffect(() => { if (open) setDraft({ from, to }); }, [open, from, to]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    const nav = document.querySelector('nav');
    setNavH(nav ? Math.round(nav.getBoundingClientRect().height) : 0);
    // 開啟時捲到「本月」，不是捲到底。
    // 捲到底會停在最後一個月的月底 —— 那些日子多半在今天之後、全是不可點的灰色，
    // 使用者開啟第一眼看到的是一片灰，還得自己往回捲才找得到今天（實測踩過）。
    requestAnimationFrame(() => {
      const box = scrollRef.current;
      const target = thisMonthRef.current;
      if (!box || !target) return;
      // 用 rect 差值而不是 offsetTop：offsetTop 是相對於「最近的定位祖先」，
      // 捲動容器沒有 position 時算出來的基準就不是它，結果會停在最前面那個月
      // （實測停在 14 個月前）。rect 差值不依賴定位脈絡。
      box.scrollTop += target.getBoundingClientRect().top - box.getBoundingClientRect().top;
    });
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open]);

  const months = useMemo(() => {
    const t = todayParts();
    const out = [];
    for (let i = -monthsBack; i <= monthsForward; i += 1) out.push(shiftMonth(t.y, t.m, i));
    return out;
  }, [monthsBack, monthsForward]);

  // 與機票 App 一致：已有完整區間 → 重新開始；只有起日 → 補迄日；
  // 點到比起日早的 → 當成新的起日（使用者多半是想改起點，不是想倒著選）。
  function pick(k) {
    setDraft((d) => {
      if (!d.from || (d.from && d.to)) return { from: k, to: '' };
      if (k < d.from) return { from: k, to: '' };
      return { from: d.from, to: k };
    });
  }

  const summary = (from || to) ? `${from ? fmt(from) : '不限'} — ${to ? fmt(to) : '不限'}` : '顯示全部';

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-left text-sm">
        <span className="min-w-0 truncate">
          <span className="text-gray-400">{label}　</span>
          <span className={(from || to) ? 'font-medium text-gray-800' : 'text-gray-400'}>{summary}</span>
        </span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
          className="h-4 w-4 shrink-0 text-gray-400" aria-hidden="true">
          <rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" />
        </svg>
      </button>

      {/* 高度不要自己指定，讓 inset-0 決定。
          踩過的坑（2026-08-18 實測）：外層寫成 `inset-0 h-[100dvh]` 是過度約束 ——
          瀏覽器以 height 為準、忽略 bottom，量到的是 y=8 / bottom=769，而視窗只有 761，
          底部那排「完成」就被推出畫面。vh 更糟，它連瀏覽器工具列那段都算進去。
          inset-0 本身就等於「當下可見的固定視窗」，最可靠。
          面板高度改用百分比：85% 是外層（＝視窗）的百分比，不受 vh/dvh 差異影響。
          max-w 跟著 AppLayout 的 390px，桌機開啟時面板才不會比 app 本體還寬。 */}
      {/* overlay 用 bottom 而不是 paddingBottom 讓開底部導覽：padding 仍屬於
          overlay 自己的盒子，點那五顆會打在遮罩上 —— 面板關掉但分頁沒切。
          用 bottom 把整個 overlay 停在導覽上緣，那排就完全在遮罩之外，照樣能按。 */}
      {open && (
        <div
          className="fixed inset-x-0 top-0 z-50 flex justify-center"
          style={{ bottom: navH }}
          role="dialog" aria-modal="true" aria-label={label}
        >
          {/* 遮罩只蓋 app 框架那 390px，不要蓋到兩側的灰色留白 ——
              桌機或大螢幕上 overlay 若吃滿整個視窗，兩邊會各壓暗一條，
              看起來像鏡像／破版（430px 寬實測左右各多 20px）。 */}
          <div
            className="flex h-full w-full max-w-[390px] items-end bg-black/40"
            onClick={(e) => e.target === e.currentTarget && setOpen(false)}
          >
          {/* 高度限在「約一個到一個半月」：整月格子最多 6 列 × 44px 加月份標題約 320px，
              加上表頭 49 + 星期列 30 + 底部 67，520 剛好露出當月完整一頁再帶一點下個月，
              使用者看得出還能往下捲。
              min(100%, 520px)：短螢幕（扣掉底部導覽後不足 520）時自動縮，不會頂出去。 */}
          <div className="flex max-h-[min(100%,520px)] w-full max-w-[390px] flex-col rounded-t-2xl bg-white shadow-[0_-8px_24px_rgba(0,0,0,0.12)]">
            <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-4 py-3">
              <span className="text-sm font-bold text-brand-primary">
                {draft.from ? `${fmt(draft.from)} — ${draft.to ? fmt(draft.to) : '請選迄日'}` : '請選起日'}
              </span>
              {(draft.from || draft.to) && (
                <button type="button" onClick={() => setDraft({ from: '', to: '' })}
                  className="ml-auto mr-1 rounded px-2 py-0.5 text-[11px] font-medium text-brand-teal active:bg-brand-teal/10">
                  清除
                </button>
              )}
              <button type="button" onClick={() => setOpen(false)} aria-label="關閉" className="rounded p-1 text-gray-400">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"
                  className="h-4 w-4"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            </div>

            <div className="grid shrink-0 grid-cols-7 border-b border-gray-100 py-1.5 text-center text-[11px] font-bold">
              {WEEKDAY.map((w, i) => (
                <div key={w} className={(i === 0 || i === 6) ? 'text-brand-teal' : 'text-gray-400'}>{w}</div>
              ))}
            </div>

            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
              {months.map((mm) => {
                const t = todayParts();
                const isThisMonth = mm.y === t.y && mm.m === t.m;
                return (
                  <div key={`${mm.y}-${mm.m}`} ref={isThisMonth ? thisMonthRef : null}>
                    <Month y={mm.y} m={mm.m} from={draft.from} to={draft.to} maxDay={max} onPick={pick} />
                  </div>
                );
              })}
            </div>

            <div className="flex shrink-0 items-center gap-2 border-t border-gray-100 p-3">
              <button type="button" onClick={() => setOpen(false)}
                className="rounded-lg border border-gray-300 px-5 py-2.5 text-sm font-medium text-gray-600">
                取消
              </button>
              {/* 完成永遠可按：草稿是空的就代表「不限區間」，那是合法的結果。
                  停用它會讓「清除 → 完成」變成死路。 */}
              <button type="button"
                onClick={() => { onChange({ from: draft.from, to: draft.from ? (draft.to || draft.from) : '' }); setOpen(false); }}
                className="flex-1 rounded-lg bg-brand-primary py-2.5 text-sm font-bold text-white">
                完成
              </button>
            </div>
          </div>
          </div>
        </div>
      )}
    </>
  );
}
