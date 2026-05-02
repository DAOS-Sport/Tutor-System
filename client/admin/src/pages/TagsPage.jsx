import React, { useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { adminTagsApi } from '../api/learn';

const EMPTY_TAG = { category_id: '', label: '', text_template: '', is_active: true };

export default function TagsPage() {
  const { toast } = useToast();
  const [data, setData] = useState(null);
  const [tagForm, setTagForm] = useState(EMPTY_TAG);
  const [editId, setEditId] = useState(null);
  const [catName, setCatName] = useState('');
  const [busy, setBusy] = useState(false);

  function reload() {
    setData(null);
    adminTagsApi.list()
      .then((r) => setData(r))
      .catch((e) => { setData({ categories: [], tags: [] }); toast(e?.response?.data?.error || e.message, 'error'); });
  }
  useEffect(reload, []); // eslint-disable-line

  const grouped = useMemo(() => {
    if (!data) return [];
    return data.categories.map((c) => ({
      ...c,
      items: data.tags.filter((t) => t.category_id === c.id),
    }));
  }, [data]);

  function startEdit(t) { setEditId(t.id); setTagForm({ category_id: t.category_id, label: t.label, text_template: t.text_template, is_active: t.is_active }); }
  function reset() { setEditId(null); setTagForm(EMPTY_TAG); }

  async function submitTag(e) {
    e.preventDefault();
    if (!tagForm.category_id || !tagForm.label.trim() || !tagForm.text_template.trim()) {
      toast('分類 / 標籤名稱 / 文案皆必填', 'error'); return;
    }
    setBusy(true);
    try {
      if (editId) await adminTagsApi.updateTag(editId, tagForm);
      else await adminTagsApi.createTag(tagForm);
      toast('已儲存', 'success'); reset(); reload();
    } catch (e2) { toast(e2?.response?.data?.error || '儲存失敗', 'error'); }
    finally { setBusy(false); }
  }

  async function toggleActive(t) {
    try { await adminTagsApi.updateTag(t.id, { is_active: !t.is_active }); reload(); }
    catch (e) { toast(e?.response?.data?.error || '更新失敗', 'error'); }
  }

  async function removeTag(t) {
    if (!confirm(`確定刪除標籤「${t.label}」？`)) return;
    try { await adminTagsApi.removeTag(t.id); toast('已刪除', 'success'); reload(); }
    catch (e) { toast(e?.response?.data?.error || '刪除失敗', 'error'); }
  }

  async function addCategory(e) {
    e.preventDefault();
    if (!catName.trim()) return;
    try { await adminTagsApi.createCategory({ name: catName.trim() }); setCatName(''); reload(); }
    catch (e2) { toast(e2?.response?.data?.error || '新增失敗', 'error'); }
  }

  async function removeCategory(c) {
    if (!confirm(`刪除分類「${c.name}」會同時刪除其所有標籤，確定？`)) return;
    try { await adminTagsApi.removeCategory(c.id); reload(); }
    catch (e) { toast(e?.response?.data?.error || '刪除失敗', 'error'); }
  }

  if (!data) return <div className="p-6"><LoadingSpinner /></div>;

  return (
    <div className="p-6">
      <PageHeader title="標籤庫管理" subtitle="F-A08 / 教練填授課記錄時點擊即帶入文案" />

      <section className="mt-4 grid gap-4 md:grid-cols-3">
        <form onSubmit={addCategory} className="rounded-2xl border border-brand-primary/15 bg-white p-4 md:col-span-1">
          <h3 className="mb-2 text-sm font-bold text-brand-primary">分類</h3>
          <div className="flex gap-2">
            <input value={catName} onChange={(e) => setCatName(e.target.value)} placeholder="新增分類…" className="flex-1 rounded border px-2 py-1.5 text-sm" />
            <button className="rounded bg-brand-teal px-3 py-1.5 text-xs font-bold text-white">新增</button>
          </div>
          <ul className="mt-3 space-y-1.5">
            {data.categories.map((c) => (
              <li key={c.id} className="flex items-center justify-between rounded bg-gray-50 px-2 py-1.5 text-sm">
                <span>{c.name}</span>
                <button type="button" onClick={() => removeCategory(c)} className="text-xs text-red-500 hover:underline">刪除</button>
              </li>
            ))}
          </ul>
        </form>

        <form onSubmit={submitTag} className="rounded-2xl border border-brand-primary/15 bg-white p-4 md:col-span-2">
          <h3 className="mb-2 text-sm font-bold text-brand-primary">{editId ? '編輯標籤' : '新增標籤'}</h3>
          <div className="grid gap-2 md:grid-cols-2">
            <select value={tagForm.category_id} onChange={(e) => setTagForm({ ...tagForm, category_id: e.target.value })}
                    className="rounded border px-2 py-1.5 text-sm">
              <option value="">— 選擇分類 —</option>
              {data.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <input value={tagForm.label} onChange={(e) => setTagForm({ ...tagForm, label: e.target.value })}
                   placeholder="標籤名稱（≤ 40 字）" className="rounded border px-2 py-1.5 text-sm" />
          </div>
          <textarea value={tagForm.text_template} onChange={(e) => setTagForm({ ...tagForm, text_template: e.target.value })}
                    placeholder="文案範本（教練點擊時插入到授課記錄）" rows={3}
                    className="mt-2 w-full rounded border px-2 py-1.5 text-sm" />
          <div className="mt-2 flex items-center justify-between">
            <label className="text-xs text-gray-600">
              <input type="checkbox" checked={tagForm.is_active} onChange={(e) => setTagForm({ ...tagForm, is_active: e.target.checked })} className="mr-1" />
              啟用中
            </label>
            <div className="flex gap-2">
              {editId && <button type="button" onClick={reset} className="rounded border px-3 py-1.5 text-xs">取消</button>}
              <button disabled={busy} className="rounded bg-brand-teal px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50">
                {editId ? '更新' : '新增'}
              </button>
            </div>
          </div>
        </form>
      </section>

      <section className="mt-6 space-y-4">
        {grouped.map((g) => (
          <div key={g.id} className="rounded-2xl border border-gray-200 bg-white p-4">
            <h3 className="mb-2 text-sm font-bold text-brand-primary">{g.name} <span className="text-xs text-gray-400">（{g.items.length}）</span></h3>
            <div className="flex flex-wrap gap-2">
              {g.items.map((t) => (
                <div key={t.id} className={`group max-w-xs rounded-xl border px-3 py-2 text-xs ${t.is_active ? 'border-brand-primary/20 bg-brand-primary/5' : 'border-gray-200 bg-gray-50 opacity-60'}`}>
                  <div className="flex items-center justify-between gap-2">
                    <button type="button" onClick={() => startEdit(t)} className="font-bold text-brand-primary hover:underline">{t.label}</button>
                    <div className="flex gap-1.5">
                      <button onClick={() => toggleActive(t)} className="text-[10px] text-gray-500 hover:underline">{t.is_active ? '停用' : '啟用'}</button>
                      <button onClick={() => removeTag(t)} className="text-[10px] text-red-500 hover:underline">刪</button>
                    </div>
                  </div>
                  <p className="mt-1 text-gray-600">{t.text_template}</p>
                </div>
              ))}
              {g.items.length === 0 && <p className="text-xs text-gray-400">尚無標籤</p>}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
