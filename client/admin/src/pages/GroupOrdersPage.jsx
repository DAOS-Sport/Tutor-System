import React, { useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { groupOrdersApi } from '../api/groupOrders';
import { venuesApi } from '../api/venues';
import ImageLightbox from '../components/ImageLightbox';
import { formatTWDateTime } from '../utils/format';

const courseLabel = (ct) => ({ 1: '一對一', 2: '一對二', 3: '一對三' }[ct] || `一對${ct}`);
const STATUS = {
  submitted: { label: '待審核', cls: 'bg-amber-100 text-amber-700' },
  approved: { label: '已核准', cls: 'bg-green-100 text-green-700' },
  rejected: { label: '已退回', cls: 'bg-red-100 text-red-700' },
};

export default function GroupOrdersPage() {
  const toast = useToast();
  const [allRows, setAllRows] = useState(null);
  const [statusFilter, setStatusFilter] = useState('submitted');
  const [detail, setDetail] = useState(null);
  const [detailId, setDetailId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [venues, setVenues] = useState([]);

  // 一次抓全部狀態，分頁切換前端過濾，讓每個分頁都能顯示正確筆數
  async function load() {
    setAllRows(null);
    try {
      const [data, vs] = await Promise.all([
        groupOrdersApi.list(undefined),
        venuesApi.list().catch(() => []),
      ]);
      setAllRows(Array.isArray(data) ? data : []);
      setVenues(Array.isArray(vs) ? vs : []);
    } catch (e) {
      toast.error(e?.response?.data?.error || '載入失敗');
      setAllRows([]);
    }
  }

  const venueName = (id) => venues.find((v) => String(v.id) === String(id))?.name || id || '—';

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const counts = useMemo(() => {
    const c = { all: 0, submitted: 0, approved: 0, rejected: 0 };
    if (Array.isArray(allRows)) {
      c.all = allRows.length;
      for (const r of allRows) c[r.status] = (c[r.status] || 0) + 1;
    }
    return c;
  }, [allRows]);

  const rows = useMemo(() => {
    if (!Array.isArray(allRows)) return null;
    return statusFilter === '' ? allRows : allRows.filter((r) => r.status === statusFilter);
  }, [allRows, statusFilter]);

  async function openDetail(id) {
    setDetailId(id);
    setDetail(null);
    setRejecting(false);
    setRejectReason('');
    try {
      setDetail(await groupOrdersApi.get(id));
    } catch (e) {
      toast.error(e?.response?.data?.error || '載入詳情失敗');
      setDetailId(null);
    }
  }

  function closeDetail() {
    setDetailId(null);
    setDetail(null);
  }

  async function handleApprove() {
    if (!detail) return;
    setBusy(true);
    try {
      const r = await groupOrdersApi.approve(detail.id);
      toast.success(`已核准，送待對帳清單 ${r.count ?? ''} 筆`);
      closeDetail();
      load();
    } catch (e) {
      const data = e?.response?.data;
      const missing = Array.isArray(data?.missing_members) ? data.missing_members : [];
      const suffix = missing.length ? `：${missing.map((m) => m.parent_name || m.parent_phone).join('、')}` : '';
      toast.error((data?.error || '核准失敗') + suffix, 5000);
    } finally { setBusy(false); }
  }

  async function handleReject() {
    if (!detail) return;
    if (!rejectReason.trim()) return toast.error('請填寫退回原因');
    setBusy(true);
    try {
      await groupOrdersApi.reject(detail.id, rejectReason.trim());
      toast.success('已退回此團購');
      closeDetail();
      load();
    } catch (e) {
      toast.error(e?.response?.data?.error || '退回失敗');
    } finally { setBusy(false); }
  }

  return (
    <div>
      <PageHeader title="團購審核" subtitle="家長發起的團購送審後在此核准／退回；核准後送待對帳清單，發票與開通在待對帳流程處理。" />

      <div className="mb-4 flex gap-2">
        {[['', '全部'], ['submitted', '待審核'], ['approved', '已核准'], ['rejected', '已退回']].map(([k, label]) => (
          <button key={k || 'all'} type="button" onClick={() => setStatusFilter(k)}
            className={`rounded-full px-4 py-1.5 text-sm font-medium ${statusFilter === k ? 'bg-brand-primary text-white' : 'bg-white text-gray-600 border border-gray-200'}`}>
            {label}（{Array.isArray(allRows) ? (k === '' ? counts.all : counts[k] || 0) : '…'}）
          </button>
        ))}
      </div>

      {rows === null ? (
        <LoadingSpinner label="載入團購中…" />
      ) : rows.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white px-6 py-12 text-center text-sm text-gray-500">
          目前沒有符合條件的團購
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-left text-xs text-gray-500">
              <tr>
                <th className="px-4 py-3">序號</th>
                <th className="px-4 py-3">團主</th>
                <th className="px-4 py-3">組別</th>
                <th className="px-4 py-3">教練</th>
                <th className="px-4 py-3">場館</th>
                <th className="px-4 py-3">家庭數</th>
                <th className="px-4 py-3">學生數</th>
                <th className="px-4 py-3">送審時間</th>
                <th className="px-4 py-3">狀態</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((g) => (
                <tr key={g.id} className="border-t border-gray-100">
                  <td className="px-4 py-3">
                    <button type="button" title={g.id} onClick={() => openDetail(g.id)}
                      className="font-mono text-xs text-brand-primary underline-offset-2 hover:underline">
                      {String(g.id).slice(0, 8).toUpperCase()}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-gray-800">{g.leader_name}</div>
                    <div className="text-xs text-gray-400">{g.leader_phone}</div>
                  </td>
                  <td className="px-4 py-3">{courseLabel(g.course_type)}</td>
                  <td className="px-4 py-3">{g.coach_name || '—'}</td>
                  <td className="px-4 py-3 text-xs">{venueName(g.venue_id)}</td>
                  <td className="px-4 py-3">{g.member_count}</td>
                  <td className="px-4 py-3">{g.total_students} / {g.min_students}–{g.max_students}</td>
                  <td className="px-4 py-3 text-xs text-gray-600">
                    <div>{g.submitted_at ? formatTWDateTime(g.submitted_at) : '—'}</div>
                    {!g.submitted_at && <div className="text-gray-400">開團 {formatTWDateTime(g.created_at)}</div>}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${STATUS[g.status]?.cls || 'bg-gray-100 text-gray-500'}`}>
                      {STATUS[g.status]?.label || g.status}
                    </span>
                    {g.reviewed_at && (
                      <div className="mt-1 text-[10px] text-gray-400">{formatTWDateTime(g.reviewed_at)}{g.reviewed_by ? `・${g.reviewed_by}` : ''}</div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button type="button" onClick={() => openDetail(g.id)}
                      className="rounded-lg bg-brand-primary px-3 py-1.5 text-xs font-bold text-white">檢視</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detailId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={closeDetail}>
          <div className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl bg-white p-5" onClick={(e) => e.stopPropagation()}>
            {!detail ? (
              <LoadingSpinner label="載入詳情…" />
            ) : (
              <>
                <div className="mb-3 flex items-center justify-between">
                  <h2 className="text-lg font-bold text-brand-primary">
                    {courseLabel(detail.course_type)} 團購
                    {detail.period_count > 1 && <span className="ml-2 text-sm font-bold text-amber-600">· {detail.period_count} 期</span>}
                  </h2>
                  <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${STATUS[detail.status]?.cls || 'bg-gray-100 text-gray-500'}`}>
                    {STATUS[detail.status]?.label || detail.status}
                  </span>
                </div>
                <div className="mb-2 rounded-lg bg-gray-50 px-3 py-2">
                  <span className="text-xs text-gray-500">序號：</span>
                  <span className="select-all font-mono text-xs font-bold text-gray-700">{detail.id}</span>
                </div>
                <div className="mb-3 grid grid-cols-2 gap-2 text-sm text-gray-600">
                  <div>團主：<span className="font-medium text-gray-800">{detail.leader_name}</span></div>
                  <div>電話：{detail.leader_phone}</div>
                  <div>教練：{detail.coach_name || '—'}</div>
                  <div>開團人數：{detail.min_students}–{detail.max_students}</div>
                  <div>場館：{venueName(detail.venue_id)}</div>
                  <div>開團時間：{formatTWDateTime(detail.created_at)}</div>
                  <div>送審時間：{detail.submitted_at ? formatTWDateTime(detail.submitted_at) : '—'}</div>
                  <div>審核：{detail.reviewed_at ? `${formatTWDateTime(detail.reviewed_at)}${detail.reviewed_by ? `・${detail.reviewed_by}` : ''}` : '—'}</div>
                </div>
                {detail.note && <p className="mb-3 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-500">備註：{detail.note}</p>}
                {detail.status === 'rejected' && detail.reject_reason && (
                  <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">退回原因：{detail.reject_reason}</p>
                )}

                <h3 className="mb-2 text-sm font-bold text-gray-700">成員（{detail.members?.length} 個家庭）</h3>
                <div className="space-y-2">
                  {(detail.members || []).map((m) => (
                    <div key={m.id} className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-medium text-gray-800">
                          {m.parent_name} {m.is_leader && <span className="ml-1 rounded bg-brand-primary/10 px-1.5 py-0.5 text-[10px] font-bold text-brand-primary">團主</span>}
                        </div>
                        <div className="text-xs text-gray-400">{m.parent_phone}</div>
                      </div>
                      <div className="mt-1 text-xs text-gray-500">學生：{(m.student_names || []).join('、') || '—'}</div>
                      <div className="mt-1 text-xs text-gray-400">
                        加入：{formatTWDateTime(m.joined_at)}
                        {m.proof_uploaded_at && <>・上傳付款資料：{formatTWDateTime(m.proof_uploaded_at)}</>}
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                        <span className="text-gray-500">末 5 碼：<span className="font-mono font-bold text-gray-700">{m.transfer_last_5 || '—'}</span></span>
                        <span className={m.payment_confirmed ? 'font-bold text-green-600' : 'font-bold text-amber-600'}>
                          {m.payment_confirmed ? '帳款已確認' : '待確認'}
                        </span>
                      </div>
                      {m.payment_proof_url ? (
                        <div className="mt-2 flex items-center gap-2">
                          <ImageLightbox
                            src={m.payment_proof_url}
                            alt={`${m.parent_name || '成員'} 匯款證明`}
                            label={`${m.parent_name || '成員'} 匯款證明`}
                            thumbnailClassName="h-14 w-14"
                          />
                          <span className="text-xs font-bold text-slate-600">匯款證明</span>
                        </div>
                      ) : m.transfer_last_5 ? (
                        // 末 5 碼或匯款證明擇一即可核准（與後端守門一致）；有末 5 碼可直接查帳。
                        <div className="mt-1 text-xs text-slate-500">未上傳匯款證明（已填末 5 碼，可查帳）</div>
                      ) : (
                        <div className="mt-1 text-xs text-red-500">缺付款資料（末 5 碼或匯款證明）</div>
                      )}
                    </div>
                  ))}
                </div>

                <div className="mt-4">
                  <h3 className="mb-2 text-sm font-bold text-gray-700">操作紀錄</h3>
                  {(detail.audit_logs || []).length === 0 ? (
                    <p className="text-xs text-gray-400">尚無紀錄（此團購建立於操作紀錄功能上線前）</p>
                  ) : (
                    <ul className="space-y-1 text-xs text-gray-600">
                      {detail.audit_logs.map((a, i) => (
                        <li key={i} className="flex gap-2">
                          <span className="w-32 shrink-0 font-mono text-gray-400">{formatTWDateTime(a.at)}</span>
                          <span className="flex-1">
                            {a.action}
                            {a.reason && <span className="text-gray-400">（{a.reason}）</span>}
                          </span>
                          <span className="shrink-0 text-gray-500">— {a.by}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {detail.status === 'submitted' && (
                  <div className="mt-4 border-t border-gray-100 pt-4">
                    {!rejecting ? (
                      <div className="flex gap-2">
                        <button type="button" disabled={busy} onClick={handleApprove}
                          className="flex-1 rounded-lg bg-brand-green py-2.5 text-sm font-bold text-white disabled:opacity-50">核准後送待對帳</button>
                        <button type="button" disabled={busy} onClick={() => setRejecting(true)}
                          className="flex-1 rounded-lg border border-red-300 py-2.5 text-sm font-bold text-red-500">退回</button>
                      </div>
                    ) : (
                      <div>
                        <textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)}
                          rows={2} placeholder="退回原因（必填）"
                          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-teal focus:outline-none" />
                        <div className="mt-2 flex gap-2">
                          <button type="button" disabled={busy} onClick={handleReject}
                            className="flex-1 rounded-lg bg-red-500 py-2.5 text-sm font-bold text-white disabled:opacity-50">確認退回</button>
                          <button type="button" disabled={busy} onClick={() => setRejecting(false)}
                            className="flex-1 rounded-lg border border-gray-300 py-2.5 text-sm font-bold text-gray-600">取消</button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {detail.status === 'rejected' && detail.reject_reason && (
                  <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">退回原因：{detail.reject_reason}</p>
                )}
                <button type="button" onClick={closeDetail}
                  className="mt-4 w-full rounded-lg bg-gray-100 py-2 text-sm font-bold text-gray-600">關閉</button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
