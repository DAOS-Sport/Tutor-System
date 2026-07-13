import React, { useEffect } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import LoadingSpinner from '../components/LoadingSpinner';
import { useAuth } from '../context/AuthContext';

/**
 * 家長 LINE 綁定的穩定入口。
 *
 * 新連結可直接指向 /liff/bind；舊的 LINE Login callback 也會安全 redirect 到這裡。
 * 本頁不接收 OAuth code/state/token，真正的身分驗證仍由 LoginPage 的 LIFF id_token
 * 流程處理，避免舊 callback 連結被拿來綁錯帳號或重放。
 */
export default function LineBindPage() {
  const { isAuthed, role } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const isParent = isAuthed && role === 'parent';
  const justBound = location.state?.binding === 'success';
  const legacyEntry = params.get('source') === 'legacy-callback';

  useEffect(() => {
    if (!isParent) navigate('/login?intent=bind', { replace: true });
  }, [isParent, navigate]);

  if (!isParent) {
    return <LoadingSpinner fullPage label="正在開啟 LINE 綁定…" />;
  }

  return (
    <div className="flex min-h-[100dvh] items-center justify-center px-5 py-10">
      <section className="w-full max-w-sm rounded-2xl border border-brand-teal/30 bg-white p-6 text-center shadow-sm">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-brand-green/10 text-3xl" aria-hidden>✓</div>
        <h1 className="mt-4 text-lg font-bold text-brand-primary">
          {justBound ? 'LINE 綁定成功' : 'LINE 已綁定'}
        </h1>
        <p className="mt-2 text-sm leading-6 text-gray-600">
          {justBound
            ? '您的 LINE 帳號已完成會員綁定，現在可以使用家長功能。'
            : '此 LINE 帳號已完成會員綁定，無需再次建立資料。'}
        </p>
        {legacyEntry && (
          <p className="mt-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs leading-5 text-gray-500">
            已安全地回到新版綁定入口；不會使用舊連結中的登入資訊。
          </p>
        )}
        <button
          type="button"
          onClick={() => navigate('/', { replace: true })}
          className="mt-5 w-full rounded-lg bg-brand-primary py-3 text-sm font-bold text-white active:bg-brand-teal"
        >
          前往會員首頁
        </button>
      </section>
    </div>
  );
}
