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
import ReportIssueButton from '../components/ReportIssueButton';

const MANUAL_LOGOUT_KEY = 'daos.manualLogout';
import { USE_MOCK } from '../api/client';

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
 */
function parentErrorMessage(err) {
  const code = err?.response?.data?.code;
  const status = err?.response?.status;
  if (code === 'LINE_ALREADY_BOUND_TO_OTHER_PHONE') return '此 LINE 已綁定其他手機，請聯絡管理員。';
  if (code === 'PHONE_ALREADY_BOUND_TO_OTHER_LINE') return '此手機已綁定其他 LINE，請聯絡管理員。';
  if (code === 'LINE_VERIFY_FAILED' || code === 'LINE_ID_TOKEN_REQUIRED') return 'LINE 驗證失敗：請重新開啟 LIFF 或稍後再試。';
  if (code === 'RAGIC_UNAVAILABLE') return '資料查詢暫時失敗，請稍後再試。';
  if (code === 'RATE_LIMITED' || status === 429) return '嘗試次數過多，請稍後再試。';
  if (code === 'PHONE_FORMAT_INVALID') return '手機格式錯誤（需 09xxxxxxxx）。';
  if (code === 'CLAIM_VERIFICATION_FAILED') return '學員姓名或身分證字號與資料不符，無法認領。請確認後再試，或洽櫃台 / LINE 客服。';
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

  // parent flow state: 'checking'|'need_phone'|'manual'|'error'
  const [parentState, setParentState] = useState(coachContext ? null : 'checking');
  const [idToken, setIdToken] = useState(null);
  const [phone, setPhone] = useState('');
  const [claimName, setClaimName] = useState('');
  const [claimId, setClaimId] = useState('');
  const [busy, setBusy] = useState(false);
  const [errCode, setErrCode] = useState('');

  const autoRanRef = useRef(false);

  // 診斷資訊（不含 token），失敗畫面顯示供截圖判斷
  const diag = (() => {
    let isInClient = false, isLoggedIn = false, hasIdToken = false;
    try { isInClient = !!(liff?.isInClient && liff.isInClient()); } catch {}
    try { isLoggedIn = !!(liff?.isLoggedIn && liff.isLoggedIn()); } catch {}
    try { hasIdToken = !!(liff?.getIDToken && liff.getIDToken()); } catch {}
    return {
      isInClient,
      isLoggedIn,
      hasIdToken,
      pathname: typeof window !== 'undefined' ? window.location.pathname : '',
      context: coachContext ? 'coach' : 'parent',
    };
  })();
  const DiagBlock = () => (
    <div className="mt-4 rounded-md border border-gray-200 bg-gray-50 p-3 text-left text-[11px] leading-5 text-gray-600">
      <div className="mb-1 font-medium text-gray-700">診斷資訊（請截圖）</div>
      <div>context: {diag.context}</div>
      <div>pathname: {diag.pathname}</div>
      <div>liff.isInClient: {String(diag.isInClient)}</div>
      <div>liff.isLoggedIn: {String(diag.isLoggedIn)}</div>
      <div>hasIdToken: {String(diag.hasIdToken)}</div>
    </div>
  );

  // ── effect: 自動執行對應流程 ──
  useEffect(() => {
    if (autoRanRef.current) return;
    autoRanRef.current = true;

    if (coachContext) {
      // 教練端統一走 /coach-portal（web OAuth + 30天 portal token 續登）。
      // 舊版在本頁用 liff id_token 直登 /api/coaches/by-line-uid 已停用：
      // 它在桌機/外部瀏覽器（isInClient=false）會失敗並顯示「無法自動登入」診斷畫面，
      // 也可能把教練困在家長登入頁 → 一律改為導去教練專屬登入頁。
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
      //    一律顯示「請從 LINE 開啟」錯誤，不放出無法成功的表單避免使用者卡死
      if (!tk && USE_MOCK) {
        setParentState('manual');
        setBusy(false);
        return;
      }
      if (!tk) {
        clearAfterAuth();
        setErrCode('LINE_ID_TOKEN_REQUIRED');
        setParentState('error');
        toast.error('LINE 驗證失敗：請重新開啟 LIFF 或稍後再試。');
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
        // 未知 status
        clearAfterAuth();
        setErrCode('UNKNOWN_STATUS');
        setParentState('error');
        toast.error('登入失敗，請稍後再試。');
      } catch (err) {
        clearAfterAuth();
        setErrCode(err?.response?.data?.code || err?.code || '');
        setParentState('error');
        toast.error(parentErrorMessage(err));
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
        // 此手機已有家庭資料 → 需驗證「學員姓名 + 身分證」才可認領綁定（資安）。
        setParentState('need_claim');
        toast.info('此手機已有家庭資料，請驗證學員身分以完成綁定');
        return;
      }
      toast.error('綁定失敗，請稍後再試。');
    } catch (err) {
      toast.error(parentErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // ── 家長：認領驗證（電話 + 學員姓名 + 身分證字號 一致才綁定）──
  async function handleClaim(e) {
    e.preventDefault();
    const name = claimName.trim();
    const id = claimId.trim().toUpperCase();
    if (!name || !id) { toast.error('請填寫學員姓名與身分證字號'); return; }
    setBusy(true);
    try {
      const tk = idToken || tryGetLineIdToken();
      if (!tk && !USE_MOCK) { toast.error('LINE 驗證失敗：請重新開啟 LIFF 或稍後再試。'); return; }
      const r = await authApi.parentBindPhone({
        idToken: tk, phone: phone.trim(), claim: { student_name: name, id_number: id },
      });
      if (r?.status === 'bound_and_logged_in' && r.parent) {
        const parent = { ...r.parent, token: r.token || r.parent.token || null };
        setParent(parent);
        toast.success(`歡迎，${parent.name || ''}`);
        navigate(takeAfterAuth('/'), { replace: true });
        return;
      }
      if (r?.status === 'need_claim_verification') {
        toast.error('學員姓名或身分證字號與資料不符，請確認後再試。');
        return;
      }
      if (r?.status === 'need_registration') {
        navigate(`/register?phone=${encodeURIComponent(r.phone || phone.trim())}`, { replace: true });
        return;
      }
      toast.error('綁定失敗，請稍後再試。');
    } catch (err) {
      toast.error(parentErrorMessage(err));
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

      {parentState === 'error' && (
        <div className="w-full max-w-[340px] rounded-xl border border-rose-200 bg-rose-50 p-5 text-center">
          <p className="text-sm leading-6 text-rose-800">
            LINE 驗證失敗，請從 LINE App 重新開啟連結，或稍後再試。
          </p>
          <button type="button" onClick={() => window.location.reload()}
            className="mt-4 w-full rounded-lg bg-brand-primary py-2 text-sm font-bold text-white active:bg-brand-teal">
            重新嘗試
          </button>
          <div className="mt-3">
            <ReportIssueButton
              audience="parent"
              errorCode={errCode}
              errorMessage="家長端登入失敗"
              context="家長端登入"
              details={{ 畫面: diag.context, 路徑: diag.pathname, LINE內開啟: String(diag.isInClient), 已登入LINE: String(diag.isLoggedIn), 有idToken: String(diag.hasIdToken) }}
            />
          </div>
          <DiagBlock />
        </div>
      )}

      {/* 防呆：任何非預期狀態都不可停在純 LOGO 空白頁 → 給重試 + 問題回報 */}
      {!['checking', 'error', 'need_phone', 'manual', 'need_claim'].includes(parentState) && (
        <div className="w-full max-w-[340px] rounded-xl border border-gray-200 bg-gray-50 p-5 text-center">
          <p className="text-sm leading-6 text-gray-700">
            登入流程未完成，請重新嘗試，或透過下方按鈕回報問題。
          </p>
          <button type="button" onClick={() => window.location.reload()}
            className="mt-4 w-full rounded-lg bg-brand-primary py-2 text-sm font-bold text-white active:bg-brand-teal">
            重新嘗試
          </button>
          <div className="mt-3">
            <ReportIssueButton
              audience="parent"
              errorCode={errCode || 'LOGIN_INCOMPLETE'}
              errorMessage="家長端登入流程未完成"
              context="家長端登入"
              details={{ 畫面: diag.context, 路徑: diag.pathname, LINE內開啟: String(diag.isInClient), 已登入LINE: String(diag.isLoggedIn), 有idToken: String(diag.hasIdToken) }}
            />
          </div>
          <DiagBlock />
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
            為保護個資，此手機已有家庭資料。請輸入「其中一位學員的姓名與身分證字號」以確認您是本人。
            若資料有誤，請洽櫃台或透過 LINE 官方帳號聯繫。
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
            <label htmlFor="claimId" className="mb-1 block text-sm font-medium text-gray-700">學員身分證字號</label>
            <input
              id="claimId" type="text" placeholder="A123456789" value={claimId}
              onChange={(e) => setClaimId(e.target.value.toUpperCase().slice(0, 10))}
              className="w-full rounded-lg border border-gray-300 px-4 py-3 text-base uppercase focus:border-brand-teal focus:outline-none focus:ring-2 focus:ring-brand-teal/30"
              disabled={busy}
            />
          </div>
          <button
            type="submit" disabled={busy}
            className="w-full rounded-lg bg-brand-primary py-3 text-base font-bold text-white active:bg-brand-teal disabled:opacity-50"
          >
            {busy ? '驗證中…' : '驗證並完成綁定'}
          </button>
          {busy && <LoadingSpinner label="驗證學員身分中…" />}
        </form>
      )}
    </div>
  );
}
