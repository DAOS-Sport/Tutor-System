/**
 * 教練端 LINE OAuth portal API（對應後端 /api/coach-portal）
 *
 * 用獨立 axios 實例（不走 client.js 的全域 401 攔截器），
 * 讓 portal 頁自行處理錯誤（例如靜默 resume 失敗時不要被強制導去家長 /login）。
 * 這條登入流程必須打真實後端，不吃 VITE_USE_MOCK。
 */
import axios from 'axios';

const portalHttp = axios.create({
  baseURL: '/api/coach-portal',
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' },
});

export const coachPortalApi = {
  // 是否已設定 LINE channel（未設 → 顯示提示而非空白按鈕）
  status: () => portalHttp.get('/auth/line/status').then((r) => r.data),

  // 姓名表單打招呼用：回 LINE 顯示名稱 / 頭像
  tokenInfo: (handoff) =>
    portalHttp.get(`/auth/line/token-info/${encodeURIComponent(handoff)}`).then((r) => r.data),

  // A 層命中：一次性 handoff code → 正式 token
  exchange: (code) => portalHttp.post('/auth/exchange', { code }).then((r) => r.data),

  // B 層：姓名 fallback 綁定
  linkByName: (token, name) =>
    portalHttp.post('/link-by-name', { token, name }).then((r) => r.data),

  // 30 天 portal token 換新 12h JWT（App 重開）
  resume: (portalToken) =>
    portalHttp.get('/session', { headers: { 'X-Coach-Token': portalToken } }).then((r) => r.data),

  logout: (portalToken) =>
    portalHttp.post('/logout', {}, { headers: { 'X-Coach-Token': portalToken } }).then((r) => r.data),
};

// 「用 LINE 登入」整頁導向（後端 302 → LINE 授權）
export const COACH_LINE_LOGIN_URL = '/api/coach-portal/auth/line';
export const COACH_PORTAL_TOKEN_KEY = 'daos.coachPortalToken';
