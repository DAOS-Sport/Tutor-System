import React, { useRef, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { manualDeductionsApi } from '../api/manualDeductions';

function createRequestId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch { /* noop */ }
  return `manual-deduct-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function ManualDeductionPage() {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [reason, setReason] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState('');
  const requestIdsRef = useRef(new Map());

  async function search(e) {
    e?.preventDefault();
    const q = query.trim();
    if (q.length < 2) {
      toast.warning('請輸入至少 2 個字元（報名單號、家長姓名／手機或學員姓名）');
      return;
    }
    setLoading(true);
    try {
      const result = await manualDeductionsApi.search(q);
      setRows(Array.isArray(result) ? result : []);
      if (!Array.isArray(result) || result.length === 0) toast.info('查無可手動扣課的進行中課期');
    } catch (err) {
      toast.error(err?.response?.data?.error || '查詢課期失敗');
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  async function deduct(row, student) {
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      toast.warning('請先填寫扣課原因');
      return;
    }
    if (Number(row.remaining_sessions) < 1) {
      toast.error('此課期已無剩餘堂數，不能扣成負數');
      return;
    }
    const key = `${row.course_period_id}:${row.is_shared_period ? 'shared' : student.id}`;
    if (busyKey) return;
    const requestId = requestIdsRef.current.get(key) || createRequestId();
    requestIdsRef.current.set(key, requestId);
    setBusyKey(key);
    try {
      const result = await manualDeductionsApi.create({
        course_period_id: row.course_period_id,
        student_id: student.id,
        reason: trimmedReason,
        request_id: requestId,
      });
      const after = Number(result?.deduction?.remaining_after);
      setRows((prev) => prev.map((item) => (
        item.course_period_id === row.course_period_id
          ? {
            ...item,
            used_sessions: Number(item.used_sessions || 0) + (result?.idempotent ? 0 : 1),
            remaining_sessions: Number.isFinite(after)
              ? after
              : Math.max(0, Number(item.remaining_sessions || 0) - (result?.idempotent ? 0 : 1)),
          }
          : item
      )));
      requestIdsRef.current.delete(key);
      toast.success(result?.idempotent ? '已確認原扣課操作，未重複扣除' : '已手動扣除 1 堂，餘額與上課紀錄已同步');
    } catch (err) {
      // 保留 request_id，網路逾時後同一操作 retry 會回到同一筆 ledger，而非再扣一次。
      toast.error(err?.response?.data?.error || '手動扣課失敗，尚未變更畫面餘額');
    } finally {
      setBusyKey('');
    }
  }

  return (
    <div>
      <PageHeader title="手動扣課" subtitle="輸入報名單號、家長或學員查詢；每次扣 1 堂並留下不可覆寫的稽核紀錄" />

      <form onSubmit={search} className="mb-4 rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
        <label htmlFor="manual-deduction-search" className="mb-1 block text-xs font-medium text-gray-600">查詢課期</label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id="manual-deduction-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="報名單號、家長姓名／手機或學員姓名"
            className="min-w-0 flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-teal focus:outline-none"
          />
          <button type="submit" disabled={loading} className="rounded-lg bg-brand-primary px-4 py-2 text-sm font-bold text-white disabled:opacity-50">
            {loading ? '查詢中…' : '查詢'}
          </button>
        </div>
        <label htmlFor="manual-deduction-reason" className="mb-1 mt-3 block text-xs font-medium text-gray-600">扣課原因 <span className="text-brand-error">*</span></label>
        <textarea
          id="manual-deduction-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value.slice(0, 1000))}
          rows={2}
          placeholder="例如：經家長確認，補登 2026/07/12 已完成的課程"
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-teal focus:outline-none"
        />
      </form>

      {loading && <LoadingSpinner />}
      {!loading && rows.length === 0 && query && (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white px-4 py-10 text-center text-sm text-gray-500">尚無可扣課結果</div>
      )}
      <div className="space-y-3">
        {rows.map((row) => (
          <section key={row.course_period_id} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <h2 className="text-sm font-bold text-gray-800">{row.parent_name || '課期'} <span className="font-normal text-gray-500">{row.parent_phone || ''}</span></h2>
                <p className="mt-1 text-xs text-gray-500">{row.venue_name || row.venue_id} · {row.coach || '未標示教練'} · 報名 {row.admin_enrollment_id || '—'}</p>
              </div>
              <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-bold ${Number(row.remaining_sessions) > 0 ? 'bg-brand-green/10 text-brand-primary' : 'bg-gray-100 text-gray-500'}`}>
                剩餘 {row.remaining_sessions} / {row.total_sessions} 堂
              </span>
            </div>
            {row.is_shared_period && !row.shared_checkin_usage_v2_enabled && (
              <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
                此為共享課期。為避免誤扣其他團購成員堂數，請改由「簽到驗證」處理整班出席。
              </p>
            )}
            <div className="mt-3 flex flex-wrap gap-2 border-t border-gray-100 pt-3">
              {row.is_shared_period && row.shared_checkin_usage_v2_enabled && row.students?.length > 0 ? (
                <button
                  type="button"
                  disabled={Number(row.remaining_sessions) < 1 || !!busyKey}
                  onClick={() => deduct(row, row.students[0])}
                  className="rounded-lg border border-brand-teal px-3 py-2 text-sm font-bold text-brand-teal transition hover:bg-brand-teal/10 disabled:cursor-not-allowed disabled:border-gray-200 disabled:text-gray-400"
                >
                  {busyKey === `${row.course_period_id}:shared`
                    ? '正在建立共享到課紀錄…'
                    : `全體簽到並扣 1 堂（${row.students.length} 人）`}
                </button>
              ) : (row.students || []).map((student) => {
                const key = `${row.course_period_id}:${student.id}`;
                const disabled = Number(row.remaining_sessions) < 1 || !!busyKey || !!row.is_shared_period;
                return (
                  <button
                    key={student.id}
                    type="button"
                    disabled={disabled}
                    onClick={() => deduct(row, student)}
                    className="rounded-lg border border-brand-teal px-3 py-2 text-sm font-bold text-brand-teal transition hover:bg-brand-teal/10 disabled:cursor-not-allowed disabled:border-gray-200 disabled:text-gray-400"
                  >
                    {busyKey === key ? `正在扣除 ${student.name}…` : `扣除 ${student.name} 1 堂`}
                  </button>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
