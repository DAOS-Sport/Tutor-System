import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import liff from '@line/liff';
import logoFull from '../assets/logo-full.jpg';
import { authApi } from '../api/auth';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { isValidTWPhone } from '../utils/format';
import { takeAfterAuth, clearAfterAuth } from '../utils/afterAuth';
import LoadingSpinner from '../components/LoadingSpinner';

const MANUAL_LOGOUT_KEY = 'daos.manualLogout';
import { USE_MOCK } from '../api/client';

// 只刷一次 LINE token 的旗標（避免過期 token → 刷新 → 又過期的無限跳轉）
const TOKEN_REFRESH_KEY = 'daos.liff.tokenRefreshed';
// 屬「id_token 本身有問題（過期/驗證失敗/缺）」的錯誤碼——可用 liff.login 重新取 token 自救
const TOKEN_ERR_CODES = ['LINE_TOKEN_EXPIRED', 'LINE_VERIFY_FAILED', 'LINE_ID_TOKEN_REQUIRED'];
// LINE 身分本身不可用時，手機頁使用中性文案，避免顯示「LINE 身分已驗證」。
const LINE_IDENTITY_ERROR_CODES = [...TOKEN_ERR_CODES, 'LINE_VERIFY_NETWORK_ERROR', 'LINE_CHANNEL_MISCONFIGURED'];

function clearManualLogout() {
  try { localStorage.removeItem(MANUAL_LOGOUT_KEY); } catch {}
}

function tryGetLineIdToken() {
  try {
    if (typeof liff?.getIDToken === 'function' && liff.isLoggedIn?.()) {
      return liff.getIDToken() || null;
    }
  } catch { /* swallow */ }
  return null;
}

// 快取的 id_token 過期/驗證失敗 → 用 liff.login 取一顆新的（只刷一次，避免無限跳轉）。
// 尊重「不要自動登出人」：只做 login（刷新），絕不呼叫 liff.logout。
// 只在「確實還在 LINE session 內」才刷新，避免 dev/mock/外部瀏覽器誤觸發轉址。
// 回傳 true 表示已啟動轉址（呼叫端應直接 return）。
function tryRefreshLineToken() {
  try {
    if (typeof window !== 'undefined' && sessionStorage.getItem(TOKEN_REFRESH_KEY)) return false;
    if (!(liff && typeof liff.login === 'function' && liff.isLoggedIn && liff.isLoggedIn())) return false;
    sessionStorage.setItem(TOKEN_REFRESH_KEY, '1');
    liff.login({ redirectUri: window.location.href });
    return true;
  } catch { return false; }
}

// 家長 / 教練端 LIFF App ID（由 Vite env 注入；與 main.jsx 同一來源）
const PARENT_LIFF_ID = import.meta.env.VITE_LIFF_ID_PARENT || import.meta.env.VITE_LIFF_ID;
const COACH_LIFF_ID = import.meta.env.VITE_LIFF_ID_COACH || import.meta.env.VITE_LIFF_ID;
// 只有在「教練端設了獨立的 LIFF ID」時，liff.id 才足以區分教練/家長；
// 兩者共用同一 ID 時不能用 liff.id 判斷（會把家長也判成教練）。
const HAS_DISTINCT_COACH_LIFF = !!COACH_LIFF_ID && COACH_LIFF_ID !== PARENT_LIFF_ID;

/**
 * 判斷目前是否為「教練端」登入情境（登入路由分離核心）。
 * 依可信度排序：
 *   1) 實際 init 的 LIFF App 就是教練端（liff.id === COACH_LIFF_ID）— 最可信
 *   2) path 指向 /coach（教練連結的 endpoint path）
 * 已移除 document.referrer 比對：referrer 不可信（家長頁可能殘留上一個 /coach
 * referrer，導致家長被誤判成教練、跑去打教練 400 API → 流程錯亂 / 白畫面）。
 */
function isCoachLiffContext(fromPath) {
  try {
    if (HAS_DISTINCT_COACH_LIFF && liff?.id && String(liff.id) === String(COACH_LIFF_ID)) return true;
  } catch { /* liff 尚未 init / 非 LINE 環境，往下用 path 判斷 */ }
  return /\/coach(\b|\/|$)/.test(fromPath)
    || /\/coach(\b|\/|$)/.test(window.location.pathname);
}

