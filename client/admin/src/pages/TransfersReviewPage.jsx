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
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center md:p-4"
          onClick={() => !busy && setReviewing(null)}>
          {/* 家長名稱 + 手機號那行在 375px 上會折成兩三行，加上 textarea 與按鈕列，
              手機鍵盤彈出後（拒絕轉讓時原因必填，一定會彈）可視高度剩不到一半。
              原本沒有 max-h 也不能捲，「送出」被壓在鍵盤下方，轉讓案就卡在這裡。
              同 ReconcilePage.jsx:372 的寫法。

              另外原本在 375px 上這張卡是置中的：鍵盤沒彈出時「送出」停在螢幕垂直中線
              附近、單手拿手機的拇指構不到；鍵盤一彈出來又被往上推得更遠。改成 md 以下
              貼底升起的面板 —— 面板本來就貼著鍵盤上緣，按鈕永遠落在拇指區。
              md 以上原封不動回到 items-center + max-w-md + rounded-xl + 90dvh。
              pb 用 calc 疊上安全區：貼底後面板下緣會壓在 iPhone 的 home indicator 底下；
              桌機上 env() 求值為 0，等同原本的 p-5。 */}
          <div className="flex max-h-[85dvh] w-full flex-col rounded-t-2xl bg-white p-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] md:max-h-[90dvh] md:max-w-md md:rounded-xl" onClick={(e) => e.stopPropagation()}>
            {/* grabber：行動裝置上「這個可以往下拉」的通用暗示，桌機沒有這個手勢所以 md:hidden。 */}
            <div className="mx-auto -mt-2 mb-3 h-1 w-10 shrink-0 rounded-full bg-gray-300 md:hidden" aria-hidden="true" />
            <h3 className="text-base font-bold text-brand-primary mb-2 shrink-0">
              {reviewing.action === 'approve' ? '核准轉讓' : '拒絕轉讓'}
            </h3>
            <div className="flex-1 overflow-y-auto">
              <p className="text-xs text-gray-500 mb-3">
                {reviewing.row.from_parent_name} → {reviewing.row.to_phone}・{reviewing.row.sessions_remaining} 堂
              </p>
              <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={200}
                placeholder={reviewing.action === 'reject' ? '拒絕原因（必填）' : '備註（選填）'}
                className="w-full rounded-lg border border-gray-300 p-2 text-sm" />
            </div>
            <div className="mt-3 flex shrink-0 justify-end gap-2">
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
