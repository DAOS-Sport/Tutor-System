import React from 'react';
import { courseTypeLabel } from '../../utils/format';

/**
 * 教練端「授課記錄」與「報名記錄」共用的卡片。
 *
 * 兩頁的資訊結構一樣（課程名 → 倍率 → 對象與期數堂數 → 時間地點 → 右側方形狀態），
 * 只有資料來源與狀態語意不同。抽成同一個元件而不是各寫一份 ——
 * 各寫一份的症狀是「改了一邊、另一邊沒跟上」，教練在自己的兩個分頁之間
 * 會看到兩種排版。這個坑在簽到章的顏色上已經踩過一次。
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

/** 右側 72×72 方形狀態塊。tone 決定配色，body 是方塊內的第二行（可省略）。 */
const SQUARE_TONE = {
  // 已簽到／已完成類：與家長端「已出席」章同一組 brand-green，
  // 教練在自己的分頁與家長的畫面之間不該看到兩種綠。
  green: 'bg-brand-green/15 text-brand-green border-brand-green/30',
  // 待辦／需要動作：深藍，與底部導覽的主色一致
  primary: 'bg-brand-primary text-white border-brand-primary',
  amber: 'bg-brand-amber/10 text-brand-amber border-brand-amber/30',
  teal: 'bg-brand-teal/10 text-brand-teal border-brand-teal/30',
  gray: 'bg-gray-100 text-gray-500 border-gray-200',
};

export function StatusSquare({ tone = 'gray', label, body, icon = null }) {
  const cls = SQUARE_TONE[tone] || SQUARE_TONE.gray;
  return (
    <div
      // 固定 72×72：卡片右側是一個穩定的視覺錨點，內容長短不該讓它變形。
      style={{ width: 72, height: 72 }}
      className={`flex shrink-0 flex-col items-center justify-center rounded-2xl border px-1 text-center ${cls}`}
    >
      {icon}
      <span className="max-w-full truncate text-xs font-bold leading-tight">{label}</span>
      {body && <span className="mt-0.5 max-w-full truncate text-[10px] font-medium leading-tight opacity-90">{body}</span>}
    </div>
  );
}

/** 已簽到用的勾勾。專案沒有裝 icon 套件，沿用既有的 inline SVG 慣例。 */
export function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
      strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" className="mb-0.5">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

/**
 * 卡片外框。
 * @param {string}  title    課程名稱（courseTitle 產出）
 * @param {string}  rate     倍率字串（ratePercent 產出），null 則不顯示
 * @param {node}    subject  第三行：對象 ‧ 期數堂數
 * @param {node}    meta     分隔線下方的小字（時間 ‧ 場館）
 * @param {node}    square   右側方塊
 * @param {node}    badge    右上角小標籤（組別）
 * @param {node}    footer   底部一行（例如「點選進入 →」）
 * @param {func}    onClick  有值時整張卡可點；沒有就是純展示
 */
export default function CoachRecordCard({
  title, rate, subject, meta, square, badge, footer, onClick, tone = 'default',
}) {
  const clickable = typeof onClick === 'function';
  const Tag = clickable ? 'button' : 'div';
  const toneCls = tone === 'muted'
    ? 'border-gray-200 bg-gray-50/60 opacity-80'
    : 'border-gray-200/90 bg-white';
  return (
    <Tag
      {...(clickable ? { type: 'button', onClick } : {})}
      className={`w-full rounded-2xl border p-3.5 text-left shadow-sm transition ${toneCls} ${
        clickable ? 'active:bg-gray-50' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="truncate text-[15px] font-extrabold leading-tight text-brand-primary">{title}</div>
          {rate && <div className="text-[11px] font-medium leading-tight text-gray-400">（{rate}）</div>}
          {subject && <div className="pt-0.5 text-xs font-bold text-gray-700">{subject}</div>}
          {meta && (
            <div className="mt-1 border-t border-gray-100 pt-1 text-[11px] leading-4 text-gray-400">{meta}</div>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {badge}
          {square}
        </div>
      </div>
      {footer && (
        <div className="mt-2.5 flex items-center justify-end border-t border-gray-100 pt-2 text-xs">{footer}</div>
      )}
    </Tag>
  );
}

/** 右上角的組別小標籤。 */
export function TypeBadge({ courseType }) {
  return (
    <span className="rounded-md bg-gray-100 px-2 py-0.5 text-[10px] font-semibold text-gray-600">
      {courseTypeLabel(courseType)}
    </span>
  );
}
