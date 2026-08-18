import React, { useEffect, useState } from 'react';
import { coachesApi } from '../api/coaches';
import { promotionsApi } from '../api/promotions';
import { promotionValueLabel } from '../utils/promotionLabel';

/**
 * 教練詳細介紹（家長端從小卡的「看詳細介紹」進來；教練端也用同一支做自己的預覽）。
 *
 * 只放現在就有真資料的欄位：大頭照、姓名、自介、授權場館、介紹圖片、進行中優惠。
 * 刻意不做「年資」「專長徽章」「頭銜」—— DB 沒有那些欄位，硬編等於假資料。
 *
 * 介紹圖片的權限在後端分角色：教練本人看得到全部（含未發布的），其他登入者只看得到
 * 「介紹已發布」的教練的圖。前端不必再判一次，拿到什麼就畫什麼。
 */
export default function CoachDetailModal({ coach, venueNames = [], onClose, onSelect, priceLabel, priceNote }) {
  const [media, setMedia] = useState(null);
  const [idx, setIdx] = useState(0);
  const [promos, setPromos] = useState(null);

  useEffect(() => {
    if (!coach?.id) return undefined;
    let alive = true;
    setMedia(null); setIdx(0);
    coachesApi.listMedia(coach.id)
      .then((d) => alive && setMedia(Array.isArray(d) ? d : []))
      .catch(() => alive && setMedia([]));
    // 與家長首頁同一支：自動套用、不需輸入代碼的那些。附加資訊，失敗就不顯示。
    promotionsApi.list()
      .then((d) => alive && setPromos(Array.isArray(d) ? d : []))
      .catch(() => alive && setPromos([]));
    return () => { alive = false; };
  }, [coach?.id]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; };
  }, [onClose]);

  if (!coach) return null;
  const initial = (coach.name || '？').slice(0, 1);
  const photos = media || [];

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 sm:items-center"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      role="dialog" aria-modal="true" aria-label="教練詳細介紹">
      <div className="flex h-[88vh] w-full max-w-md flex-col overflow-hidden rounded-t-2xl bg-white sm:rounded-2xl">

        {/* 關閉鍵浮在整個 modal 上，不綁在照片區 —— 沒有照片時它一樣要在。
            z-10 蓋過照片與縮圖列。 */}
        <button type="button" onClick={onClose} aria-label="關閉"
          className="absolute right-3 top-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-black/50 text-white">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>

        {/* 照片放進捲動區內，跟著內容一起滑。放在外面固定住的話，
            照片會像卡在上面、文字從它底下鑽過去。 */}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {photos.length > 0 && (
            <div className="relative aspect-[4/3] bg-gray-900">
              <img src={photos[idx]?.storage_url} alt="" className="h-full w-full object-contain" />
              {/* 頁碼放左下 —— 右上是關閉鍵的位置，兩個疊在一起會互相擋。 */}
              {photos.length > 1 && (
                <div className="absolute bottom-3 left-3 rounded-full bg-black/60 px-2.5 py-1 font-mono text-[11px] text-white">
                  {idx + 1} / {photos.length}
                </div>
              )}
            </div>
          )}

          {photos.length > 1 && (
            <div className="flex gap-2 overflow-x-auto bg-gray-900 px-3 pb-3">
              {photos.map((p, i) => (
                <button key={p.id} type="button" onClick={() => setIdx(i)}
                  className={`h-12 w-12 shrink-0 overflow-hidden rounded-lg border-2 bg-gray-800 transition ${
                    i === idx ? 'border-brand-teal' : 'border-transparent opacity-50'}`}>
                  <img src={p.storage_url} alt="" className="h-full w-full object-contain" />
                </button>
              ))}
            </div>
          )}

          <div className="flex items-center gap-3 border-b border-gray-100 p-4">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-primary text-xl font-bold text-white">
              {coach.avatar_url ? <img src={coach.avatar_url} alt="" className="h-full w-full object-cover" /> : initial}
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-lg font-bold text-gray-900">{coach.name}</h2>
              {coach.is_senior && (
                <span className="mt-1 inline-block rounded-full bg-brand-gold px-2 py-0.5 text-[11px] font-medium text-white">資深教練</span>
              )}
            </div>
          </div>

          <div className="border-b border-gray-100 p-4">
            <h3 className="mb-2 text-[11px] font-bold tracking-wider text-gray-400">教練介紹</h3>
            {/* 優先顯示詳細介紹；沒補充過就退回小卡上那段短的。
                兩段都空才顯示提示 —— 標題與空白區塊一起留著只會像壞掉。 */}
            <p className="whitespace-pre-line text-sm leading-relaxed text-gray-700">
              {coach.bio_detail?.trim() || coach.bio?.trim()
                || <span className="italic text-gray-400">（教練尚未填寫介紹）</span>}
            </p>
          </div>

          {venueNames.length > 0 && (
            <div className="border-b border-gray-100 p-4">
              <h3 className="mb-2 text-[11px] font-bold tracking-wider text-gray-400">授權場館</h3>
              <div className="flex flex-wrap gap-2">
                {venueNames.map((v) => (
                  <span key={v} className="rounded-lg border border-brand-teal/30 bg-brand-teal/5 px-2.5 py-1 text-xs font-medium text-brand-teal">{v}</span>
                ))}
              </div>
            </div>
          )}

          {promos && promos.length > 0 && (
            <div className="p-4">
              <h3 className="mb-2 text-[11px] font-bold tracking-wider text-gray-400">進行中的優惠</h3>
              <div className="space-y-1.5">
                {promos.map((p) => (
                  <div key={p.id} className="rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-bold text-amber-900">{p.title || p.name}</span>
                      <span className="shrink-0 text-[11px] font-bold text-amber-800">{promotionValueLabel(p)}</span>
                    </div>
                    {(p.expires_at || p.end_date) && (
                      <div className="mt-0.5 text-[11px] text-amber-800/80">
                        至 {String(p.expires_at || p.end_date).slice(0, 10)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-gray-400">報名時會自動套用，不需輸入代碼。</p>
            </div>
          )}
        </div>

        {onSelect && (
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-gray-200 bg-white p-4">
            <div className="min-w-0">
              {priceNote && <div className="truncate text-[11px] text-gray-400">{priceNote}</div>}
              <div className="text-lg font-bold text-brand-primary">{priceLabel}</div>
            </div>
            <button type="button" onClick={onSelect}
              className="shrink-0 rounded-xl bg-brand-teal px-5 py-3 text-sm font-bold text-white active:scale-95">
              選擇這位教練
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
