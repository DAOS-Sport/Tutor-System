import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { venuesApi } from '../api/venues';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToast } from '../context/ToastContext';

export default function VenueSelectPage() {
  const [params] = useSearchParams();
  const courseType = params.get('courseType') || '1';
  const isTrial = params.get('trial') === '1'; // 試上流程（/trial 入口）一路帶到報名頁
  const navigate = useNavigate();
  const toast = useToast();
  const [venues, setVenues] = useState(null);
  const [loadError, setLoadError] = useState(null);

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    venuesApi
      .list()
      // 只留「該定價區已設定好品項與金額」的場館。沒設定完就出現在選單上，
      // 家長點進去會用抄來的佔位價下單，而且畫面完全正常 —— 那是最難發現的錯。
      // purchasable 是後端算的（該區有啟用中且有價格的課別），前端不自己判斷。
      .then((d) => alive && setVenues((d || []).filter((v) => v.purchasable !== false)))
      .catch(() => {
        if (!alive) return;
        setLoadError('場館清單載入失敗');
        toast.error('場館清單載入失敗');
      });
    return () => {
      alive = false;
    };
  }, [toast]);

  if (loadError) {
    return (
      <div className="px-4 py-8 text-center">
        <div className="mb-3 text-sm text-brand-error">{loadError}</div>
        <button
          type="button"
          onClick={() => navigate('/', { replace: true })}
          className="rounded-lg bg-brand-primary px-4 py-2 text-sm font-bold text-white"
        >
          回首頁
        </button>
      </div>
    );
  }
  if (!venues) return <LoadingSpinner fullPage label="載入場館中…" />;
  if (venues.length === 0) {
    return (
      <div className="px-4 py-8 text-center">
        <div className="mb-2 text-sm font-bold text-gray-700">目前沒有開放報名的場館</div>
        <p className="mb-4 text-xs leading-5 text-gray-500">
          場館的課程與金額尚未設定完成，請稍後再試或聯繫櫃檯。
        </p>
        <button
          type="button"
          onClick={() => navigate('/', { replace: true })}
          className="rounded-lg bg-brand-primary px-4 py-2 text-sm font-bold text-white"
        >回首頁</button>
      </div>
    );
  }

  return (
    <div className="px-4 py-4">
      <p className="mb-4 text-xs text-gray-500">選擇您要上課的場館{isTrial ? '（試上單次課）' : ''}</p>
      <div className="space-y-3">
        {venues.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => navigate(`/coaches?venue=${v.id}&courseType=${courseType}${isTrial ? '&trial=1' : ''}`)}
            className="block w-full rounded-2xl border border-gray-200 bg-white p-4 text-left active:scale-[0.99]"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-base font-bold text-brand-primary">{v.name}</h3>
                <p className="mt-1 text-xs text-gray-500">{v.address}</p>
              </div>
              <span className="shrink-0 rounded-full bg-brand-teal/10 px-2 py-1 text-xs font-bold text-brand-teal">
                {v.code}
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