/**
 * 家長端 LINE 錯誤碼 → 中文文案
 *
 * 涵蓋分類（新成員登入/綁定最常遇到的狀況）：
 *   1. LINE 身分驗證：token 逾時 / 系統設定錯誤 / 連不上 LINE 驗證服務
 *   2. 網路：完全連不上我方伺服器（err.response 不存在，區別於「伺服器回了錯誤」）
 *   3. Ragic 連線：逾時（可重試）vs 其他無法連線
 *   4. 資料衝突：LINE / 手機互相綁定衝突
 *   5. 認領驗證：資料不符 vs 系統資料不足（不是使用者打錯）
 *   6. 頻率限制
 * 找不到對應 code 時，優先採用後端已給的可讀訊息（err.response.data.error），
 * 只有連後端訊息都沒有時才顯示最後一句泛用文案。
 */
function parentErrorMessage(err) {
  const code = err?.response?.data?.code;
  const status = err?.response?.status;
  const serverMsg = err?.response?.data?.error;
  // 完全沒有 response：請求根本沒送達（離線 / DNS / CORS / 逾時無回應），
  // 跟「伺服器回了 4xx/5xx」是不同狀況，不能用同一句話帶過。
  if (!err?.response) return '網路連線異常，請檢查網路連線後再試一次。';

  const MAP = {
    LINE_ALREADY_BOUND_TO_OTHER_PHONE: '此 LINE 已綁定其他手機，請聯絡管理員。',
    PHONE_ALREADY_BOUND_TO_OTHER_LINE: '此手機已綁定其他 LINE，請聯絡管理員。',
    LINE_TOKEN_EXPIRED:        'LINE 登入已逾時，請重新從 LINE 開啟此頁面。',
    LINE_CHANNEL_MISCONFIGURED:'系統設定異常，請聯繫客服協助處理（非您的操作問題）。',
    LINE_VERIFY_NETWORK_ERROR: '暫時無法連上 LINE 驗證服務，請稍後再試。',
    LINE_VERIFY_FAILED:        'LINE 驗證失敗：請重新開啟 LIFF 或稍後再試。',
    LINE_ID_TOKEN_REQUIRED:    'LINE 驗證失敗：請重新開啟 LIFF 或稍後再試。',
    RAGIC_TIMEOUT:              'Ragic 回應較慢，請稍候片刻再試一次。',
    RAGIC_UNAVAILABLE:          '資料查詢暫時失敗，請稍後再試。',
    RAGIC_WRITE_FAILED:         '資料暫時無法完成同步，請稍後再試。',
    Z01_INCOMPLETE:             '會員資料尚未完整，請完成註冊資料補齊後再登入。',
    RAGIC_REFRESH_STUDENTS_INCOMPLETE: '學員資料同步尚未完成，請稍後再試。',
    LOCAL_STUDENT_REFRESH_FAILED: '本地學員資料同步尚未完成，請稍後再試。',
    Z03_RESOLVE_FAILED:         '舊資料清理狀態更新失敗，請稍後再試。',
    PARENT_REFRESH_FAILED:      '會員資料重新整理失敗，請稍後再試。',
    RATE_LIMITED:               '嘗試次數過多，請稍後再試。',
    PHONE_FORMAT_INVALID:       '手機格式錯誤（需 09xxxxxxxx）。',
    CLAIM_VERIFICATION_FAILED:  '學員姓名或登記手機號碼與資料不符，無法認領。請確認後再試，或洽櫃台 / LINE 客服。',
    CLAIM_NO_ID_ON_FILE:        '系統資料不完整，無法自動核對，請透過本館 LINE 官方帳號聯繫櫃檯協助綁定。',
  };
  if (code && MAP[code]) return MAP[code];
  if (status === 429) return MAP.RATE_LIMITED;
  if (serverMsg && typeof serverMsg === 'string') return serverMsg;
  return '發生錯誤，請稍後再試。';
}

/**
 * 統一登入入口：
 *   - 教練 context（path / referrer 含 /coach）→ LINE-only 自動登入畫面
 *   - 家長 context → LINE-first：自動取 id_token 呼叫 parentLineLogin
 *       logged_in            → setParent → /
 *       need_phone_binding   → 顯示手機綁定表單
 *       need_registration    → /register?phone=...
 *   - 無 LIFF / mock dev：顯示「以手機綁定」表單作為 fallback
 */
