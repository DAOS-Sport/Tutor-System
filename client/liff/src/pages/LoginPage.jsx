import React, { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import liff from '@line/liff';
import { parentsApi } from '../api/parents';
import { coachesApi } from '../api/coaches';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { isValidTWPhone } from '../utils/format';
import LoadingSpinner from '../components/LoadingSpinner';

/**
 * 從 LIFF SDK 取得 ID Token；若 LIFF 未初始化或未登入則回傳 null
 * （dev / mock 模式下會走 phone-only 後備路徑）
 */
function tryGetLineIdToken() {
  try {
    if (typeof liff?.getIDToken === 'function' && liff.isLoggedIn?.()) {
      return liff.getIDToken() || null;
    }
  } catch { /* swallow — 走 phone-only fallback */ }
  return null;
}

/**
 * 教練端 LIFF 自動登入：在 LINE App 內進入 /coach* path 時自動嘗試
 *   liff.getProfile().userId + id_token → /api/coaches/by-line-uid
 *   成功 → 進 /coach
 *   404 COACH_LINE_NOT_BOUND → 顯示未綁定畫面（不再要求手機首次綁定）
 *   其他 → 顯示「請稍後再試」
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
 * LIFF 登入：以手機作為通用識別。
 *  0. 教練端 LIFF（path 含 /coach）+ LINE 內 + 已 LIFF login → 嘗試 by-line-uid 自動登入
 *  1. 先試家長 (Z01) — 找到 → 走家長分頁
 *  2. 找不到再試教練 (H01) — 找到 → 走教練分頁
 *  3. 都找不到 → 引導家長註冊
 */
export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { setParent, setCoach } = useAuth();
  const toast = useToast();
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const fromPath = location.state?.from?.pathname || '';
  const coachContext = isCoachLiffContext(fromPath);
  // 教練 context state：null=非教練 / 'checking' / 'unbound' / 'error'
  const [coachState, setCoachState] = useState(coachContext ? 'checking' : null);
  const autoRanRef = useRef(false);

  useEffect(() => {
    if (autoRanRef.current) return;
    autoRanRef.current = true;
    if (!coachContext) return;
    setBusy(true);
    tryCoachAutoLogin().then((res) => {
      if (res && typeof res === 'object' && res.status === 'success') {
        setCoach(res.coach);
        toast.success(`歡迎，${res.coach.name} 教練`);
        navigate('/coach', { replace: true });
        return;
      }
      if (res === 'unbound') setCoachState('unbound');
      else setCoachState('error');
    }).finally(() => setBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!isValidTWPhone(phone)) {
      toast.error('請輸入正確的台灣手機號碼（09xxxxxxxx）');
      return;
    }
    setBusy(true);
    try {
      const trimmed = phone.trim();
      const parent = await parentsApi.findByPhone(trimmed);
      if (parent) {
        setParent(parent);
        toast.success(`歡迎回來，${parent.name}`);
        navigate('/', { replace: true });
        return;
      }
      // 嘗試教練端登入：傳入 LINE id_token（若有）以走雙因素驗證；
      // 明確區分「真的查無此手機(404)」vs「速率限制(429)」vs「其他錯誤(5xx/network)」
      const idToken = tryGetLineIdToken();
      let coach = null;
      try {
        coach = await coachesApi.byPhone(trimmed, idToken);
      } catch (err) {
        const status = err?.response?.status;
        if (status === 429) {
          toast.error('登入嘗試過於頻繁，請 5 分鐘後再試');
          return;
        }
        if (status && status >= 500) {
          toast.error('伺服器忙線中，請稍後再試');
          return;
        }
        if (status && status !== 404) {
          toast.error(`查詢失敗（${status}）`);
          return;
        }
        coach = null; // 404 → 真的查無
      }
      if (coach) {
        setCoach(coach);
        toast.success(`歡迎，${coach.name} 教練`);
        navigate('/coach', { replace: true });
        return;
      }
      toast.info('查無此手機，請完成家長註冊');
      navigate(`/register?phone=${encodeURIComponent(trimmed)}`, { replace: true });
    } catch (err) {
      const status = err?.response?.status;
      if (status === 429) toast.error('登入嘗試過於頻繁，請 5 分鐘後再試');
      else if (status && status >= 500) toast.error('伺服器忙線中，請稍後再試');
      else toast.error('查詢失敗，請稍後再試');
    } finally {
      setBusy(false);
    }
  }

  // ── 教練 context 專屬畫面：未綁定 / 錯誤 / 自動登入中 ──
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
            <div className="mb-2 text-base font-bold text-amber-900">
              尚未完成綁定
            </div>
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
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-4 w-full rounded-lg bg-brand-primary py-2 text-sm font-bold text-white active:bg-brand-teal"
            >
              重新嘗試
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center px-6 py-10">
      <div className="mb-8 text-center">
        <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-2xl bg-brand-primary text-2xl font-bold text-white">
          DAOS
        </div>
        <h1 className="text-xl font-bold text-brand-primary">夢想體育學院</h1>
        <p className="mt-1 text-sm text-gray-500">家教課程系統</p>
      </div>

      <form onSubmit={handleSubmit} className="w-full max-w-[320px] space-y-4">
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
          <p className="mt-1 text-xs text-gray-500">系統會自動判斷家長 / 教練身分</p>
        </div>

        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-lg bg-brand-primary py-3 text-base font-bold text-white active:bg-brand-teal disabled:opacity-50"
        >
          {busy ? '查詢中…' : '登入 / 開始註冊'}
        </button>

        {busy && <LoadingSpinner label="比對 Z01 / H01 中…" />}

        <div className="pt-4 text-center text-xs leading-5 text-gray-400">
          試用帳號（mock）
          <br />家長：0912345678　教練：0911000001
        </div>
      </form>
    </div>
  );
}
