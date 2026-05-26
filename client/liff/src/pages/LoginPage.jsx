import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import liff from '@line/liff';
import { authApi } from '../api/auth';
import { coachesApi } from '../api/coaches';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { isValidTWPhone } from '../utils/format';
import LoadingSpinner from '../components/LoadingSpinner';

const MANUAL_LOGOUT_KEY = 'daos.manualLogout';
import { USE_MOCK } from '../api/client';

function wasManualLoggedOut() {
  try {
    return localStorage.getItem(MANUAL_LOGOUT_KEY) === '1';
  } catch {
    return false;
  }
}

function clearManualLogout() {
  try { localStorage.removeItem(MANUAL_LOGOUT_KEY); } catch {}
}

function isInLineClient() {
  try {
    return !!liff?.isInClient?.();
  } catch {
    return false;
  }
}

function forceLiffLogin() {
  try {
    if (liff?.isInClient?.() && !liff?.isLoggedIn?.() && typeof liff.login === 'function') {
      liff.login({ redirectUri: window.location.href });
      return true;
    }
  } catch { /* noop */ }
  return false;
}

function tryGetLineIdToken() {
  try {
    if (typeof liff?.getIDToken === 'function' && liff.isLoggedIn?.()) {
      return liff.getIDToken() || null;
    }
  } catch { /* swallow */ }
  return null;
}

/**
 * 教練端 LIFF 自動登入：在 LINE App 內進入 /coach* path 時自動嘗試
 * 回傳 { status: 'success', coach } | 'unbound' | 'unavailable'
 */
async function tryCoachAutoLogin() {
  try {
    if (!liff?.isInClient?.() || !liff?.isLoggedIn?.()) return 'unavailable';
    const idToken = liff.getIDToken?.();
    if (!idToken) return 'unavailable';
    const profile = await liff.getProfile();
    const lineUid = profile?.userId;
    if (!lineUid) return 'unavailable';
    const coach = await coachesApi.byLineUid(lineUid, idToken);
    return { status: 'success', coach };
  } catch (err) {
    const code = err?.response?.status;
    const ec = err?.response?.data?.code;
    if (code === 404 || ec === 'COACH_LINE_NOT_BOUND') return 'unbound';
    return 'unavailable';
  }
}

function isCoachLiffContext(fromPath) {
  const referrer = (typeof document !== 'undefined' && document.referrer) || '';
  return /\/coach(\b|\/|$)/.test(fromPath)
    || /\/coach(\b|\/|$)/.test(window.location.pathname)
    || /\/coach(\b|\/|$)/.test(referrer);
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
  const { setParent, setCoach } = useAuth();
  const toast = useToast();

  const fromPath = location.state?.from?.pathname || '';
  const coachContext = isCoachLiffContext(fromPath);

  // coach context state
  const [coachState, setCoachState] = useState(coachContext ? 'checking' : null);

  // parent flow state: 'init'|'checking'|'need_phone'|'manual'|'error'
  const [parentState, setParentState] = useState(coachContext ? null : 'init');
  const [idToken, setIdToken] = useState(null);
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);

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

    // manual logout guard: do not auto-login immediately after user explicitly logs out.
    if (!isCoachContext && wasManualLoggedOut()) {
      setBusy(false);
      return;
    }

    if (coachContext) {
      setBusy(true);
      tryCoachAutoLogin().then((res) => {
        if (res && typeof res === 'object' && res.status === 'success') {
          const c = res.coach;
          setCoach({ ...c, token: c?.token || null });
          toast.success(`歡迎，${c.name} 教練`);
          navigate('/coach', { replace: true });
          return;
        }
        if (res === 'unbound') setCoachState('unbound');
        else setCoachState('error');
      }).finally(() => setBusy(false));
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
          navigate('/', { replace: true });
          return;
        }
        if (r?.status === 'need_phone_binding') {
          setParentState('need_phone');
          return;
        }
        // 未知 status
        setParentState('error');
        toast.error('登入失敗，請稍後再試。');
      } catch (err) {
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
        navigate('/', { replace: true });
        return;
      }
      if (r?.status === 'need_registration') {
        toast.info('查無此手機，請完成家長註冊');
        navigate(`/register?phone=${encodeURIComponent(r.phone || trimmed)}`, { replace: true });
        return;
      }
      toast.error('綁定失敗，請稍後再試。');
    } catch (err) {
      toast.error(parentErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  // ── 教練 context 專屬畫面 ──
  if (coachContext && coachState && coachState !== 'success') {
    return (
      <div className="flex min-h-[100dvh] flex-col items-center justify-center px-6 py-10">
        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-primary text-2xl font-bold text-white">
            DAOS
          </div>
          <h1 className="text-xl font-bold text-brand-primary">夢想體育學院</h1>
          <p className="mt-1 text-sm text-gray-500">教練端</p>
        </div>

        {coachState === 'checking' && (
          <div className="w-full max-w-[320px] text-center">
            <LoadingSpinner label="正在以 LINE 帳號登入…" />
          </div>
        )}

        {coachState === 'unbound' && (
          <div className="w-full max-w-[340px] rounded-xl border border-amber-200 bg-amber-50 p-5 text-center">
            <div className="mb-2 text-base font-bold text-amber-900">尚未完成綁定</div>
            <p className="text-sm leading-6 text-amber-800">
              您的 LINE 帳號尚未綁定為教練。
              <br />
              請截圖傳送結果至 <span className="font-bold">400 官方帳號</span>，
              <br />
              由管理員協助完成綁定後即可登入。
            </p>
            <p className="mt-3 text-xs text-amber-700">
              （LINE 身分已驗證，僅尚未對應到教練資料）
            </p>
          </div>
        )}

        {coachState === 'error' && (
          <div className="w-full max-w-[340px] rounded-xl border border-gray-200 bg-gray-50 p-5 text-center">
            <p className="text-sm leading-6 text-gray-700">
              無法自動登入，請稍後再試。
              <br />
              若問題持續，請截圖傳送結果至 <span className="font-bold">400 官方帳號</span>。
            </p>
            <button type="button" onClick={() => window.location.reload()}
              className="mt-4 w-full rounded-lg bg-brand-primary py-2 text-sm font-bold text-white active:bg-brand-teal">
              重新嘗試
            </button>
            <DiagBlock />
          </div>
        )}

        {coachState === 'unbound' && <DiagBlock />}
      </div>
    );
  }

  // ── 家長畫面 ──
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center px-6 py-10">
      <div className="mb-8 text-center">
        <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-primary text-2xl font-bold text-white">
          DAOS
        </div>
        <h1 className="text-xl font-bold text-brand-primary">夢想體育學院</h1>
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
    </div>
  );
}
