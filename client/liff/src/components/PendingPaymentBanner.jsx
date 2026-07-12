import React from 'react';
import { useNavigate } from 'react-router-dom';
import { usePendingPayments } from '../context/PendingPaymentsContext';

/**
 * 首頁「尚未上傳付款資料」提醒橫幅。
 * 家長常在報名送出後跳出畫面去轉帳，訂單就停在「待對帳、未上傳付款資料」狀態被遺忘，
 * 甚至誤以為沒送出而重複報名。此橫幅在首頁醒目提示待處理筆數，點擊直接導向
 * 「我的課程 → 待審核」分頁補上傳。沒有待處理訂單時不顯示（回傳 null）。
 */
export default function PendingPaymentBanner() {
  const navigate = useNavigate();
  const { count } = usePendingPayments();

  if (count <= 0) return null;

  return (
    <section className="mb-5">
      <button
        type="button"
        onClick={() => navigate('/my-courses?tab=review')}
        className="flex w-full items-center justify-between gap-3 rounded-2xl border border-brand-error/30 bg-brand-error/5 p-4 text-left active:opacity-80"
      >
        <div className="flex min-w-0 items-center gap-3">
          <span className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-brand-error/10 text-xl">
            💳
            <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-error px-1 text-[11px] font-bold leading-none text-white">
              {count > 99 ? '99+' : count}
            </span>
          </span>
          <div className="min-w-0">
            <div className="text-sm font-bold text-brand-error">
              有 {count} 筆訂單尚未上傳付款資料
            </div>
            <div className="mt-0.5 text-[11px] text-gray-600">
              報名尚未完成，點此前往「我的課程」補上傳，以免重複報名
            </div>
          </div>
        </div>
        <span className="shrink-0 text-brand-error">›</span>
      </button>
    </section>
  );
}
