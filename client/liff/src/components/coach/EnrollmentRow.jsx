import React from 'react';
import {
  paymentStatusLabel,
  formatTWYMD,
  formatTWTime,
} from '../../utils/format';
// 與授課記錄共用同一套卡片外觀。兩頁各寫一份的話，改了一邊另一邊不會跟上，
// 教練在自己的分頁之間會看到兩種排版。
import CoachRecordCard, {
  StatusChip, SessionCount, TypeBadge, courseTitle, ratePercent, periodSummary,
} from './CoachRecordCard';

/**
 * 教練端「學生報名狀態」列 —— 今日頁（預覽 5 筆）與訂單記錄頁（全部）共用。
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
/**
 * 三個桶，不是三個 status。
 *
 * 「已完成」是 confirmed 的子集（課都上完了），資料庫沒有這個狀態 —— 它是
 * status 與 used/total 一起算出來的。後端已在 SQL 算好放在 item.bucket。
 *
 * cancelled / refunded 不列 —— 那是已經結束的事，放這裡只會讓教練誤以為還有待辦。
 *
 * 用詞「剛報名待對帳」與 utils/format.js 的 paymentStatusLabel 對齊。不寫「待付款」：
 * 家長上傳匯款證明後 checkout_sessions.payment_status 已是 pending_reconcile，
 * 但 admin_enrollments.status 仍停在 pending_payment —— 卡的是櫃檯還沒對帳，
 * 不是家長沒付錢，寫錯會害教練去催錯人。
 */
export const ENROLL_STAGES = [
  { key: 'in_progress',     label: '進行中',       rail: 'border-l-brand-green bg-brand-green/5', text: 'text-emerald-700' },
  { key: 'pending_payment', label: '剛報名待對帳', rail: 'border-l-brand-amber bg-brand-amber/5', text: 'text-amber-700' },
  { key: 'completed',       label: '已完成',       rail: 'border-l-gray-300 bg-gray-50',          text: 'text-gray-500' },
];

// 註：原本這裡有一個 ENROLL_PREVIEW = 5（首頁只預覽 5 筆用）。報名記錄獨立成
// 分頁、首頁不再預覽之後就沒有消費者了，已移除。

// 未知狀態不要靜默假裝成第一個階段（舊版 `find(...) || ENROLL_STAGES[0]` 會把
// 任何沒列到的狀態顯示成「待付款」——那是憑空捏造，教練會照著去催家長）。
/**
 * 桶的來源一律是後端算好的 item.bucket（見 sessions.js 的 bucketed CTE）。
 *
 * ── 為什麼還是留了一段本地推算 ──
 * 這個部署模型下，前端與後端**必然**不同步：靜態檔案寫進 server/public 就立刻
 * 生效，但後端要等 process 重啟才會換版（npm start 沒有 watch）。中間那段時間
 * 新前端會拿到舊 API 的回應——沒有 bucket 欄位。
 *
 * 少了這段的話，那段視窗內教練會看到「進行中 0、已完成 0」加上一排英文
 * `confirmed`，看起來像資料壞了。所以：**bucket 在就用 bucket，只有整個欄位
 * 不存在時才退回本地推算**。這不是「兩邊各算一次」——後端一有值就完全接手。
 */
function legacyBucket(item) {
  if (item?.status !== 'confirmed') return item?.status;   // pending_payment 兩版同名
  const used = Number(item.used_sessions) || 0;
  // ⚠️ 不能寫成 Number.isFinite(Number(total))：Number(null) 是 0 而且是有限數，
  // total 為 NULL 的列會被當成「0 堂」→ used(0) >= total(0) → 誤判已完成。
  // 那筆課其實還沒開始上。正式庫有 183 列 total 為 NULL。
  const raw = item.total_sessions;
  const total = (raw === null || raw === undefined || raw === '' || !Number.isFinite(Number(raw)))
    ? 999                                    // 與後端 COALESCE(total, 999) 同一個退路
    : Number(raw);
  return used >= total ? 'completed' : 'in_progress';
}

