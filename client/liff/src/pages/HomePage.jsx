import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import CourseCard from '../components/CourseCard';
import IncompleteGroupOrdersBanner from '../components/IncompleteGroupOrdersBanner';
import LoadingSpinner from '../components/LoadingSpinner';
import { promotionsApi } from '../api/promotions';
import { courseTypesApi } from '../api/courseTypes';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { formatTWDate } from '../utils/format';

// 組別卡片的文案（title/subtitle/description）；單人價格改由後台「課程介紹維護」設定，於下方動態帶入。
const COURSE_TYPES = [
  { type: 1, title: '1 對 1 個別教學', subtitle: '一位學員專屬教練', description: '完全客製化進度，最高效率提升技術。', basePrice: 9000 },
  { type: 2, title: '1 對 2 雙人班', subtitle: '與好友共學', description: '兩位學員共享教練，互相切磋學習。', basePrice: 6000 },
  { type: 3, title: '1 對 3 小團班', subtitle: '小組同訓', description: '三位學員精緻小班，氣氛輕鬆活潑。', basePrice: 4500 },
  { type: 4, title: '1 對 4-6 團體班', subtitle: '4~6 人共學', description: '多人團體課，依單人價計費、人數越多越划算。', basePrice: 3000 },
];
const TYPE_META = Object.fromEntries(COURSE_TYPES.map((t) => [t.type, t]));

export default function HomePage() {
  const navigate = useNavigate();
  const { parent } = useAuth();
  const toast = useToast();
  const [promos, setPromos] = useState(null);
  const [types, setTypes] = useState(null);

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
    // 組別與單人價格（由後台維護）；載入失敗時沿用本地預設，不阻擋首頁
    courseTypesApi
      .listActive()
      .then((d) => alive && setTypes(Array.isArray(d) ? d : null))
      .catch(() => alive && setTypes(null));
    return () => {
      alive = false;
    };
  }, [toast]);

  // 組別卡片：完全以後台「課程介紹維護」(/admin/course-intros) 為單一真實來源——
  // 啟用中的組別、標題、內文、封面圖、單人價格皆取自後台，與管理端即時對上。
  // 僅在 API 尚未載入 / 失敗時，才退回本地預設文案，確保首頁永遠有內容。
  const courseCards = useMemo(() => {
    if (!Array.isArray(types) || types.length === 0) return COURSE_TYPES;
    return types
      .slice()
      .sort((a, b) => (a.sort_order - b.sort_order) || (a.course_type - b.course_type))
      .map((t) => {
        const meta = TYPE_META[t.course_type] || {};
        const body = String(t.body || '').trim();
        return {
          type: t.course_type,
          title: t.title || meta.title || t.label,
          subtitle: Number(t.max_students) > 1 ? `每組最多 ${t.max_students} 人` : (meta.subtitle || ''),
          description: body || meta.description || '',
          basePrice: Number(t.base_price ?? meta.basePrice ?? 0),
          imageUrl: t.image_url || '',
        };
      });
  }, [types]);

  return (
    <div className="px-4 py-4">
      <section className="mb-5 rounded-2xl bg-gradient-to-br from-brand-primary to-brand-teal p-4 text-white shadow-md">
        <p className="text-xs opacity-90">您好，{parent?.name || '夢想學員'}</p>
        <h2 className="mt-1 text-lg font-bold">準備好開始今天的訓練了嗎？</h2>
        <p className="mt-1 text-xs opacity-80">挑選喜愛的組別與教練，立即報名 ✨</p>
      </section>

      <IncompleteGroupOrdersBanner />

      {/* 進行中優惠（取代原好友推薦 mgm 區塊；好友 mgm 功能已關閉） */}
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

      {/* 上課記錄/簽到：整列橫幅、橘底黑字（已移除「課程轉讓」入口） */}
      <button
        type="button"
        onClick={() => navigate('/my-courses')}
        className="mb-5 flex w-full items-center justify-between rounded-2xl bg-brand-amber p-4 text-left text-black active:opacity-90"
      >
        <div>
          <div className="text-sm font-bold">📋 上課記錄/簽到</div>
          <div className="mt-0.5 text-[11px] text-black/70">出席、簽到與教練筆記</div>
        </div>
        <span aria-hidden="true">›</span>
      </button>

      <section>
        <h3 className="mb-3 text-sm font-bold text-brand-primary">課程組別</h3>
        <div className="space-y-3">
          {courseCards.map((t) => (
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