export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { setParent } = useAuth();
  const toast = useToast();

  const fromPath = location.state?.from?.pathname || '';
  const coachContext = isCoachLiffContext(fromPath);

  // parent flow state: 'checking'|'need_phone'|'manual'|'need_claim'
  const [parentState, setParentState] = useState(coachContext ? null : 'checking');
  const [idToken, setIdToken] = useState(null);
  const [phone, setPhone] = useState('');
  const [claimName, setClaimName] = useState('');
  const [claimPhone, setClaimPhone] = useState('');
  // 家長本人真實姓名：舊生綁定時一併補上，後端只在既有姓名是「電話佔位」時據以清洗回寫 Ragic。
  const [claimParentName, setClaimParentName] = useState('');
  const [busy, setBusy] = useState(false);

  const autoRanRef = useRef(false);

  const showPhoneEntry = (message, token = idToken || tryGetLineIdToken()) => {
    setParentState(token ? 'need_phone' : 'manual');
    if (message) toast.error(message);
  };

  // ── effect: 自動執行對應流程 ──
  useEffect(() => {
    if (autoRanRef.current) return;
    autoRanRef.current = true;

    // 若是被 401 攔截器導回登入頁（session 過期、靜默重驗也失敗）→ 顯示一次可讀提示。
    // 這就是「失敗才提示」：平常靜默重驗成功不會走到這裡。
    try {
      if (sessionStorage.getItem('daos.liff.flashLogout')) {
        sessionStorage.removeItem('daos.liff.flashLogout');
        toast.info('登入階段已過期，請重新登入');
      }
    } catch { /* noop */ }

    if (coachContext) {
      // 教練端統一走 /coach-portal（web OAuth + 30天 portal token 續登）。
      // 舊版在本頁用 liff id_token 直登 /api/coaches/by-line-uid 已停用：
      // 它在桌機/外部瀏覽器（isInClient=false）會失敗，也可能把教練困在家長登入頁。
      navigate('/coach-portal', { replace: true });
      return;
    }

    // 家長流程
    (async () => {
      setBusy(true);
      setParentState('checking');
      const tk = tryGetLineIdToken();
      setIdToken(tk);

      // 無 idToken：
      //  - mock 模式：手機 fallback 可用（mockFn 直接回 need_registration）→ 顯示
      //  - 非 mock（dev 真 API or production）：後端會 400 ID_TOKEN_REQUIRED →
      //    停在手機輸入頁並用 toast 提示 LINE 驗證問題。
      if (!tk && USE_MOCK) {
        setParentState('manual');
        setBusy(false);
        return;
      }
      if (!tk) {
        // 有 LINE session 卻取不到 id_token（多半是快取過期）→ 先自動刷新一次，
        // 成功會轉址離開本頁；失敗（或非 LINE 環境）才停在手機輸入頁並顯示錯誤訊息。
        if (tryRefreshLineToken()) return;
        clearAfterAuth();
        showPhoneEntry('LINE 驗證失敗：請重新開啟 LIFF 或稍後再試。', null);
        setBusy(false);
        return;
      }

      try {
        const r = await authApi.parentLineLogin(tk);
        if (r?.status === 'logged_in' && r.parent) {
          const parent = { ...r.parent, token: r.token || r.parent.token || null };
          setParent(parent);
          toast.success(`歡迎回來，${parent.name || ''}`);
          navigate(takeAfterAuth('/'), { replace: true });
          return;
        }
        if (r?.status === 'need_phone_binding') {
          setParentState('need_phone');
          return;
        }
        // 未知 status：後端回了 200 但 status 欄位不是我們認得的值（例如未來新增了狀態、
        // 前端還沒更新對應），跟「請求失敗」是不同狀況，訊息要分開講清楚。
        clearAfterAuth();
        showPhoneEntry('登入回應異常，請稍後再試。', tk);
      } catch (err) {
        const code = err?.response?.data?.code || err?.code || (!err?.response ? 'NETWORK_ERROR' : 'LOGIN_FAILED');
        // id_token 過期/驗證失敗且仍在 LINE session 中 → 自動用 liff.login 換新 token（只一次），
        // 打破「過期 token → 錯誤 → reload → 又是同一顆過期 token」的死路。成功會轉址離開。
        const identityUnavailable = LINE_IDENTITY_ERROR_CODES.includes(code);
        if (TOKEN_ERR_CODES.includes(code) && tryRefreshLineToken()) return;
        clearAfterAuth();
        if (identityUnavailable) setIdToken(null);
        showPhoneEntry(parentErrorMessage(err), identityUnavailable ? null : tk);
      } finally {
        setBusy(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── 家長：送出手機綁定 ──
  async function handleBindPhone(e) {
    e.preventDefault();
    clearManualLogout();
    if (!isValidTWPhone(phone)) {
      toast.error('請輸入正確的台灣手機號碼（09xxxxxxxx）');
      return;
    }
    const trimmed = phone.trim();
    setBusy(true);
    try {
      const tk = idToken || tryGetLineIdToken();
      if (!tk && !USE_MOCK) {
        setParentState('manual');
        toast.error('LINE 驗證失敗：請重新開啟 LIFF 或稍後再試。');
        return;
      }
      const r = await authApi.parentBindPhone({ idToken: tk, phone: trimmed });
      if (r?.status === 'bound_and_logged_in' && r.parent) {
        const parent = { ...r.parent, token: r.token || r.parent.token || null };
        setParent(parent);
        toast.success(`歡迎，${parent.name || ''}`);
        navigate(takeAfterAuth('/'), { replace: true });
        return;
      }
      if (r?.status === 'need_registration') {
        toast.info('查無此手機，請完成家長註冊');
        navigate(`/register?phone=${encodeURIComponent(r.phone || trimmed)}`, { replace: true });
        return;
      }
      if (r?.status === 'need_claim_verification') {
        // 此手機已有家庭資料 → 需驗證「學員姓名 + 登記手機」才可認領綁定（資安）。
        setParentState('need_claim');
        toast.info('此手機已有家庭資料，請驗證登記資料以完成綁定');
        return;
      }
      toast.error('綁定失敗，請稍後再試。');
    } catch (err) {
      toast.error(parentErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // ── 家長：認領驗證（電話 + 學員姓名 + 登記手機 一致才綁定）──
  async function handleClaim(e) {
    e.preventDefault();
    const name = claimName.trim();
    const claimPhoneValue = claimPhone.trim();
    const parentName = claimParentName.trim();
    if (!name || !claimPhoneValue) { toast.error('請填寫學員姓名與登記手機號碼'); return; }
    if (!isValidTWPhone(claimPhoneValue)) { toast.error('請輸入正確的台灣手機號碼（09xxxxxxxx）'); return; }
    if (!parentName) { toast.error('請填寫您（家長本人）的姓名'); return; }
    setBusy(true);
    try {
      const tk = idToken || tryGetLineIdToken();
      if (!tk && !USE_MOCK) {
        setParentState('manual');
        toast.error('LINE 驗證失敗：請重新開啟 LIFF 或稍後再試。');
        return;
      }
      const r = await authApi.parentBindPhone({
        idToken: tk, phone: phone.trim(),
        claim: { student_name: name, phone: claimPhoneValue, parent_name: parentName },
      });
      if (r?.status === 'bound_and_logged_in' && r.parent) {
        const parent = { ...r.parent, token: r.token || r.parent.token || null };
        setParent(parent);
        toast.success(`歡迎，${parent.name || ''}`);
        navigate(takeAfterAuth('/'), { replace: true });
        return;
      }
      if (r?.status === 'need_claim_verification') {
        showPhoneEntry('學員姓名或登記手機號碼與資料不符，請確認後再試。');
        return;
      }
      if (r?.status === 'need_registration') {
        navigate(`/register?phone=${encodeURIComponent(r.phone || phone.trim())}`, { replace: true });
        return;
      }
      showPhoneEntry('綁定失敗，請稍後再試。');
    } catch (err) {
      const code = err?.response?.data?.code;
      if (code === 'CLAIM_NO_ID_ON_FILE') {
        showPhoneEntry(parentErrorMessage(err));
        return;
      }
      showPhoneEntry(parentErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // ── 教練 context：本頁不再自行登入教練，只負責導去教練專屬登入頁 /coach-portal
  //    （導向在上面的 effect 內完成）。這裡僅顯示過場 spinner，避免轉址前閃一下空白。──
  if (coachContext) {
    return (
      <div className="flex min-h-[100dvh] flex-col items-center justify-center px-6 py-10">
        <div className="mb-6 text-center">
          <img src={logoFull} alt="夢想體育學院 DAOS" className="mx-auto mb-3 h-12 w-auto" />
          <p className="mt-1 text-sm text-gray-500">教練端</p>
        </div>
        <div className="w-full max-w-[320px] text-center">
          <LoadingSpinner label="正在前往教練登入…" />
        </div>
      </div>
    );
  }

  // ── 家長畫面 ──
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center px-6 py-10">
      <div className="mb-8 text-center">
        <img src={logoFull} alt="夢想體育學院 DAOS" className="mx-auto mb-3 h-12 w-auto" />
        <p className="mt-1 text-sm text-gray-500">家教課程系統</p>
      </div>

      {parentState === 'checking' && (
        <div className="w-full max-w-[320px] text-center">
          <LoadingSpinner label="LINE 驗證中…" />
        </div>
      )}

      {(parentState === 'need_phone' || parentState === 'manual') && (
        <form onSubmit={handleBindPhone} className="w-full max-w-[320px] space-y-4">
          <div className="rounded-lg border border-brand-teal/30 bg-brand-teal/5 p-3 text-xs leading-5 text-brand-primary">
            {parentState === 'need_phone'
              ? 'LINE 身分已驗證，請輸入手機完成資料綁定。'
              : '請輸入手機號碼以進行登入或開始註冊。'}
          </div>
          <div>
            <label htmlFor="phone" className="mb-1 block text-sm font-medium text-gray-700">
              手機號碼
            </label>
            <input
              id="phone"
              type="tel"
              inputMode="numeric"
              placeholder="09xxxxxxxx"
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
              className="w-full rounded-lg border border-gray-300 px-4 py-3 text-base focus:border-brand-teal focus:outline-none focus:ring-2 focus:ring-brand-teal/30"
              disabled={busy}
            />
          </div>

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-brand-primary py-3 text-base font-bold text-white active:bg-brand-teal disabled:opacity-50"
          >
            {busy ? '查詢中…' : '確認綁定 / 開始註冊'}
          </button>

          {busy && <LoadingSpinner label="比對家長資料中…" />}

          {USE_MOCK && (
            <div className="pt-4 text-center text-xs leading-5 text-gray-400">
              試用帳號（mock）
              <br />家長：0912345678
            </div>
          )}
        </form>
      )}

      {parentState === 'need_claim' && (
        <form onSubmit={handleClaim} className="w-full max-w-[320px] space-y-4">
          <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs leading-5 text-amber-800">
            為保護個資，此手機已有家庭資料。請輸入「其中一位學員的姓名與登記手機號碼」以確認您是本人。
            若資料有誤，請洽櫃台或透過 LINE 官方帳號聯繫。
          </div>
          <div>
            <label htmlFor="claimParentName" className="mb-1 block text-sm font-medium text-gray-700">您的姓名（家長本人）</label>
            <input
              id="claimParentName" type="text" placeholder="請輸入家長本人真實姓名" value={claimParentName}
              onChange={(e) => setClaimParentName(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-4 py-3 text-base focus:border-brand-teal focus:outline-none focus:ring-2 focus:ring-brand-teal/30"
              disabled={busy}
            />
          </div>
          <div>
            <label htmlFor="claimName" className="mb-1 block text-sm font-medium text-gray-700">學員姓名</label>
            <input
              id="claimName" type="text" value={claimName}
              onChange={(e) => setClaimName(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-4 py-3 text-base focus:border-brand-teal focus:outline-none focus:ring-2 focus:ring-brand-teal/30"
              disabled={busy}
            />
          </div>
          <div>
            <label htmlFor="claimPhone" className="mb-1 block text-sm font-medium text-gray-700">登記手機號碼</label>
            <input
              id="claimPhone" type="tel" inputMode="numeric" placeholder="09xxxxxxxx" value={claimPhone}
              onChange={(e) => setClaimPhone(e.target.value.replace(/\D/g, '').slice(0, 10))}
              className="w-full rounded-lg border border-gray-300 px-4 py-3 text-base focus:border-brand-teal focus:outline-none focus:ring-2 focus:ring-brand-teal/30"
              disabled={busy}
            />
          </div>
          <button
            type="submit" disabled={busy}
            className="w-full rounded-lg bg-brand-primary py-3 text-base font-bold text-white active:bg-brand-teal disabled:opacity-50"
          >
            {busy ? '驗證中…' : '驗證並完成綁定'}
          </button>
          {busy && <LoadingSpinner label="驗證登記資料中…" />}
        </form>
      )}
    </div>
  );
}
