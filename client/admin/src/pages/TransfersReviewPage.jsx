import React, { useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { adminTransfersApi } from '../api/transfers';
import { formatTWDateTime } from '../utils/format';

const STATUS_TABS = [
  { key: 'all',            label: '全部',   color: 'bg-gray-100 text-gray-700' },
  { key: 'pending_review', label: '待審核', color: 'bg-amber-100 text-amber-700' },
  { key: 'approved',       label: '已核准', color: 'bg-green-100 text-green-700' },
  { key: 'rejected',       label: '已退回', color: 'bg-red-100 text-red-700' },
];

export default function TransfersReviewPage() {
  const toast = useToast();
  const [status, setStatus] = useState('pending_review');
  const [allList, setAllList] = useState(null);
  const [reviewing, setReviewing] = useState(null); // { row, action }
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  // 一次抓全部狀態，分頁切換改為前端過濾，讓每個分頁都能顯示正確筆數
  function reload() {
    setAllList(null);
    adminTransfersApi.list({})
      .then(setAllList)
      .catch((e) => { setAllList([]); toast.error(e?.response?.data?.error || '載入失敗'); });
  }
  useEffect(reload, []); // eslint-disable-line

  const counts = useMemo(() => {
    const c = { all: 0, pending_review: 0, approved: 0, rejected: 0 };
    if (Array.isArray(allList)) {
      c.all = allList.length;
      for (const r of allList) c[r.status] = (c[r.status] || 0) + 1;
    }
    return c;
  }, [allList]);

  const list = useMemo(() => {
    if (!Array.isArray(allList)) return null;
    return status === 'all' ? allList : allList.filter((r) => r.status === status);
  }, [allList, status]);

  async function submitReview() {
    if (!reviewing) return;
    if (reviewing.action === 'reject' && !note.trim()) {
      toast.error('拒絕原因必填'); return;
    }
    setBusy(true);
    try {
      const fn = reviewing.action === 'approve' ? adminTransfersApi.approve : adminTransfersApi.reject;
      await fn(reviewing.row.id, note.trim());
      toast.success(reviewing.action === 'approve' ? '已核准' : '已拒絕');
      setReviewing(null); setNote(''); reload();
    } catch (e) {
      toast.error(e?.response?.data?.error || '操作失敗');
    } finally { setBusy(false); }
  }

  return (
    <div>
      <PageHeader title="課程轉讓審核 (F-M04)" subtitle="家長申請將剩餘堂數轉給其他學員" />

      <div className="mb-3 flex gap-2">
        {STATUS_TABS.map((t) => (
          <button key={t.key} type="button" onClick={() => setStatus(t.key)}
            className={`rounded-full px-3 py-1.5 text-sm font-medium ${
              status === t.key ? 'bg-brand-primary text-white' : 'bg-gray-100 text-gray-600'
            }`}>
            {t.label}（{Array.isArray(list) ? counts[t.key] || 0 : '…'}）
          </button>
        ))}
      </div>

      {list === null ? <LoadingSpinner label="載入中…" /> : list.length === 0 ? (
        <EmptyBox label={`目前沒有 ${STATUS_TABS.find((t) => t.key === status)?.label} 的申請`} />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2 text-left">送出時間</th>
                <th className="px-3 py-2 text-left">轉出 (原家長 / 學員)</th>
                <th className="px-3 py-2 text-left">轉入</th>
                <th className="px-3 py-2 text-left">課程</th>
                <th className="px-3 py-2 text-right">剩餘</th>
                <th className="px-3 py-2 text-left">原因</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id} className="border-t border-gray-100">
                  <td className="px-3 py-2 text-xs text-gray-500">
                    {formatTWDateTime(r.created_at)}
                  </td>
                  <td className="px-3 py-2">
                    <div>{r.from_parent_name}</div>
                    <div className="text-xs text-gray-500">{r.from_parent_phone}・{r.from_student_name}</div>
                  </td>
                  <td className="px-3 py-2">
                    <div>{r.to_phone}</div>
                    {r.to_student_name && <div className="text-xs text-gray-500">{r.to_student_name}</div>}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    <div>{r.coach_name} 教練</div>
                    <div className="text-gray-500">{r.venue_id} 館・1 對 {r.course_type}</div>
                  </td>
                  <td className="px-3 py-2 text-right font-bold">{r.sessions_remaining}</td>
                  <td className="px-3 py-2 text-xs text-gray-600 max-w-[200px] truncate" title={r.reason}>
                    {r.reason || '—'}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {r.status === 'pending_review' ? (
                      <div className="flex justify-end gap-1">
                        <button onClick={() => { setReviewing({ row: r, action: 'approve' }); setNote(''); }}
                          className="rounded-md bg-brand-green px-3 py-1 text-xs font-bold text-white">核准</button>
                        <button onClick={() => { setReviewing({ row: r, action: 'reject' }); setNote(''); }}
                          className="rounded-md border border-red-500 px-3 py-1 text-xs font-bold text-red-600">拒絕</button>
                      </div>
                    ) : (
                      <span className="text-xs text-gray-400">{r.review_note || '—'}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {reviewing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !busy && setReviewing(null)}>
          <div className="w-full max-w-md rounded-xl bg-white p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-bold text-brand-primary mb-2">
              {reviewing.action === 'approve' ? '核准轉讓' : '拒絕轉讓'}
            </h3>
            <p className="text-xs text-gray-500 mb-3">
              {reviewing.row.from_parent_name} → {reviewing.row.to_phone}・{reviewing.row.sessions_remaining} 堂
            </p>
            <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={200}
              placeholder={reviewing.action === 'reject' ? '拒絕原因（必填）' : '備註（選填）'}
              className="w-full rounded-lg border border-gray-300 p-2 text-sm" />
            <div className="mt-3 flex justify-end gap-2">
              <button onClick={() => setReviewing(null)} disabled={busy}
                className="rounded-md border border-gray-300 px-3 py-1.5 text-sm">取消</button>
              <button onClick={submitReview} disabled={busy}
                className={`rounded-md px-3 py-1.5 text-sm font-bold text-white ${
                  reviewing.action === 'approve' ? 'bg-brand-green' : 'bg-red-500'
                } disabled:opacity-50`}>
                {busy ? '處理中…' : '送出'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyBox({ label }) {
  return (
    <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white p-10 text-center text-sm text-gray-500">
      {label}
    </div>
  );
}
