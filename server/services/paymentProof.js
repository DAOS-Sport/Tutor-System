const { objectExists } = require('./objectStorage');

// 正常路徑會儲存 JPEG preview；若 preview 暫時轉檔失敗，upload API 會保留並回傳
// 已通過 magic-byte + decoder 驗證的原始手機圖片。這裡必須接受同一份安全 allowlist，
// 否則第一段 upload 成功、第二段 payment-proof 寫 DB 卻被舊 JPG/PNG regex 拒絕。
const PROOF_URL_RE = /^\/uploads\/\d{4}-\d{2}\/[a-f0-9]{24}\.(jpg|jpeg|jfif|png|webp|heic|heif|avif)$/;

function invalidProof() {
  return {
    supplied: true,
    value: null,
    clear: false,
    error: '請上傳有效的匯款／轉帳證明',
    code: 'PAYMENT_PROOF_INVALID',
    status: 400,
  };
}

async function parseProofInput(body, {
  exists = objectExists,
  field = 'payment_proof_url',
  allowClear = false,
} = {}) {
  const input = body && typeof body === 'object' ? body : {};
  const clear = input.delete_payment_proof === true || input.payment_proof_action === 'delete';
  const raw = input[field];

  if (clear) {
    if (!allowClear) return invalidProof();
    if (typeof raw === 'string' && raw.trim()) {
      return {
        ...invalidProof(),
        error: '不可同時上傳與刪除匯款證明',
        code: 'PAYMENT_PROOF_ACTION_CONFLICT',
      };
    }
    return { supplied: true, value: null, clear: true };
  }

  // 省略、null、空字串都代表「沒有提供新值」；既有 proof 必須由 route 保留。
  if (raw === undefined || raw === null || raw === '') {
    return { supplied: false, value: null, clear: false };
  }
  if (typeof raw !== 'string') return invalidProof();
  const value = raw.trim();
  if (!value) return { supplied: false, value: null, clear: false };
  if (!PROOF_URL_RE.test(value)) return invalidProof();

  try {
    if (!await exists(value)) return invalidProof();
  } catch {
    return {
      supplied: true,
      value: null,
      clear: false,
      error: '暫時無法驗證匯款證明，請稍後再試',
      code: 'PAYMENT_PROOF_LOOKUP_FAILED',
      status: 503,
    };
  }
  return { supplied: true, value, clear: false };
}

module.exports = {
  PROOF_URL_RE,
  parseProofInput,
};
