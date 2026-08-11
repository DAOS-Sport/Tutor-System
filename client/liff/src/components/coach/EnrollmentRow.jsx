import React from 'react';
import {
  courseTypeLabel,
  paymentStatusLabel,
  formatTWYMD,
  formatTWTime,
  taipeiCalendarDate,
} from '../../utils/format';

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

// 今日頁預覽筆數。改這一個常數就好 —— 舊版把數字硬編在三個地方
// （slice、> N 判斷、length - N），改一個漏兩個就會出現
// 「顯示 5 筆但寫『另有 length-8 筆』」這種對不起來的畫面。
export const ENROLL_PREVIEW = 5;

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
    <div className="mt-1.5 rounded-lg bg-gray-50/80 px-2 py-1.5">
      <div className="text-[10px] font-bold text-gray-500">同班共 {size} 位</div>
      <div className="mt-1 space-y-0.5">
        {families.map((f, i) => (
          <div key={`${f.parent_name}-${i}`} className="flex items-baseline gap-1.5 text-[11px] leading-4">
            <span className="min-w-0 max-w-[45%] shrink-0 truncate text-gray-500">{f.parent_name}</span>
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

export function EnrollmentRow({ item, onClick, detailed = false }) {
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
  const waited = st.key === 'pending_payment'
    ? daysSinceTaipei(item.submitted_at || item.created_at)
    : null;
  const classmates = detailed ? classRoster(item, studentList) : null;
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
          {/* 學員人數只在 >1 時顯示：一位學員時「1 位」是純噪音，而多位時
              教練要能一眼核對「這張卡是不是整組都在」。 */}
          {studentList.length > 1 && (
            <span className="shrink-0 text-[10px] tabular-nums text-gray-400">{studentList.length} 位</span>
          )}
          {item.is_group && (
            <span className="shrink-0 rounded-md bg-brand-teal/10 px-1.5 py-0.5 text-[10px] font-medium text-brand-teal">團報</span>
          )}
        </div>
        {/* 加欄位標籤：舊版把家長姓名、課別、場館用「・」等權串成一行，
            教練看到「(測試帳號)家長・1對2・新北尚中」分不出第一段是家長還是學員；
            而且整行 truncate，先被截掉的通常是最右邊的場館 —— 那正是他最需要的。 */}
        <div className="mt-0.5 truncate text-[11px] text-gray-500">
          家長：{payerLabel}
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
        {classmates}
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
// 註：原本這裡還有一個 EnrollmentStats（三格統計卡）。Owner 決定「既然是篩選，
// 就做一個最基本的『全部』」—— 篩選鈕本身帶數字就是統計，再放一排一模一樣的
// 數字只是佔版面，而且兩處數字有機會不一致。
