import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import LoadingSpinner from '../components/LoadingSpinner';
import { learnApi } from '../api/learn';

const FIELDS = [
  { key: 'goals',              label: '本期學習目標',     placeholder: '例：穩定基本擊球、建立比賽節奏…' },
  { key: 'expected_outcomes',  label: '預期成果',         placeholder: '完成一場 11 分制三戰兩勝對打…' },
  { key: 'learning_plan',      label: '訓練規劃',         placeholder: '6 堂課程的進度安排…' },
  { key: 'initial_assessment', label: '初評（程度 / 體能）', placeholder: '握拍方式 / 揮拍軌跡 / 體能水準…' },
  { key: 'notes',              label: '備註',             placeholder: '需與家長溝通事項…' },
];

const EMPTY = { goals: '', expected_outcomes: '', learning_plan: '', initial_assessment: '', notes: '', status: 'draft' };

export default function LessonPlanFormPage() {
  const { periodId } = useParams();
  const { coach } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!coach?.id || !periodId) return;
    let alive = true;
    learnApi.getPlan(periodId)
      .then((p) => alive && setForm({ ...EMPTY, ...(p || {}) }))
      .catch((e) => alive && toast.error(e?.response?.data?.error || '載入失敗'))
      .finally(() => alive && setLoaded(true));
    return () => { alive = false; };
  }, [coach?.id, periodId]); // eslint-disable-line

  function setField(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  async function handleSave(publish = false) {
    setBusy(true);
    try {
      await learnApi.savePlan(periodId, form);
      if (publish) {
        await learnApi.publishPlan(periodId);
        toast.success('已發佈，家長可在學習歷程查看');
      } else {
        toast.success('已儲存草稿');
      }
      navigate(-1);
    } catch (e) {
      toast.error(e?.response?.data?.error || '儲存失敗');
    } finally { setBusy(false); }
  }

  if (!loaded) return <div className="px-4 py-6"><LoadingSpinner label="載入中…" /></div>;

  const published = form.status === 'published';

  return (
    <div className="px-4 py-4">
      <button onClick={() => navigate(-1)} className="mb-3 text-sm text-brand-teal active:opacity-60">‹ 返回</button>

      <header className="mb-4">
        <h1 className="text-xl font-bold text-brand-primary">課前規劃</h1>
        <p className="mt-1 text-xs text-gray-500">F-C04 / 完成後可發佈，家長端「學習歷程」即可看到</p>
        {published && (
          <span className="mt-1 inline-block rounded-full bg-brand-green/15 px-2 py-0.5 text-[11px] font-bold text-brand-green">
            已發佈
          </span>
        )}
      </header>

      <div className="space-y-4">
        {FIELDS.map((f) => (
          <div key={f.key}>
            <label className="text-xs font-bold text-brand-primary">{f.label}</label>
            <textarea
              value={form[f.key] || ''}
              onChange={(e) => setField(f.key, e.target.value)}
              placeholder={f.placeholder}
              rows={3}
              maxLength={4000}
              className="mt-1 w-full rounded-lg border border-gray-200 bg-white p-2 text-sm focus:border-brand-teal focus:outline-none"
            />
          </div>
        ))}
      </div>

      <div className="sticky bottom-0 -mx-4 mt-6 flex gap-2 border-t border-gray-200 bg-white px-4 py-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => handleSave(false)}
          className="flex-1 rounded-xl border border-brand-teal py-3 text-sm font-bold text-brand-teal active:opacity-90 disabled:opacity-50"
        >
          儲存草稿
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => handleSave(true)}
          className="flex-1 rounded-xl bg-brand-primary py-3 text-sm font-bold text-white active:opacity-90 disabled:opacity-50"
        >
          {published ? '更新並重新發佈' : '發佈給家長'}
        </button>
      </div>
    </div>
  );
}
