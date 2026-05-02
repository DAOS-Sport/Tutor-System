import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import LoadingSpinner from '../components/LoadingSpinner';
import { learnApi } from '../api/learn';

const FIELDS = [
  { key: 'summary',      label: '上課摘要',  cat: '上課摘要' },
  { key: 'highlights',   label: '表現亮點',  cat: '表現亮點' },
  { key: 'improvements', label: '待加強',    cat: '需加強' },
  { key: 'homework',     label: '回家練習',  cat: '回家練習' },
];

const EMPTY = { summary: '', highlights: '', improvements: '', homework: '', media: [], tags: [], status: 'draft' };

export default function SessionRecordFormPage() {
  const { sessionId } = useParams();
  const { coach } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [form, setForm] = useState(EMPTY);
  const [tags, setTags] = useState({ system: [], personal: [] });
  const [activeField, setActiveField] = useState('summary');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [newPersonal, setNewPersonal] = useState('');

  useEffect(() => {
    if (!coach?.id || !sessionId) return;
    let alive = true;
    Promise.all([learnApi.getRecord(sessionId), learnApi.tags()])
      .then(([rec, t]) => {
        if (!alive) return;
        setForm({ ...EMPTY, ...(rec || {}), media: rec?.media || [], tags: rec?.tags || [] });
        setTags(t || { system: [], personal: [] });
      })
      .catch((e) => alive && toast.error(e?.response?.data?.error || '載入失敗'))
      .finally(() => alive && setLoaded(true));
    return () => { alive = false; };
  }, [coach?.id, sessionId]); // eslint-disable-line

  const tagsForActive = useMemo(() => {
    const f = FIELDS.find((x) => x.key === activeField);
    if (!f) return [];
    return tags.system.filter((t) => t.category_name === f.cat);
  }, [tags, activeField]);

  const personalForActive = useMemo(() => {
    const f = FIELDS.find((x) => x.key === activeField);
    if (!f) return [];
    return (tags.personal || []).filter((t) => t.category_name === f.cat || !t.category_id);
  }, [tags, activeField]);

  async function addPersonal() {
    const text = newPersonal.trim();
    if (!text) return;
    const f = FIELDS.find((x) => x.key === activeField);
    const cat = tags.system.find((t) => t.category_name === f?.cat);
    try {
      const created = await learnApi.addPersonalTag({
        category_id: cat?.category_id || null,
        label: text.slice(0, 40),
        text_template: text,
      });
      setTags((prev) => ({ ...prev, personal: [...(prev.personal || []), { ...created, category_name: f?.cat }] }));
      setNewPersonal('');
    } catch (e) { toast.error(e?.response?.data?.error || '新增失敗'); }
  }

  async function removePersonal(t) {
    if (!confirm(`刪除個人標籤「${t.label}」？`)) return;
    try {
      await learnApi.removePersonalTag(t.id);
      setTags((prev) => ({ ...prev, personal: prev.personal.filter((x) => x.id !== t.id) }));
    } catch (e) { toast.error(e?.response?.data?.error || '刪除失敗'); }
  }

  function setField(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  function applyTag(t) {
    const cur = form[activeField] || '';
    const next = cur ? `${cur}\n${t.text_template}` : t.text_template;
    setField(activeField, next);
    if (!form.tags.includes(t.label)) setForm((f) => ({ ...f, tags: [...f.tags, t.label] }));
  }

  async function copyPrev() {
    try {
      const prev = await learnApi.copyPrev(sessionId);
      if (!prev) { toast.info('找不到前一堂的紀錄'); return; }
      setForm((f) => ({ ...f, summary: prev.summary, highlights: prev.highlights, improvements: prev.improvements, homework: prev.homework }));
      toast.success('已套用前一堂內容，可繼續編輯');
    } catch (e) { toast.error(e?.response?.data?.error || '載入失敗'); }
  }

  async function uploadFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const m = await learnApi.upload(file);
      setForm((f) => ({ ...f, media: [...(f.media || []), m] }));
    } catch (e2) { toast.error(e2?.response?.data?.error || '上傳失敗'); }
    finally { setUploading(false); e.target.value = ''; }
  }

  function removeMedia(i) {
    setForm((f) => ({ ...f, media: f.media.filter((_, idx) => idx !== i) }));
  }

  async function save(submit = false) {
    setBusy(true);
    try {
      await learnApi.saveRecord(sessionId, form);
      if (submit) { await learnApi.submitRecord(sessionId); toast.success('已送出，家長即可查看'); }
      else toast.success('已儲存草稿');
      navigate(-1);
    } catch (e) { toast.error(e?.response?.data?.error || '儲存失敗'); }
    finally { setBusy(false); }
  }

  if (!loaded) return <div className="px-4 py-6"><LoadingSpinner label="載入中…" /></div>;

  const submitted = form.status === 'submitted';

  return (
    <div className="px-4 py-4 pb-24">
      <button onClick={() => navigate(-1)} className="mb-3 text-sm text-brand-teal active:opacity-60">‹ 返回</button>

      <header className="mb-3 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-brand-primary">授課記錄</h1>
          <p className="mt-1 text-xs text-gray-500">F-C05 / 點擊標籤即帶入文案</p>
        </div>
        <button onClick={copyPrev} className="rounded-full bg-brand-teal/10 px-3 py-1.5 text-xs font-bold text-brand-teal">
          複製前一堂
        </button>
      </header>

      {submitted && (
        <div className="mb-3 rounded-lg bg-brand-green/10 p-2 text-xs text-brand-green">
          已送出。再次儲存將建立新版本，家長端會看到最新內容。
        </div>
      )}

      <div className="space-y-3">
        {FIELDS.map((f) => (
          <div key={f.key}>
            <label className="text-xs font-bold text-brand-primary">{f.label}</label>
            <textarea
              value={form[f.key] || ''}
              onFocus={() => setActiveField(f.key)}
              onChange={(e) => setField(f.key, e.target.value)}
              placeholder={`點上方標籤可自動帶入「${f.cat}」文案`}
              rows={3}
              maxLength={4000}
              className={`mt-1 w-full rounded-lg border bg-white p-2 text-sm focus:outline-none ${activeField === f.key ? 'border-brand-teal' : 'border-gray-200'}`}
            />
          </div>
        ))}
      </div>

      <section className="mt-4 rounded-xl border border-brand-primary/15 bg-white p-3">
        <h3 className="text-xs font-bold text-brand-primary">{FIELDS.find((x) => x.key === activeField)?.cat} 標籤</h3>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {tagsForActive.map((t) => (
            <button key={t.id} onClick={() => applyTag(t)} type="button"
              className="rounded-full bg-brand-teal/10 px-3 py-1 text-xs font-bold text-brand-teal active:bg-brand-teal/20">
              + {t.label}
            </button>
          ))}
          {tagsForActive.length === 0 && <p className="text-xs text-gray-400">此分類暫無標籤</p>}
        </div>

        <div className="mt-3 border-t border-dashed border-gray-200 pt-2">
          <p className="text-[11px] font-bold text-brand-primary">我的常用</p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {personalForActive.map((t) => (
              <span key={t.id} className="inline-flex items-center gap-1 rounded-full bg-brand-gold/10 px-2.5 py-1 text-xs">
                <button type="button" onClick={() => applyTag(t)} className="font-bold text-brand-gold">+ {t.label}</button>
                <button type="button" onClick={() => removePersonal(t)} className="text-[10px] text-red-500" aria-label="刪除">×</button>
              </span>
            ))}
            {personalForActive.length === 0 && <p className="text-[11px] text-gray-400">尚無個人標籤</p>}
          </div>
          <div className="mt-2 flex gap-2">
            <input value={newPersonal} onChange={(e) => setNewPersonal(e.target.value)}
                   placeholder="新增個人常用文案…" maxLength={120}
                   className="flex-1 rounded border border-gray-200 px-2 py-1 text-xs" />
            <button type="button" onClick={addPersonal} disabled={!newPersonal.trim()}
                    className="rounded bg-brand-gold px-3 py-1 text-xs font-bold text-white disabled:opacity-50">＋</button>
          </div>
        </div>

        {form.tags?.length > 0 && (
          <p className="mt-2 text-[11px] text-gray-500">已附加：{form.tags.join('、')}</p>
        )}
      </section>

      <section className="mt-4 rounded-xl border border-brand-primary/15 bg-white p-3">
        <h3 className="text-xs font-bold text-brand-primary">媒體附件</h3>
        <label className="mt-2 inline-block rounded bg-brand-primary/10 px-3 py-1.5 text-xs font-bold text-brand-primary active:opacity-80">
          {uploading ? '上傳中…' : '＋ 新增照片 / 影片'}
          <input type="file" accept="image/*,video/*" disabled={uploading} onChange={uploadFile} className="hidden" />
        </label>
        <ul className="mt-2 space-y-1 text-xs">
          {form.media?.map((m, i) => (
            <li key={i} className="flex items-center justify-between rounded bg-gray-50 px-2 py-1.5">
              <a href={m.url} target="_blank" rel="noreferrer" className="truncate text-brand-teal">{m.name || m.url.slice(-30)}</a>
              <button onClick={() => removeMedia(i)} className="ml-2 text-red-500">×</button>
            </li>
          ))}
        </ul>
      </section>

      <div className="fixed inset-x-0 bottom-0 mx-auto flex max-w-md gap-2 border-t border-gray-200 bg-white px-4 py-3">
        <button disabled={busy} onClick={() => save(false)}
          className="flex-1 rounded-xl border border-brand-teal py-3 text-sm font-bold text-brand-teal disabled:opacity-50">
          儲存草稿
        </button>
        <button disabled={busy} onClick={() => save(true)}
          className="flex-1 rounded-xl bg-brand-primary py-3 text-sm font-bold text-white disabled:opacity-50">
          {submitted ? '更新版本' : '送出給家長'}
        </button>
      </div>
    </div>
  );
}