// 吃整個 item 而不是只吃 status —— 桶的判定需要 used/total，光看 status
// 分不出「進行中」與「已完成」。
//
// 未知桶不要靜默假裝成第一個（舊版 `find(...) || ENROLL_STAGES[0]` 會把任何
// 沒列到的狀態顯示成「待付款」，那是憑空捏造，教練會照著去催家長）。
export function bucketOf(item) {
  const key = item?.bucket || legacyBucket(item);
  const hit = ENROLL_STAGES.find((s) => s.key === key);
  if (hit) return hit;
  return { key: key || 'unknown', label: paymentStatusLabel(key), rail: 'border-l-gray-300 bg-white', text: 'text-gray-500' };
}

/** counts 也要相容：舊 API 回的是 {pending_payment, confirmed}，沒有三個桶。 */
export function countsFrom(data) {
  const c = data?.counts || {};
  if (c.in_progress != null || c.completed != null) return c;   // 新版直接用
  // 舊版：confirmed 沒有再細分，全部當進行中。寧可少報「已完成」，
  // 也不要把還在上的課標成結束——後者會讓教練以為不用再排課。
  return { in_progress: c.confirmed || 0, completed: 0, pending_payment: c.pending_payment || 0 };
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
 * detailed=false（今日頁預覽）給日期，true（訂單記錄頁）給日期＋時分。
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

/**
 * 同班名冊。只在「班上人數比這張訂單多」時才顯示。
 *
 * ── 為什麼會多 ──
 * 訂單是收款單位、班是上課單位。團報時每個家庭各自結帳（各自一筆訂單、各自一張
 * 發票，正式庫 8 個跨家庭團報全部如此），但共用同一個班。教練從自己這張卡只看得到
 * 一個家庭的小孩，看不出整班還有誰。
 *
 * 正式庫實測 311 筆對得到班的訂單：276 筆名冊與訂單完全相同（顯示只是重複），
 * 35 筆班比訂單多（就是這裡要補的），0 筆名冊比訂單少。所以「相同就不顯示」
 * 不會漏掉任何資訊。
 *
 * 家長姓名一律原樣顯示 —— 正式庫裡有「龔原瑯 (曼甄、謹郁)」這種帶括號的，
 * 那是家長本來登記的名字，不是髒資料；也有含 emoji 的。不做任何剝除。
 */
function classRoster(item, ownStudents) {
  const families = Array.isArray(item.families) ? item.families : null;
  const size = Number(item.class_size);
  // 對帳前不會有 course_period，名單只有訂單上的文字陣列 —— 要講清楚，
  // 不能讓教練以為那就是全班。
  if (!families || !Number.isFinite(size)) {
    return item.bucket === 'pending_payment' ? (
      <div className="mt-1.5 text-[10px] leading-4 text-gray-400">名單待對帳後確認</div>
    ) : null;
  }
  if (size <= ownStudents.length) return null;
  return (
    // 這一塊由 CoachRecordCard 的 extra 插在主列之後，所以是整卡寬。
    // 放在左欄的話每行只剩不到一半寬度，「測試-學員1、測試-學員2」會被折成三行。
    <div className="mt-2 rounded-lg bg-gray-50 px-2.5 py-2">
      <div className="text-[10px] font-bold text-gray-500">同班共 {size} 位</div>
      <div className="mt-1 space-y-1">
        {families.map((f, i) => (
          <div key={`${f.parent_name}-${i}`} className="flex items-baseline gap-1.5 text-[11px] leading-4">
            {/* 家長姓名給固定上限而不是 45%：整卡寬之後 45% 太寬，
                學員那半會被壓掉。正式庫最長的家長名是「龔原瑯 (曼甄、謹郁)」。 */}
            <span className="min-w-0 max-w-[38%] shrink-0 truncate text-gray-500">{f.parent_name}</span>
            {f.is_leader && (
              <span className="shrink-0 rounded bg-brand-teal/15 px-1 text-[9px] font-bold text-brand-teal">團主</span>
            )}
            <span className="min-w-0 flex-1 text-gray-800">{(f.students || []).join('、')}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function EnrollmentRow({ item, onClick, detailed = false, coachName = '', multiplier = null }) {
  const st = bucketOf(item);
  const studentList = Array.isArray(item.students) ? item.students.filter(Boolean) : [];
  const students = studentList.length ? studentList.join('、') : (item.students || '—');
  // 一筆訂單可能掛多位家長（跨家庭一起結帳）。硬取第一位會讓教練看到一個
  // 跟其他學員不相干的名字，所以多於一位時改標數量。
  const payers = Array.isArray(item.parent_names)
    ? item.parent_names.filter(Boolean)
    : [item.parent_name].filter(Boolean);
  const payerLabel = payers.length === 1 ? payers[0]
    : (payers.length > 1 ? `${payers.length} 位家長` : '—');
  const rows = timeline(item, detailed);
  const classmates = detailed ? classRoster(item, studentList) : null;
  // 剩餘堂數：教練最常掃的一個數字，所以在右欄放大顯示。
  // total 缺值時整段不顯示，不要算出 NaN 或負數 —— 正式庫有 183 列
  // total_sessions 為 NULL。
  const total = Number(item.total_sessions);
  const used = Number(item.used_sessions) || 0;
  const hasTotal = Number.isFinite(total) && total > 0;
  const remaining = hasTotal ? Math.max(0, total - used) : null;

  // 配色沿用全站狀態語意（綠＝進行中、橘＝待處理、灰＝結束）。
  // admin 端與家長端都是這套，只有教練這一頁反過來的話，
  // 同一個人在不同畫面會學到兩套規則。
  const tone = { in_progress: 'green', pending_payment: 'amber', completed: 'gray' }[st.key] || 'gray';

  return (
    <CoachRecordCard
      onClick={onClick}
      tone={st.key === 'completed' ? 'muted' : 'default'}
      title={courseTitle(coachName, item.course_type)}
      rate={ratePercent(multiplier)}
      subject={
        <>
          <span>{students}</span>
          {studentList.length > 1 && (
            <span className="ml-1 text-[10px] font-normal tabular-nums text-gray-400">{studentList.length} 位</span>
          )}
          {periodSummary(item.period_count, item.total_sessions) && (
            <>
              <span className="mx-1 text-gray-300">‧</span>
              {/* 「一期 共 6 堂」是一段完整語意，被拆成兩行會讀成
                  「…‧ 一期」換行「共 6 堂」，看起來像版壞掉。 */}
              <span className="whitespace-nowrap text-gray-900">{periodSummary(item.period_count, item.total_sessions)}</span>
            </>
          )}
        </>
      }
      meta={
        <>
          {/* 欄位標籤不能省：舊版把家長、課別、場館用「・」等權串一行，
              教練看到「(測試帳號)家長・1對2・新北高中」分不出第一段是誰。 */}
          <div className="truncate">
            家長：<span className="text-gray-500">{payerLabel}</span>
            {item.venue_name ? <span className="text-gray-400">{' · '}{item.venue_name}</span> : null}
          </div>
          {rows.length > 0 && (
            <div className={`mt-0.5 ${detailed ? '' : 'truncate'}`}>
              {rows.map((r, i) => (
                <span key={r.k} className={detailed ? 'mr-3 inline-block' : ''}>
                  {i > 0 && !detailed ? ' · ' : ''}
                  {r.label} <span className="tabular-nums text-gray-500">{r.value}</span>
                </span>
              ))}
            </div>
          )}
        </>
      }
      extra={classmates}
      aside={
        <>
          <div className="flex items-center gap-1">
            {item.is_group && (
              <span className="whitespace-nowrap rounded-md bg-brand-teal/10 px-1.5 py-0.5 text-[10px] font-semibold text-brand-teal">團報</span>
            )}
            <TypeBadge courseType={item.course_type} />
          </div>
          {/* 右欄只有 92px，「剛報名待對帳」六個字會把標籤撐到超出欄寬。
              篩選鈕那邊空間夠、維持完整字樣；卡片上縮成「待對帳」——
              卡片本身就在報名記錄頁，「剛報名」那三個字是重複的脈絡。 */}
          <StatusChip tone={tone}>{st.key === 'pending_payment' ? '待對帳' : st.label}</StatusChip>
          {st.key === 'in_progress' && (
            <SessionCount remaining={remaining} total={total} tone="green" />
          )}
        </>
      }
    />
  );
}
