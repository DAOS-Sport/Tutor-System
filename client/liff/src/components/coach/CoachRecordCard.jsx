import React from 'react';
import { courseTypeLabel } from '../../utils/format';

/**
 * 教練端「授課記錄」與「報名記錄」共用的卡片。
 *
 * 兩頁的資訊結構一樣（課程名 → 倍率 → 對象與期數堂數 → 時間地點 → 右側狀態），
 * 只有資料來源與狀態語意不同。抽成同一個元件而不是各寫一份 ——
 * 各寫一份的症狀是「改了一邊、另一邊沒跟上」，教練在自己的兩個分頁之間
 * 會看到兩種排版。這個坑在簽到章的顏色上已經踩過一次。
 *
 * ── 版面穩定性（owner 回報會破版）──
 * 右欄固定寬、左欄 min-w-0 + truncate、卡片給 min-height。
 * 不固定的話，學員多的那張（「測試-學員1、測試-學員2、測試-學員A、測試-學員B」）
 * 會把右欄擠掉，而且每張卡高度不一，滑起來一跳一跳。
 */

/** 1.5 →「150%」。沒有倍率（undefined/null）時回 null，呼叫端整行不顯示。 */
export function ratePercent(multiplier) {
  const n = Number(multiplier);
  if (!Number.isFinite(n) || n <= 0) return null;
  return `${Math.round(n * 100)}%`;
}

/** 「蔣碩仁_1對3」。教練名拿不到時只印組別，不要印出 undefined_1對3。 */
export function courseTitle(coachName, courseType) {
  const type = courseTypeLabel(courseType) || '';
  const name = String(coachName || '').trim();
  if (!name) return type || '—';
  return type ? `${name}_${type}` : name;
}

// 1–10 用國字，其餘用數字。「兩期」比「2 期」順口，但十位以上寫國字反而難讀。
const CN_NUM = ['', '一', '兩', '三', '四', '五', '六', '七', '八', '九', '十'];
function cnCount(n) {
  const i = Number(n);
  if (!Number.isInteger(i) || i < 1) return null;
  return i <= 10 ? CN_NUM[i] : String(i);
}

/**
 * 「兩期 共 12 堂」。兩個值各自可能缺：
 *   期數缺 → 只印「共 12 堂」
 *   堂數缺 → 只印「兩期」
 *   都缺   → 回 null，呼叫端不顯示這一段（不要印出「共 null 堂」）
 */
export function periodSummary(periodCount, totalSessions) {
  const p = cnCount(periodCount);
  const t = Number(totalSessions);
  const hasT = Number.isFinite(t) && t > 0;
  if (p && hasT) return `${p}期 共 ${t} 堂`;
  if (p) return `${p}期`;
  if (hasT) return `共 ${t} 堂`;
  return null;
}

const TONE = {
  // 已簽到／進行中：與家長端「已出席」章同一組 brand-green。
  // 教練在自己的分頁與家長的畫面之間不該看到兩種綠。
  green: 'bg-brand-green/15 text-brand-green',
  amber: 'bg-brand-amber/15 text-brand-amber',
  teal: 'bg-brand-teal/10 text-brand-teal',
  gray: 'bg-gray-100 text-gray-500',
};

/**
 * 狀態標籤 —— 小的、有顏色的一條，掛在組別標籤下面。
 *
 * 刻意做成「標籤」而不是「按鈕」：簽到會扣課並推播給教練，對帳是櫃檯的職權，
 * 兩者都有各自的流程與稽核。讓列表上出現一顆看起來能按的方塊，
 * 只會讓人以為可以在這裡直接改狀態。
 */
export function StatusChip({ tone = 'gray', children }) {
  return (
    <span className={`whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-bold ${TONE[tone] || TONE.gray}`}>
      {children}
    </span>
  );
}

/**
 * 正方形狀態 banner —— 授課記錄的「已簽到／未簽到」用。
 *
 * 為什麼這裡是正方形而報名記錄是小標籤：授課記錄一列只有一個狀態，
 * 它就是那張卡的主角，要一眼看到；報名記錄的右欄還要放組別、團報與剩餘堂數，
 * 塞一個正方形進去會把其他資訊擠掉。
 *
 * 尺寸刻意寫死 60×60：右欄固定 92px，正方形要能穩定置中且左右留白一致。
 * 內距用 justify-center 讓文字垂直置中，不靠 padding 硬撐 —— 有無第二行
 * 都不會讓方塊變形。
 */
