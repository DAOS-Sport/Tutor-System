/**
 * 教練端 LINE OAuth 登入頁（/coach-portal）— 與家長端登入完全分離。
 *
 * 流程（對應後端 routes/coachPortal.js）：
 *   1) 無參數 → 已登入則進 /coach；否則嘗試 30天 portal token 靜默 resume；
 *      再不行 → 顯示「用 LINE 登入」按鈕（整頁導向 /api/coach-portal/auth/line）。
 *   2) ?lineLogin=existing&code=...  → A 層命中：POST /auth/exchange 換 token → /coach
 *   3) ?lineLogin=new&token=...      → A miss：顯示姓名表單 → POST /link-by-name（B 層）
 *   4) ?error=...                    → 顯示錯誤 + 重新登入
 */
import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import LoadingSpinner from '../components/LoadingSpinner';
import { coachPortalApi, COACH_LINE_LOGIN_URL, COACH_PORTAL_TOKEN_KEY } from '../api/coachPortal';

function mapError(codeOrErr) {
  const code = typeof codeOrErr === 'string'
    ? codeOrErr
    : (codeOrErr?.response?.data?.code || codeOrErr?.code);
  switch (code) {
    // ── OAuth callback 階段（後端 frontendRedirect 的 error=）──
    case 'not_configured':   return 'LINE 登入尚未設定，請聯絡管理員。';
    case 'line_denied':      return '已取消 LINE 授權，請重新登入。';
    case 'bad_request':      return '登入請求不完整，請重新點「使用 LINE 登入」。';
    case 'bad_state':        return '登入逾時或頁面停留過久，請重新登入。';
    case 'oauth_failed':     return 'LINE 授權失敗，請重新登入。';
    case 'no_profile':       return '無法取得您的 LINE 資料，請重新登入。';
    case 'server_error':     return '伺服器忙線，請稍後再試。';
    // ── 比對 / 綁定階段 ──
    case 'COACH_NOT_FOUND':  return '查無此姓名的教練資料，已通知管理員協助處理。';
    case 'NAME_ALREADY_BOUND': return '此姓名的教練已綁定其他 LINE，請聯絡管理員。';
    case 'LINE_ALREADY_BOUND': return '此 LINE 帳號已綁定其他教練，請聯絡管理員。';
    case 'NAME_AMBIGUOUS':   return '系統有多位同名教練，請聯絡管理員協助綁定。';
    case 'NAME_REQUIRED':    return '請輸入您的姓名。';
    case 'BIND_RACE':        return '綁定衝突，請重新登入。';
    case 'HANDOFF_INVALID':
    case 'HANDOFF_EXPIRED':  return '登入連結已失效，請重新登入。';
    case 'RATE_LIMITED':     return '嘗試次數過多，請稍後再試。';
    // ── token 交換 / session 階段 ──
    case 'EXCHANGE_FAILED':
    case 'LINK_FAILED':
    case 'SESSION_FAILED':   return '登入處理失敗，請重新登入。';
    default:                 return '登入失敗，請重新嘗試。';
  }
}

