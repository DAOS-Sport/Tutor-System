import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { evaluationsApi } from '../api/learn';

const DIMENSIONS = [
  { key: 'score_teaching', label: '教學內容' },
  { key: 'score_attitude', label: '教練態度' },
  { key: 'score_progress', label: '孩子進步幅度' },
  { key: 'score_overall',  label: '整體滿意度' },
];

function Stars({ value, onChange, disabled }) {
  return (
    <div className="flex gap-1">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" disabled={disabled} onClick={() => onChange?.(n)}
          className={`text-2xl ${n <= (value || 0) ? 'text-brand-gold' : 'text-gray-300'} ${disabled ? '' : 'active:scale-95'}`}>
          ★
        </button>
      ))}
    </div>
  );
}

export default function EvaluationFormPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [form, setForm] = useState({ score_teaching: 0, score_attitude: 0, score_progress: 0, score_overall: 0, comment: '', renew_intent: 'unknown' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    evaluationsApi.detail(id)
      .then((d) => {
        setData(d);
        if (d?.submitted_at) {
          setForm({
            score_teaching: d.score_teaching || 0, score_attitude: d.score_attitude || 0,
            score_progress: d.score_progress || 0, score_overall: d.score_overall || 0,
            comment: d.comment || '', renew_intent: d.renew_intent || 'unknown',
          });
        }
      })
      .catch((e) => {
        const msg = e?.response?.data?.error || (e?.response?.status === 404 ? '查無此評鑑邀請' : '載入失敗');
        setLoadError(msg);
        toast.error(msg);
      });
  }, [id]); // eslint-disable-line

  if (loadError) {
    return (
      <div className="px-4 py-8 text-center">
        <p className="text-sm text-gray-600">{loadError}</p>
        <button onClick={() => navigate(-1)} className="mt-4 rounded-full bg-brand-primary px-5 py-2 text-sm text-white active:opacity-80">返回</button>
      </div>
    );
  }
  if (!data) return <div className="px-4 py-6"><LoadingSpinner label="載入中…" /></div>;
  const submitted = !!data.submitted_at;

  async function submit() {
    for (const d of DIMENSIONS) {
      if (!form[d.key]) { toast.error(`請填寫「${d.label}」評分`); return; }
    }
    setBusy(true);
    try { await evaluationsApi.submit(id, form); toast.success('感謝您的評鑑！'); navigate(-1); }
    catch (e) { toast.error(e?.response?.data?.error || '送出失敗'); }
    finally { setBusy(false); }
  }

  return (
    <div className="px-4 py-4">
      <button onClick={() => navigate(-1)} className="mb-3 text-sm text-brand-teal active:opacity-60">‹ 返回</button>

      <header>
        <h1 className="text-xl font-bold text-brand-primary">期末評鑑</h1>
        <p className="mt-1 text-xs text-gray-500">F-S12 / 教練：{data.coach_name}</p>
        {submitted && <p className="mt-1 text-[11px] text-brand-green">已於 {new Date(data.submitted_at).toLocaleDateString()} 送出</p>}
      </header>

      <section className="mt-4 space-y-4 rounded-2xl border border-brand-primary/15 bg-white p-4">
        {DIMENSIONS.map((d) => (
          <div key={d.key} className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-700">{d.label}</span>
            <Stars value={form[d.key]} disabled={submitted} onChange={(n) => setForm((f) => ({ ...f, [d.key]: n }))} />
          </div>
        ))}
      </section>

      <section className="mt-4 rounded-2xl border border-brand-primary/15 bg-white p-4">
        <label className="text-xs font-bold text-brand-primary">想對教練 / 場館說的話</label>
        <textarea
          value={form.comment}
          disabled={submitted}
          onChange={(e) => setForm((f) => ({ ...f, comment: e.target.value }))}
          placeholder="（選填）建議或鼓勵都歡迎"
          rows={4}
          maxLength={1000}
          className="mt-1 w-full rounded-lg border border-gray-200 p-2 text-sm focus:border-brand-teal focus:outline-none disabled:bg-gray-50"
        />
      </section>

      <section className="mt-4 rounded-2xl border border-brand-primary/15 bg-white p-4">
        <p className="text-xs font-bold text-brand-primary">是否考慮續報？</p>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {[['yes', '考慮續報'], ['unknown', '再看看'], ['no', '不會續報']].map(([v, l]) => (
            <button key={v} type="button" disabled={submitted}
              onClick={() => setForm((f) => ({ ...f, renew_intent: v }))}
              className={`rounded-lg border py-2 text-xs font-bold ${form.renew_intent === v ? 'border-brand-primary bg-brand-primary text-white' : 'border-gray-200 text-gray-600'}`}>
              {l}
            </button>
          ))}
        </div>
      </section>

      {!submitted && (
        <button disabled={busy} onClick={submit}
          className="mt-6 w-full rounded-xl bg-brand-primary py-3 text-sm font-bold text-white disabled:opacity-50">
          送出評鑑
        </button>
      )}
    </div>
  );
}
