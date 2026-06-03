import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import CourseCard from '../components/CourseCard';
import IncompleteGroupOrdersBanner from '../components/IncompleteGroupOrdersBanner';
import LoadingSpinner from '../components/LoadingSpinner';
import { promotionsApi } from '../api/promotions';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { formatTWDate } from '../utils/format';

const COURSE_TYPES = [
  { type: 1, title: '1 對 1 個別教學', subtitle: '一位學員專屬教練', description: '完全客製化進度，最高效率提升技術。', basePrice: 9000 },
  { type: 2, title: '1 對 2 雙人班', subtitle: '與好友共學', description: '兩位學員共享教練，互相切磋學習。', basePrice: 6000 },
  { type: 3, title: '1 對 3 小團班', subtitle: '小組同訓', description: '三位學員精緻小班，氣氛輕鬆活潑。', basePrice: 4500 },
];

export default function HomePage() {
  const navigate = useNavigate();
  const { parent } = useAuth();
  const toast = useToast();
  const [promos, setPromos] = useState(null);

  useEffect(() => {
    let alive = true;
    promotionsApi
      .list()
      .then((d) => alive && setPromos(d || []))
      .catch(() => {
        if (!alive) return;
        // 優惠載入失敗不阻擋首頁，用 toast 提示且把 promos 設為空陣列讓 UI 繼續渲染
        setPromos([]);
        toast.error('優惠資訊載入失敗');
      });
    return () => {
      alive = false;
    };
  }, [toast]);

  return (
    <div className="px-4 py-4">
      <section className="mb-5 rounded-2xl bg-gradient-to-br from-brand-primary to-brand-teal p-4 text-white shadow-md">
        <p className="text-xs opacity-90">您好，{parent?.name || '夢想學員'}</p>
        <h2 className="mt-1 text-lg font-bold">準備好開始今天的訓練了嗎？</h2>
        <p className="mt-1 text-xs opacity-80">挑選喜愛的組別與教練，立即報名 ✨</p>
      </section>

      <IncompleteGroupOrdersBanner />

      <button
        type="button"
        onClick={() => navigate('/referral')}
        className="mb-3 flex w-full items-center justify-between rounded-2xl border border-brand-green/30 bg-gradient-to-r from-brand-green/10 to-brand-amber/10 p-3 text-left active:opacity-80"
      >
        <div>
          <div className="text-sm font-bold text-brand-green">🎁 邀請好友拿正期 9 折券</div>
          <div className="mt-0.5 text-[11px] text-gray-600">朋友透過你的連結報名體驗課享 5 折</div>
        </div>
        <span className="text-brand-green">›</span>
      </button>

      <div className="mb-5 grid grid-cols-2 gap-2">
        <button type="button" onClick={() => navigate('/my-lessons')}
          className="rounded-2xl border border-brand-teal/30 bg-white p-3 text-left active:bg-brand-teal/5">
          <div className="text-sm font-bold text-brand-teal">📋 上課記錄</div>
          <div className="mt-0.5 text-[11px] text-gray-500">查看出席與教練筆記</div>
        </button>
        <button type="button" onClick={() => navigate('/transfer/new')}
          className="rounded-2xl border border-brand-primary/20 bg-white p-3 text-left active:bg-gray-50">
          <div className="text-sm font-bold text-brand-primary">🔁 課程轉讓</div>
          <div className="mt-0.5 text-[11px] text-gray-500">將剩餘堂數轉給其他學員</div>
        </button>
      </div>

      {promos === null ? (
        <LoadingSpinner label="載入優惠中…" />
      ) : (
        promos.length > 0 && (
          <section className="mb-5">
            <h3 className="mb-2 text-sm font-bold text-brand-primary">🔥 進行中優惠</h3>
            <div className="space-y-2">
              {promos.map((p) => (
                <div
                  key={p.id}
                  className="rounded-xl border-l-4 border-brand-amber bg-amber-50 px-3 py-2.5 text-xs"
                >
                  <div className="font-bold text-brand-amber">{p.title}</div>
                  <div className="mt-0.5 text-gray-600">{p.description}</div>
                  <div className="mt-1 text-[11px] text-gray-400">
                    至 {formatTWDate(p.expires_at)}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )
      )}

      <section>
        <h3 className="mb-3 text-sm font-bold text-brand-primary">課程組別</h3>
        <div className="space-y-3">
          {COURSE_TYPES.map((t) => (
            <CourseCard
              key={t.type}
              variant="catalog"
              type={t}
              onClick={() => navigate(`/venue?courseType=${t.type}`)}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
