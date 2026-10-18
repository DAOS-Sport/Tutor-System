/**
 * 擋掉字串裡的 NUL（\u0000）。
 *
 * Postgres 的 text 根本存不了 NUL：帶著它進到任何一句 query 都會拋
 * 「invalid byte sequence for encoding "UTF8": 0x00」，對使用者就是一個
 * 沒有原因的 500。2026-08-29 的健壯性稽核是在註冊表單的館別欄位撞到的，
 * 但那不是那個欄位的問題 —— 任何欄位、任何端點都一樣，所以擋在門口一次解決，
 * 而不是逐欄去補（逐欄補一定會漏，而且漏掉的那欄沒有人會發現）。
 *
 * 深度設上限：避免有人用深層巢狀 payload 把這段掃描變成 CPU 攻擊。
 */
const MAX_DEPTH = 8;

function hasNulString(value, depth = 0) {
  if (depth > MAX_DEPTH) return false;
  if (typeof value === 'string') return value.includes('\u0000');
  if (Array.isArray(value)) return value.some((v) => hasNulString(v, depth + 1));
  if (value && typeof value === 'object') {
    return Object.values(value).some((v) => hasNulString(v, depth + 1));
  }
  return false;
}

function rejectNulBytes(req, res, next) {
  if (req.body && hasNulString(req.body)) {
    return res.status(400).json({
      error: '輸入內容含有無法儲存的特殊字元，請重新輸入',
      code: 'INPUT_INVALID',
    });
  }
  next();
}

module.exports = { rejectNulBytes, hasNulString, MAX_DEPTH };