export default function CoachPortalLoginPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { coach, setCoach } = useAuth();
  const toast = useToast();

  // 'checking' | 'need_name' | 'button' | 'error' | 'not_configured'
  const [state, setState] = useState('checking');
  const [handoff, setHandoff] = useState(null);
  const [displayName, setDisplayName] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState('');
  const ranRef = useRef(false);

  // 成功登入後：寫入 AuthContext（JWT）+ 存 30天 portal token → 進 /coach
  function finishLogin(res) {
    if (!res?.coach || !res?.token) throw new Error('登入回應不完整');
    setCoach({ ...res.coach, token: res.token });
    if (res.portalToken) {
      try { localStorage.setItem(COACH_PORTAL_TOKEN_KEY, res.portalToken); } catch { /* noop */ }
    }
    navigate('/coach', { replace: true });
  }

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;

    const lineLogin = params.get('lineLogin');
    const code = params.get('code');
    const newToken = params.get('token');
    const errorParam = params.get('error');

    (async () => {
      // 4) OAuth 端回報錯誤
      if (errorParam) {
        setErrMsg(mapError(errorParam));
        setState(errorParam === 'not_configured' ? 'not_configured' : 'error');
        return;
      }

      // 2) A 層命中 → 換 token
      if (lineLogin === 'existing' && code) {
        setState('checking');
        try {
          finishLogin(await coachPortalApi.exchange(code));
        } catch (err) {
          setErrMsg(mapError(err));
          setState('error');
        }
        return;
      }

      // 3) A miss → 姓名表單
      if (lineLogin === 'new' && newToken) {
        setHandoff(newToken);
        try {
          const info = await coachPortalApi.tokenInfo(newToken);
          setDisplayName(info?.displayName || '');
        } catch { /* 失敗仍可填姓名 */ }
        setState('need_name');
        return;
      }

      // 1) 無參數：已登入？/ 靜默 resume？/ 顯示按鈕
      if (coach && coach.id) {
        navigate('/coach', { replace: true });
        return;
      }
      const pt = (() => { try { return localStorage.getItem(COACH_PORTAL_TOKEN_KEY); } catch { return null; } })();
      if (pt) {
        try {
          finishLogin(await coachPortalApi.resume(pt));
          return;
        } catch {
          try { localStorage.removeItem(COACH_PORTAL_TOKEN_KEY); } catch { /* noop */ }
        }
      }
      // 檢查 channel 是否已設定
      try {
        const st = await coachPortalApi.status();
        setState(st?.configured ? 'button' : 'not_configured');
      } catch {
        setState('button');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmitName(e) {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) { toast.error('請輸入姓名'); return; }
    setBusy(true);
    try {
      finishLogin(await coachPortalApi.linkByName(handoff, trimmed));
      toast.success('登入成功');
    } catch (err) {
      // handoff 為一次性，失敗後需重新走 LINE 授權
      setErrMsg(mapError(err));
      setState('error');
    } finally {
      setBusy(false);
    }
  }

  const Header = () => (
    <div className="mb-6 text-center">
      <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-primary text-2xl font-bold text-white">
        DAOS
      </div>
      <h1 className="text-xl font-bold text-brand-primary">夢想體育學院</h1>
      <p className="mt-1 text-sm text-gray-500">教練端</p>
    </div>
  );

  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center px-6 py-10">
      <Header />

      {state === 'checking' && (
        <div className="w-full max-w-[320px] text-center">
          <LoadingSpinner label="正在以 LINE 帳號登入…" />
        </div>
      )}

      {state === 'button' && (
        <div className="w-full max-w-[320px] text-center">
          <p className="mb-5 text-sm leading-6 text-gray-600">請使用您的 LINE 帳號登入教練端。</p>
          <button
            type="button"
            onClick={() => { window.location.href = COACH_LINE_LOGIN_URL; }}
            className="w-full rounded-lg bg-[#06C755] py-3 text-base font-bold text-white active:opacity-90"
          >
            使用 LINE 登入
          </button>
        </div>
      )}

      {state === 'need_name' && (
        <form onSubmit={handleSubmitName} className="w-full max-w-[320px] space-y-4">
          <div className="rounded-lg border border-brand-teal/30 bg-brand-teal/5 p-3 text-xs leading-5 text-brand-primary">
            {displayName ? `${displayName} 您好，` : ''}LINE 身分已驗證，您的帳號尚未綁定教練。
            請輸入您的<strong>真實姓名</strong>以完成綁定（須與系統員工資料一致）。
          </div>
          <div>
            <label htmlFor="coachName" className="mb-1 block text-sm font-medium text-gray-700">姓名</label>
            <input
              id="coachName"
              type="text"
              placeholder="請輸入姓名"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-4 py-3 text-base focus:border-brand-teal focus:outline-none focus:ring-2 focus:ring-brand-teal/30"
              disabled={busy}
            />
          </div>
          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-lg bg-brand-primary py-3 text-base font-bold text-white active:bg-brand-teal disabled:opacity-50"
          >
            {busy ? '綁定中…' : '完成綁定並登入'}
          </button>
          {busy && <LoadingSpinner label="比對教練資料中…" />}
        </form>
      )}

      {state === 'error' && (
        <div className="w-full max-w-[340px] rounded-xl border border-rose-200 bg-rose-50 p-5 text-center">
          <p className="text-sm leading-6 text-rose-800">{errMsg || '登入失敗，請重新嘗試。'}</p>
          <button
            type="button"
            onClick={() => { window.location.href = COACH_LINE_LOGIN_URL; }}
            className="mt-4 w-full rounded-lg bg-brand-primary py-2 text-sm font-bold text-white active:bg-brand-teal"
          >
            重新用 LINE 登入
          </button>
        </div>
      )}

      {state === 'not_configured' && (
        <div className="w-full max-w-[340px] rounded-xl border border-amber-200 bg-amber-50 p-5 text-center">
          <p className="text-sm leading-6 text-amber-800">{errMsg || 'LINE 登入尚未設定，請聯絡管理員。'}</p>
        </div>
      )}
    </div>
  );
}
