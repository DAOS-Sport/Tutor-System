const WEEKDAY_TC = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

function pad2(n) { return String(n).padStart(2, '0'); }

// 全站時間一律顯示台北時間（UTC+8，無日光節約時間），不可用 getHours() 等本地時區
// getter — 瀏覽器/伺服器所在時區不一定是台北，會導致顯示時間整整偏差 8 小時。
function toTaipei(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 8 * 60 * 60 * 1000);
}

export function formatTWD(amount) {
  if (amount == null || Number.isNaN(Number(amount))) return 'NT$ 0';
  return `NT$ ${Math.round(Number(amount)).toLocaleString('en-US')}`;
}

export function formatTWDate(input) {
  const d = toTaipei(input);
  if (!d) return '—';
  return `${d.getUTCFullYear()}/${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())}（${WEEKDAY_TC[d.getUTCDay()]}）`;
}

export function formatTWDateTime(input) {
  const d = toTaipei(input);
  if (!d) return '—';
  return `${formatTWDate(input)} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

export function formatTWDateTimeSeconds(input) {
  const d = toTaipei(input);
  if (!d) return '—';
  return `${d.getUTCFullYear()}/${pad2(d.getUTCMonth() + 1)}/${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

// datetime-local 的值（YYYY-MM-DDTHH:MM，可帶秒）沒有時區資訊。直接 new Date() 會依
// 「瀏覽器本機時區」解讀 —— 櫃台電腦時區設錯，寫進資料庫的時間就整段偏移。台北營運，
// 固定釘 UTC+8。格式不合或無法解析一律回 null，由呼叫端決定怎麼擋。
export function taipeiInputToDate(value) {
  const s = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) return null;
  const d = new Date(`${s.length === 16 ? s + ':00' : s}+08:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function toTaipeiDateTimeInput(input) {
  const d = toTaipei(input);
  if (!d) return '';
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

export function formatHM(input) {
  const d = toTaipei(input);
  if (!d) return '—';
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

export function todayISO() {
  const d = toTaipei(new Date());
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// DATE 欄位不代表 timestamp；純字串只正規化分隔符，不做 UTC 轉換。
export function formatPlainDate(input) {
  if (input == null || input === '') return '';
  const raw = String(input).trim();
  const m = raw.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
  const d = toTaipei(input);
  return d ? `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}` : '';
}

export function isValidTWPhone(phone) {
  return /^09\d{8}$/.test(String(phone || '').trim());
}

export function isValidLast5(s) {
  return /^\d{5}$/.test(String(s || '').trim());
}

export function courseTypeLabel(type) {
  return ({ 1: '1 對 1', 2: '1 對 2', 3: '1 對 3' }[type] || `1 對 ${type}`);
}

export function paymentStatusLabel(status) {
  return ({
    pending_payment: '待對帳',
    confirmed: '已對帳',
    active: '進行中',
    completed: '已結束',
    expired: '已到期',
    cancelled: '已取消',
    refunded: '已退費',
  }[status] || status);
}

export function paymentStatusTone(status) {
  return ({
    pending_payment: 'amber',
    confirmed: 'teal',
    active: 'green',
    completed: 'gray',
    expired: 'gray',
    cancelled: 'gray',
    refunded: 'error',
  }[status] || 'gray');
}

export function roleLabel(role) {
  return ({
    admin: '系統管理員',
    manager: '場館主管',
    staff: '行政櫃檯',
    coach: '教練',
    lifeguard: '救生員',
  }[role] || role);
}

export function checkinStatusLabel(s) {
  return ({ checked_in: '已簽到', absent: '未到', not_yet: '尚未開始' }[s] || s);
}

// checkin_records.checked_in_source 的三種值。認不得的值原樣顯示 ——
// 印出英文比印出空白好：至少看得出「有東西但我們沒對應到」。
export function checkinSourceLabel(s) {
  return ({ parent: '家長自助', coach: '教練', staff: '櫃檯' }[s] || s || '—');
}

/**
 * 一堂課的「備註」摘要，給表格那一格用（一行內講完）。
 * 完整明細在課程詳情彈窗，這裡只回最該被看見的那一句。
 *
 * 優先序：已退回的手動扣課 > 手動扣課原因 > 簽到來源摘要。
 * 手動扣課排在前面是因為它是人工介入、有自由文字原因，出問題時要先看它。
 */
export function sessionNoteSummary(s) {
  if (!s) return null;
  if (s.deduction_reason) {
    // manual_lesson_deductions.status 的實際值是 APPLIED / REVERSED（正式庫實查
    // 171 / 4）。用白名單逐一對應，不要寫成「不等於某個值就當作已退回」——
    // 那種寫法在這裡曾經把 171 筆正常扣課全部標成已退回。
    // 未知的新狀態原樣顯示在標籤上，讓它被看見，而不是被歸進某一邊。
    const st = s.deduction_status;
    const known = { APPLIED: null, REVERSED: '扣課已退回' };
    const reverted = st === 'REVERSED';
    const tag = st in known ? (known[st] || '手動扣課') : (st ? `手動扣課（${st}）` : '手動扣課');
    return {
      tone: reverted ? 'error' : 'amber',
      tag,
      text: reverted ? (s.deduction_reversal_reason || s.deduction_reason) : s.deduction_reason,
    };
  }
  const rows = Array.isArray(s.checkin_details) ? s.checkin_details : [];
  if (!rows.length) return null;
  // 共班一次簽到會產生多列、來源相同，摘要時去重才不會變成「家長自助、家長自助」。
  const sources = [...new Set(rows.map((r) => r.source).filter(Boolean))].map(checkinSourceLabel);
  const by = [...new Set(rows.map((r) => r.by).filter(Boolean))];
  return {
    tone: 'gray',
    tag: sources.join('／') || '簽到',
    text: by.length ? by.join('、') : '',
  };
}
