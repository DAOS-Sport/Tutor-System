import React, { useEffect, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { courseIntrosApi } from '../api/courseIntros';
import { courseTypeLabel } from '../utils/format';

function IntroCard({ courseType, intro, onSave }) {
  const toast = useToast();
  const [draft, setDraft] = useState({ ...intro });
  const [busy, setBusy] = useState(false);
  const dirty = ['title', 'body', 'image_url'].some((k) => (draft[k] || '') !== (intro[k] || ''));

  async function save() {
    if (!draft.title?.trim() || !draft.body?.trim()) {
      toast.error('標題與內文不可為空');
      return;
    }
    setBusy(true);
    try {
      await onSave(courseType, draft);
      toast.success(`已儲存「${courseTypeLabel(courseType)}」介紹`);
    } catch {
      toast.error('儲存失敗');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <div className="text-base font-bold text-brand-primary">
          {courseTypeLabel(courseType)} <span className="text-xs font-normal text-gray-400">type = {courseType}</span>
        </div>
        <button
          onClick={save}
          disabled={!dirty || busy}
          className="rounded-lg bg-brand-teal px-3 py-1.5 text-sm font-bold text-white hover:bg-brand-primary disabled:opacity-50"
        >
          {busy ? '儲存中…' : '儲存'}
        </button>
      </div>
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">標題</label>
          <input
            type="text"
            value={draft.title || ''}
            onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            className="w-full rounded-lg border border-gray-300 px-3 py-2"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">內文</label>
          <textarea
            rows={4}
            value={draft.body || ''}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            className="w-full rounded-lg border border-gray-300 px-3 py-2"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700">封面圖片網址（可選）</label>
          <input
            type="text"
            placeholder="https://..."
            value={draft.image_url || ''}
            onChange={(e) => setDraft({ ...draft, image_url: e.target.value })}
            className="w-full rounded-lg border border-gray-300 px-3 py-2"
          />
        </div>
      </div>
    </div>
  );
}

export default function CourseIntrosPage() {
  const [intros, setIntros] = useState(null);

  useEffect(() => { courseIntrosApi.list().then(setIntros); }, []);

  async function onSave(type, patch) {
    const res = await courseIntrosApi.update(type, patch);
    setIntros((m) => ({ ...m, [type]: res }));
  }

  if (!intros) return <LoadingSpinner fullPage />;

  return (
    <div>
      <PageHeader title="課程介紹維護" subtitle="F-A04 · LIFF 首頁三個組別卡片內容由此維護" />
      <div className="space-y-5">
        {[1, 2, 3].map((t) => (
          <IntroCard key={t} courseType={t} intro={intros[t]} onSave={onSave} />
        ))}
      </div>
    </div>
  );
}
