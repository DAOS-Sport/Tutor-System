import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { coursesApi } from '../api/courses';
import { transfersApi } from '../api/transfers';

export default function TransferRequestPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { parent } = useAuth();
  const [periods, setPeriods] = useState(null);
  const [mine, setMine] = useState([]);
  const [form, setForm] = useState({
    period_id: '', from_student_id: '', to_phone: '', to_student_name: '', reason: '',
  });
  const [busy, setBusy] = useState(false);

  function reload() {
    coursesApi.myCourses(parent.id).then((d) => setPeriods(Array.isArray(d) ? d.filter((c) => c.payment_status === 'active') : []))
      .catch(() => setPeriods([]));
    transfersApi.mine().then(setMine).catch(() => setMine([]));
  }
  useEffect(reload, []); // eslint-disable-line

  const selected = useMemo(
    () => (periods || []).find((p) => p.id === form.period_id),
    [periods, form.period_id]
  );
  const students = selected?.students || [];

  async function submit(e) {
    e.preventDefault();
    if (!form.period_id || !form.from_student_id) { toast.error('請選擇要轉出的課程與學員'); return; }
    if (!/^09\d{8}$/.test(form.to_phone)) { toast.error('轉入方手機格式錯誤'); return; }
    setBusy(true);
    try {
      await transfersApi.create(form);
      toast.success('已送出申請，等待主管審核');
      setForm({ period_id: '', from_student_id: '', to_phone: '', to_student_name: '', reason: '' });
      reload();
    } catch (err) {
      toast.error(err?.response?.data?.error || '送出失敗');
    } finally { setBusy(false); }
  }

  return (
    <div className="px-4 py-4">
      <h1 className="text-base font-bold text-brand-primary">課程轉讓申請</h1>
      <p className="mb-3 mt-0.5 text-xs text-gray-500">將剩餘堂數轉給其他學員（需主管審核）</p>

      {periods === null ? <LoadingSpinner label="載入課程中…" /> : (
        <form onSubmit={submit} className="space-y-3 rounded-2xl border border-gray-200 bg-white p-4">
          <Field label="要轉出的課程">
            <select required value={form.period_id} className="input"
              onChange={(e) => setForm({ ...form, period_id: e.target.value, from_student_id: '' })}>
              <option value="">請選擇…</option>
              {periods.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.coach?.name || p.coach_name} 教練・1對{p.course_type}・剩 {p.total_sessions - p.used_sessions} 堂
                </option>
              ))}
            </select>
          </Field>
          {students.length > 0 && (
            <Field label="轉出學員">
              <select required value={form.from_student_id} className="input"
                onChange={(e) => setForm({ ...form, from_student_id: e.target.value })}>
                <option value="">請選擇…</option>
                {students.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </Field>
          )}
          <Field label="轉入方手機（必填）">
            <input required type="tel" value={form.to_phone} placeholder="09XXXXXXXX" className="input"
              onChange={(e) => setForm({ ...form, to_phone: e.target.value })} />
          </Field>
          <Field label="轉入學員姓名（若對方是新學員）">
            <input type="text" value={form.to_student_name} placeholder="選填，主管核准時將自動建立"
              className="input" maxLength={50}
              onChange={(e) => setForm({ ...form, to_student_name: e.target.value })} />
          </Field>
          <Field label="轉讓原因">
            <textarea rows={2} maxLength={200} value={form.reason} className="input"
              onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </Field>
          <button type="submit" disabled={busy}
            className="w-full rounded-lg bg-brand-primary py-2.5 text-sm font-bold text-white disabled:opacity-50">
            {busy ? '送出中…' : '送出申請'}
          </button>
        </form>
      )}

      <h3 className="mt-6 mb-2 text-sm font-bold text-brand-primary">我的申請紀錄</h3>
      {mine.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-200 bg-white p-6 text-center text-xs text-gray-500">
          尚無轉讓紀錄
        </div>
      ) : (
        <div className="space-y-2">
          {mine.map((r) => (
            <div key={r.id} className="rounded-xl border border-gray-200 bg-white p-3 text-xs">
              <div className="flex items-center justify-between">
                <div className="font-bold">{r.coach_name} 教練・1對{r.course_type}</div>
                <StatusPill status={r.status} />
              </div>
              <div className="mt-1 text-gray-600">
                轉給 {r.to_phone}・{r.sessions_remaining} 堂
              </div>
              {r.review_note && (
                <div className="mt-1 text-[11px] text-gray-500">主管備註：{r.review_note}</div>
              )}
              <div className="mt-1 text-[10px] text-gray-400">
                {new Date(r.created_at).toLocaleString('zh-TW', { hour12: false })}
              </div>
            </div>
          ))}
        </div>
      )}

      <style>{`.input{width:100%;padding:.5rem .625rem;border:1px solid #d1d5db;border-radius:.5rem;font-size:.875rem}`}</style>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <div className="mb-1 text-xs font-medium text-gray-700">{label}</div>
      {children}
    </label>
  );
}

function StatusPill({ status }) {
  const map = {
    pending_review: { label: '審核中', cls: 'bg-amber-100 text-amber-700' },
    approved:       { label: '已核准', cls: 'bg-green-100 text-green-700' },
    rejected:       { label: '已拒絕', cls: 'bg-red-100 text-red-700' },
    cancelled:      { label: '已取消', cls: 'bg-gray-100 text-gray-500' },
  };
  const m = map[status] || { label: status, cls: 'bg-gray-100' };
  return <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${m.cls}`}>{m.label}</span>;
}
