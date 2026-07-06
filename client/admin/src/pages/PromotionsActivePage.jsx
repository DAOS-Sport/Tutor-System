import React, { useEffect, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import StatusBadge from '../components/StatusBadge';
import { promotionsApi } from '../api/promotions';
import { useToast } from '../context/ToastContext';

function fmtDiscount(p) {
  return p.type === 'PERCENTAGE'
    ? `${Math.round(Number(p.discount_value) * 100)}% (折抵 ${Math.round((1 - Number(p.discount_value)) * 100)}%)`
    : `折抵 NT$${Number(p.discount_value)}`;
}

export default function PromotionsActivePage() {
  const toast = useToast();
  const [list, setList] = useState(null);

  useEffect(() => {
    promotionsApi.active()
      .then(setList)
      .catch(() => { toast.error('載入失敗'); setList([]); });
  }, [toast]);

  return (
    <div className="space-y-4">
      <PageHeader title="進行中優惠 (F-R05)" subtitle="行政櫃檯推銷參考用，唯讀。" />
      {list === null ? (
        <LoadingSpinner />
      ) : list.length === 0 ? (
        <div className="rounded-lg bg-white p-10 text-center text-sm text-gray-400">目前沒有進行中的優惠活動。</div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {list.map((p) => (
            <div key={p.id} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-bold text-brand-primary">{p.name}</h3>
                <StatusBadge tone="green">啟用中</StatusBadge>
              </div>
              {p.description && <p className="mt-1 text-xs text-gray-500">{p.description}</p>}
              <dl className="mt-3 grid grid-cols-2 gap-y-1 text-xs">
                <dt className="text-gray-400">折扣</dt><dd className="text-gray-700">{fmtDiscount(p)}</dd>
                <dt className="text-gray-400">期間</dt><dd className="text-gray-700">{p.start_date} ～ {p.end_date}</dd>
                <dt className="text-gray-400">已用 / 總上限</dt><dd className="text-gray-700">{p.current_uses}{p.max_uses ? ` / ${p.max_uses}` : '（不限）'}</dd>
                <dt className="text-gray-400">門檻</dt>
                <dd className="text-gray-700">{p.min_threshold_type ? `購買 ≥ ${p.min_threshold_value} 期` : '無'}</dd>
                <dt className="text-gray-400">適用組別</dt>
                <dd className="text-gray-700">{p.applicable_course_types?.length ? p.applicable_course_types.map((c) => `1對${c}`).join(' / ') : '全部'}</dd>
                <dt className="text-gray-400">適用場館</dt>
                <dd className="text-gray-700">{p.applicable_venue_ids?.length ? p.applicable_venue_ids.join(' / ') : '全部'}</dd>
                <dt className="text-gray-400">折價券</dt>
                <dd className="font-mono text-brand-teal">{p.coupon_code || '— (自動套用)'}</dd>
              </dl>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
