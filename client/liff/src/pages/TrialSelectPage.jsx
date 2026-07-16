import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import LoadingSpinner from '../components/LoadingSpinner';
import { courseTypesApi } from '../api/courseTypes';

// 試上課程選擇頁：只列「啟用中 AND trial_enabled」品項（F-A07 試上設定），
// 點選後沿用既有報名鏈路 /venue → /coaches → /enroll，以 ?trial=1 一路帶到報名頁。
export default function TrialSelectPage() {
  const navigate = useNavigate();
  const [types, setTypes] = useState(null);

  useEffect(() => {
    let alive = true;
    courseTypesApi
      .listActive()
      .then((d) => alive && setTypes(Array.isArray(d) ? d.filter((t) => t.trial_enabled === true) : []))
      .catch(() => alive && setTypes([]));
    return () => {
      alive = false;
    };
  }, []);

  if (!types) return <LoadingSpinner fullPage label="載入試上課程…" />;

  if (types.length === 0) {
    return (
      <div className="px-4 py-8 text-center">
        <div className="mb-3 text-sm text-gray-500">目前暫無開放試上的課程，請洽櫃檯或選擇一般報名</div>
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

  return (
    <div className="px-4 py-4">
      <div className="mb-4 rounded-xl bg-brand-teal/10 px-3 py-2 text-xs leading-relaxed text-brand-primary">
        單堂體驗・現場付費。試上後可直接續報一般課程。
      </div>
      <div className="space-y-3">
        {types.map((t) => (
          <button
            key={t.course_type}
            type="button"
            onClick={() => navigate(`/venue?courseType=${t.course_type}&trial=1`)}
            className="block w-full rounded-2xl border border-gray-200 bg-white p-4 text-left active:scale-[0.99]"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-base font-bold text-brand-primary">{t.title || t.label}</h3>
                {String(t.body || '').trim() && (
                  <p className="mt-1 text-xs leading-relaxed text-gray-500">{String(t.body).trim()}</p>
                )}
              </div>
              <span className="shrink-0 rounded-full bg-brand-teal/10 px-2.5 py-1 text-xs font-bold text-brand-teal">
                {t.trial_price != null
                  ? `NT$ ${Number(t.trial_price).toLocaleString()} / 堂`
                  : '單堂體驗'}
              </span>
            </div>
            {t.trial_price == null && (
              <p className="mt-2 text-[11px] text-gray-400">價格以報名頁試算為準</p>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}