export function StatusBanner({ tone = 'gray', label, sub }) {
  return (
    <div
      style={{ width: 60, height: 60 }}
      className={`flex shrink-0 flex-col items-center justify-center rounded-xl px-1 text-center leading-tight ${TONE[tone] || TONE.gray}`}
    >
      <span className="max-w-full truncate text-[13px] font-bold">{label}</span>
      {sub && <span className="mt-0.5 max-w-full truncate text-[11px] font-medium tabular-nums opacity-75">{sub}</span>}
    </div>
  );
}

/** 剩餘／總堂數。教練最常掃的一個數字，所以放大。 */
export function SessionCount({ remaining, total, tone = 'green' }) {
  const t = Number(total);
  const r = Number(remaining);
  if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(r)) return null;
  const color = TONE[tone] ? TONE[tone].split(' ').find((c) => c.startsWith('text-')) : 'text-gray-500';
  return (
    // 2026-08-17 owner：剩餘堂數再放大約 1.5 倍多（16px → 26px）。
    // 這是教練最常掃的一個數字，刻意讓它比卡片標題（17px）還大 —— 右欄就是為它存在的。
    // 「剩」與分母跟著等比長，整組才會讀成一個單位而不是一個大字配兩個小字。
    // 右欄寬 104px：兩位數的「剩 12/24」約 78px，仍在框內。
    <div className={`flex items-baseline gap-0.5 tabular-nums ${color}`}>
      <span className="text-[12px] font-medium opacity-70">剩</span>
      <span className="text-[26px] font-extrabold leading-none">{r}</span>
      <span className="text-[15px] font-bold opacity-50">/</span>
      <span className="text-[18px] font-bold opacity-70">{t}</span>
    </div>
  );
}

/** 右上角的組別小標籤。 */
export function TypeBadge({ courseType }) {
  return (
    <span className="whitespace-nowrap rounded-md bg-gray-100 px-2 py-0.5 text-[11px] font-semibold text-gray-600">
      {courseTypeLabel(courseType)}
    </span>
  );
}

/**
 * 卡片外框。
 * @param {string} title    課程名稱（courseTitle 產出）
 * @param {string} rate     倍率字串（ratePercent 產出），null 則不顯示
 * @param {node}   subject  第三行：對象 ‧ 期數堂數
 * @param {node}   meta     分隔線下方的小字（時間 ‧ 場館等）
 * @param {node}   aside    右欄內容（組別標籤、狀態標籤、堂數）
 * @param {node}   extra    整卡寬的區塊（同班名冊等）。放在主列之後，
 *                          不受右欄壓縮 —— 名冊塞在左欄時每行只剩不到一半寬度，
 *                          「測試-學員1、測試-學員2」會被折成三行。
 * @param {node}   footer   底部一行（例如「點選進入 →」）
 * @param {func}   onClick  有值時整張卡可點；沒有就是純展示
 */
export default function CoachRecordCard({
  title, rate, subject, meta, aside, extra, footer, onClick, tone = 'default',
}) {
  const clickable = typeof onClick === 'function';
  const Tag = clickable ? 'button' : 'div';
  const toneCls = tone === 'muted'
    ? 'border-gray-200 bg-gray-50/60'
    : 'border-gray-200/90 bg-white';
  return (
    <Tag
      {...(clickable ? { type: 'button', onClick } : {})}
      // min-h 讓每張卡的高度不會差太多；px/py 固定，內容多寡都不改變邊距。
      style={{ minHeight: 124 }}
      className={`flex w-full flex-col justify-between rounded-2xl border px-3.5 py-3 text-left shadow-sm transition ${toneCls} ${
        clickable ? 'active:bg-gray-50' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        {/* min-w-0 是關鍵：沒有它，長學員名單會把右欄推出卡片外。 */}
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="truncate text-[17px] font-extrabold leading-tight text-brand-primary">{title}</div>
          {rate && <div className="text-xs font-medium leading-tight text-gray-400">（{rate}）</div>}
          {subject && <div className="pt-0.5 text-sm font-bold leading-5 text-gray-700">{subject}</div>}
          {meta && (
            <div className="mt-1 border-t border-gray-100 pt-1 text-xs leading-5 text-gray-400">{meta}</div>
          )}
        </div>
        {/* 右欄固定寬：不隨內容伸縮，卡片與卡片之間的右緣才會對齊。
            104px 是量出來的：字級放大後「團報」(38px) 與「1對4」(49px) 併排
            加間距約 91px，用 92px 會剛好貼邊而換行。 */}
        <div className="flex w-[104px] shrink-0 flex-col items-end gap-1">{aside}</div>
      </div>
      {extra}
      {footer && (
        <div className="mt-2 flex items-center justify-end border-t border-gray-100 pt-2 text-[13px]">{footer}</div>
      )}
    </Tag>
  );
}
