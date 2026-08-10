import React from 'react';
import {
  courseTypeLabel,
  paymentStatusLabel,
  formatTWYMD,
  formatTWTime,
  taipeiCalendarDate,
} from '../../utils/format';

/**
 * 教練端「學生報名狀態」列 —— 今日頁（預覽 5 筆）與訂單紀錄頁（全部）共用。
 *
 * ── 為什麼狀態色只出現在左側色軌 ──
 * 舊版把同一組顏色同時塗在三個地方：上方統計 chip、卡內左側圓形 icon 底色、
 * 右側狀態 chip。一列裡左右兩端同色、中間夾灰字，畫面上出現 3×N 個相同色塊，
 * 眼睛沒辦法用顏色定位任何東西 —— 只覺得花。
 * 現在改成 GroupStatusPage 成員列的作法：整列用「左側色軌 + 極淡底色」表達狀態，
 * 要處理的那幾筆會自己浮出來；右側只留狀態文字，不再是色塊。
 *
 * ── 為什麼不用 emoji 當 icon ──
 * ⏳✅📗 在 iOS 與 Android 的 LINE 內建瀏覽器字形不同，大小與基線都會偏；
 * 顏色不受控（📗 是綠書，擺在青色底上兩種綠打架）；而且它們是 aria-hidden，
 * 對輔助技術等於空的。全站其他地方一律用 SVG 或純色票，這裡是孤例。
 *
 * ── 時間一律走 utils/format.js ──
 * 這專案出過整站時區 bug（pg 的 DATE 被當成本地午夜、toISOString().slice() 把 UTC
 * 瞬間當成本地時間）。這裡不自己算日期，全部用 format.js 既有的台北時區函式。
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

// 台北日曆日差。用 format.js 的 taipeiCalendarDate（UTC 午夜容器，該檔註明必須
// 搭配 UTC getter 使用）相減，不碰本地時區。
function daysSinceTaipei(input) {
  const from = taipeiCalendarDate(input);
  const today = taipeiCalendarDate(new Date());
  if (!from || !today) return null;
  return Math.round((today.getTime() - from.getTime()) / 86400000);
}

// YYYY/MM/DD HH:mm（台北）。不用 formatTWDateTime —— 它會帶「（週四）」，
// 在一列排 2～3 個時間點的密集清單裡，星期是純噪音。
function fullDateTimeTaipei(input) {
  const ymd = formatTWYMD(input);
  if (!ymd) return '';
  const hm = formatTWTime(input);
  return hm ? `${ymd.replace(/-/g, '/')} ${hm}` : ymd.replace(/-/g, '/');
}

// MM/DD（台北）。非今年的補上年份 —— 訂單清單會跨年，只寫「08/09」看不出哪一年。
function shortDateTaipei(input) {
  const ymd = formatTWYMD(input);
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-');
  return y === formatTWYMD(new Date()).slice(0, 4) ? `${m}/${d}` : `${y}/${m}/${d}`;
}

/**
 * 帳單的各項時間狀態。
 * detailed=false（今日頁預覽）給日期，true（訂單紀錄頁）給日期＋時分。
 */
function timeline(item, detailed) {
  const fmt = detailed ? fullDateTimeTaipei : shortDateTaipei;
  const out = [];
  const submitted = item.submitted_at || item.created_at;
  if (submitted) out.push({ k: 'submitted', label: '報名', value: fmt(submitted) });
  // 退回補件會把狀態打回 pending_payment。不顯示的話教練只看到「待對帳」，
  // 不知道其實是家長要補件 —— 他會去催櫃檯，但卡的是家長。
  if (item.returned_at) out.push({ k: 'returned', label: '退回補件', value: fmt(item.returned_at) });
  if (item.invoice_issued_at) out.push({ k: 'reconciled', label: '對帳完成', value: fmt(item.invoice_issued_at) });
  return out;
}

export function EnrollmentRow({ item, onClick, detailed = false }) {
  const st = stageOf(item.status);
  const students = Array.isArray(item.students) ? item.students.join('、') : (item.students || '—');
  const rows = timeline(item, detailed);
  const waited = st.key === 'pending_payment'
    ? daysSinceTaipei(item.submitted_at || item.created_at)
    : null;
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      {...(onClick ? { type: 'button', onClick } : {})}
      className={`flex w-full items-start gap-3 rounded-xl border border-gray-100 border-l-4 px-3 py-2.5 text-left shadow-sm ${onClick ? 'active:opacity-75' : ''} ${st.rail}`}
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
        {rows.length > 0 && (
          <div className={`mt-1 text-[10px] leading-4 text-gray-400 ${detailed ? '' : 'truncate'}`}>
            {rows.map((r, i) => (
              <span key={r.k} className={detailed ? 'mr-3 inline-block' : ''}>
                {i > 0 && !detailed ? ' · ' : ''}
                {r.label} <span className="tabular-nums text-gray-500">{r.value}</span>
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="shrink-0 text-right">
        <div className={`text-[11px] font-bold ${st.text}`}>{st.label}</div>
        {waited !== null && (
          <div className="mt-0.5 text-[10px] tabular-nums text-gray-400">
            {waited <= 0 ? '今天送出' : `已等 ${waited} 天`}
          </div>
        )}
      </div>
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
