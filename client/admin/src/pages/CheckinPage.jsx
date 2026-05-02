import React, { useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import StatusBadge from '../components/StatusBadge';
import { useToast } from '../context/ToastContext';
import { sessionsApi } from '../api/sessions';
import {
  formatTWD, courseTypeLabel,
  paymentStatusLabel, paymentStatusTone,
  isValidTWPhone,
} from '../utils/format';

export default function CheckinPage() {
  const toast = useToast();
  const [phone, setPhone] = useState('');
  const [periodId, setPeriodId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  async function onLookup(e) {
    e?.preventDefault();
    if (!phone && !periodId) {
      toast.warning('請輸入家長手機或報名編號');
      return;
    }
    if (phone && !isValidTWPhone(phone)) {
      toast.error('手機格式不正確（09 + 8 碼）');
      return;
    }
    setBusy(true);
    try {
      const r = await sessionsApi.verifyCheckin({ phone, periodId });
      setResult(r);
      if (!r.found) toast.error('查無此家長 / 報名');
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setResult(null); setPhone(''); setPeriodId('');
  }

  return (
    <div>
      <PageHeader title="簽到驗證" subtitle="F-R03 · 櫃檯收到家長 / 學員時，輸入家長手機或報名編號核對" />

      <form
        onSubmit={onLookup}
        className="mb-6 grid grid-cols-1 gap-4 rounded-xl border border-gray-200 bg-white p-6 shadow-sm md:grid-cols-3"
      >
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">家長手機</label>
          <input
            type="tel"
            placeholder="09xxxxxxxx"
            value={phone}
            onChange={(e) => setPhone(e.target.value.trim())}
            className="w-full rounded-lg border border-gray-300 px-3 py-2"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">報名編號（擇一）</label>
          <input
            type="text"
            placeholder="CP1001"
            value={periodId}
            onChange={(e) => setPeriodId(e.target.value.trim())}
            className="w-full rounded-lg border border-gray-300 px-3 py-2"
          />
        </div>
        <div className="flex items-end gap-2">
          <button
            type="submit"
            disabled={busy}
            className="rounded-lg bg-brand-teal px-4 py-2 text-sm font-bold text-white hover:bg-brand-primary disabled:opacity-50"
          >
            {busy ? '查詢中…' : '查詢'}
          </button>
          <button
            type="button"
            onClick={reset}
            className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
          >
            清除
          </button>
        </div>
      </form>

      {busy && <LoadingSpinner />}

      {result && result.found && (
        <div className="rounded-xl border-2 border-brand-green bg-white p-6 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-lg font-bold text-brand-primary">驗證成功 ✓</h3>
            <StatusBadge tone={paymentStatusTone(result.enrollment.status)}>
              {paymentStatusLabel(result.enrollment.status)}
            </StatusBadge>
          </div>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div><dt className="text-gray-500">報名編號</dt><dd className="font-mono">{result.enrollment.id}</dd></div>
            <div><dt className="text-gray-500">家長</dt><dd>{result.enrollment.parent_name}（{result.enrollment.parent_phone}）</dd></div>
            <div><dt className="text-gray-500">學員</dt><dd>{result.enrollment.students.join('、')}</dd></div>
            <div><dt className="text-gray-500">組別</dt><dd>{courseTypeLabel(result.enrollment.course_type)}</dd></div>
            <div><dt className="text-gray-500">教練</dt><dd>{result.enrollment.coach}</dd></div>
            <div><dt className="text-gray-500">應收 / 已付</dt><dd>{formatTWD(result.enrollment.final_price)}</dd></div>
            {result.enrollment.total_sessions != null && (
              <div className="col-span-2">
                <dt className="text-gray-500">課程進度</dt>
                <dd>{result.enrollment.used_sessions || 0} / {result.enrollment.total_sessions} 堂</dd>
              </div>
            )}
          </dl>
          {result.session && (
            <div className="mt-4 rounded-lg bg-brand-green/10 p-3 text-sm text-brand-primary">
              <b>下一堂：</b>今天 {result.session.start}–{result.session.end}（{result.session.coach} 教練）
            </div>
          )}
        </div>
      )}

      {result && !result.found && (
        <div className="rounded-xl border-2 border-brand-error bg-brand-error-soft p-6 text-center text-brand-error-strong">
          查無對應的報名資料，請確認家長手機或編號是否正確。
        </div>
      )}
    </div>
  );
}
