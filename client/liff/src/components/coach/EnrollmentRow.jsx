import React from 'react';
import { courseTypeLabel, paymentStatusLabel } from '../../utils/format';

/**
 * 教練端「學生報名狀態」列 —— 今日頁（預覽 5 筆）與訂單紀錄頁（全部）共用。
 *
 * ── 為什麼狀態色只出現在左側色軌 ──
 * 舊版把同一組顏色同時塗在三個地方：上方統計 chip、卡內左側圓形 icon 底色、
 * 右側狀態 chip。一列裡左右兩端同色、中間夾灰字，畫面上出現 3×N 個相同色塊，
 * 眼睛沒辦法用顏色定位任何東西 —— 只覺得花。
 * 現在改成 GroupStatusPage 成員列的作法：整列用「左側色軌 + 極淡底色」表達狀態，
 * 要處理的那幾筆會自己浮出來；右側只留一行狀態文字，不再是色塊。
 *
 * ── 為什麼不用 emoji 當 icon ──
 * ⏳✅📗 在 iOS 與 Android 的 LINE 內建瀏覽器字形不同，大小與基線都會偏；
 * 顏色不受控（📗 是綠書，擺在青色底上兩種綠打架）；而且它們是 aria-hidden，
 * 對輔助技術等於空的。全站其他地方一律用 SVG 或純色票，這裡是孤例。
 */

// 順序＝教練最需要注意的排前面：卡在待對帳的，課永遠不會出現。
// 只列教練該看到的三個狀態；cancelled / refunded 不列 —— 那是已經結束的事，
// 放在這裡只會讓教練誤以為還有待辦。
//
// 用詞一律「待對帳」，與 utils/format.js 的 paymentStatusLabel 對齊。
// 舊版寫「待付款」是教練端唯一的異類，而且會害教練說錯話：家長上傳匯款證明後
// checkout_sessions.payment_status 已是 pending_reconcile，但 admin_enrollments.status
// 仍停在 pending_payment —— 卡的是櫃檯還沒對帳，不是家長沒付錢。
export const ENROLL_STAGES = [
  { key: 'pending_payment', label: '待對帳', rail: 'border-l-brand-amber bg-brand-amber/5', text: 'text-amber-700' },
  { key: 'confirmed', label: '已確認', rail: 'border-l-brand-green bg-brand-green/5', text: 'text-emerald-700' },
  { key: 'active', label: '上課中', rail: 'border-l-brand-teal bg-brand-teal/5', text: 'text-teal-700' },
];

// 今日頁預覽筆數。改這一個常數就好 —— 舊版把數字硬編在三個地方
// （slice、> N 判斷、length - N），改一個漏兩個就會出現
// 「顯示 5 筆但寫『另有 length-8 筆』」這種對不起來的畫面。
export const ENROLL_PREVIEW = 5;

// 未知狀態不要靜默假裝成第一個階段（舊版 `find(...) || ENROLL_STAGES[0]` 會把
// 任何沒列到的狀態顯示成「待付款」——那是憑空捏造，教練會照著去催家長）。
export function stageOf(status) {
  const hit = ENROLL_STAGES.find((s) => s.key === status);
  if (hit) return hit;
  return { key: status || 'unknown', label: paymentStatusLabel(status), rail: 'border-l-gray-300 bg-white', text: 'text-gray-500' };
}

export function EnrollmentRow({ item, onClick }) {
  const st = stageOf(item.status);
  const students = Array.isArray(item.students) ? item.students.join('、') : (item.students || '—');
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      {...(onClick ? { type: 'button', onClick } : {})}
      className={`flex w-full items-center gap-3 rounded-xl border border-gray-100 border-l-4 px-3 py-2.5 text-left shadow-sm ${onClick ? 'active:opacity-75' : ''} ${st.rail}`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-bold text-gray-900">{students}</span>
          <span className="shrink-0 rounded-md bg-brand-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-brand-primary">
            {courseTypeLabel(item.course_type)}
          </span>
        </div>
        {/* 加欄位標籤：舊版把家長姓名、課別、場館用「・」等權串成一行，
            教練看到「(測試帳號)家長・1對2・新北尚中」分不出第一段是家長還是學員；
            而且整行 truncate，先被截掉的通常是最右邊的場館 —— 那正是他最需要的。 */}
        <div className="mt-0.5 truncate text-[11px] text-gray-500">
          家長：{item.parent_name || '—'}
          {item.venue_name ? <span className="text-gray-400">{' · '}{item.venue_name}</span> : null}
        </div>
      </div>
      <span className={`shrink-0 text-[11px] font-bold ${st.text}`}>{st.label}</span>
    </Tag>
  );
}

/** 統計列：中性灰膠囊 + 狀態色數字。0 筆的階段不佔位，免得永遠掛著一個「上課中 0」。 */
export function EnrollmentStats({ counts }) {
  const shown = ENROLL_STAGES.filter((st) => (counts?.[st.key] || 0) > 0);
  if (!shown.length) return null;
  return (
    <div className="mb-2 flex gap-2">
      {shown.map((st) => (
        <div key={st.key} className="flex-1 rounded-lg bg-gray-50 px-2.5 py-1.5 text-center">
          <div className={`text-base font-bold leading-none tabular-nums ${st.text}`}>{counts[st.key]}</div>
          <div className="mt-1 text-[11px] text-gray-500">{st.label}</div>
        </div>
      ))}
    </div>
  );
}
