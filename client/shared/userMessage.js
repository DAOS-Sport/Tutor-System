const DEFAULT_MESSAGE = '操作暫時無法完成，請稍後再試；若持續發生，請聯絡管理員。';

export function toUserMessage(value, fallback = DEFAULT_MESSAGE) {
  if (typeof value !== 'string') return fallback;
  const text = value.trim();
  if (!text || text.length > 300 || !/[\u3400-\u9fff]/.test(text)) return fallback;
  const technical = /<\/?[a-z][^>]*>|^[\[{]|\b(?:TypeError|ReferenceError|SyntaxError|undefined|node_modules)\b|\b[a-z][a-z0-9]*_[a-z0-9_]+\b|\b(?:SELECT\b[\s\S]*\bFROM|INSERT\s+INTO|UPDATE\b[\s\S]*\bSET|DELETE\s+FROM)\b|\.(?:jsx?|tsx?):\d+|```/i;
  return technical.test(text) ? fallback : text;
}

export function humanizeApiError(error) {
  if (!error || typeof error !== 'object') return error;
  const status = error.response?.status;
  const messages = {
    400: '資料不完整或格式不正確，請確認後再試。',
    401: '登入已失效，請重新登入。',
    403: '您沒有操作權限，請聯絡管理員。',
    404: '找不到這筆資料或功能，請重新整理後再試。',
    409: '資料已變動或這次操作已處理，請重新整理確認結果。',
    413: '檔案太大，請縮小檔案後重新上傳。',
    429: '目前操作較頻繁，請稍候再試。',
  };
  const fallback = !error.response
    ? '連線未完成，請先確認操作結果，再嘗試一次。'
    : messages[status] || DEFAULT_MESSAGE;
  const data = error.response?.data;
  const message = toUserMessage(data?.error || data?.message || error.message, fallback);
  error.message = message;
  if (error.response) {
    error.response.data = data && typeof data === 'object' && !Array.isArray(data)
      ? { ...data, error: message, ...(data.message !== undefined ? { message } : {}) }
      : { error: message };
  }
  return error;
}
