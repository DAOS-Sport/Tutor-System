import React, { useEffect, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { courseTypesApi } from '../api/courseTypes';

const autoLabel = (ct) => {
  const map = { 1: '一對一', 2: '一對二', 3: '一對三', 4: '一對四', 5: '一對五', 6: '一對六' };
  return map[ct] || `一對${ct}`;
};

const fmtDate = (v) => (v ? String(v).slice(0, 10).replace(/-/g, '/') : '—');
const fmtMoney = (v) => `NT$ ${Number(v || 0).toLocaleString('en-US')}`;
const pad2 = (n) => String(n).padStart(2, '0');
// 排程生效改為 timestamptz：以瀏覽器本地時間（櫃台在台灣＝台北）顯示「日期 時:分」。
const fmtDateTime = (v) => {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
// timestamptz → <input type="datetime-local"> 需要的本地值（YYYY-MM-DDTHH:MM）。
const toLocalInput = (v) => {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const FIELD_LABELS = { label: '名稱', base_price: '每期價格', min_students: '最少學生', max_students: '最多學生', is_active: '狀態', data_group: '資料管理群組' };
const showVal = (k, v) => (k === 'base_price' ? fmtMoney(v) : k === 'is_active' ? (v ? '啟用中' : '已停用') : (v ?? '—'));

export default function CourseTypesPage() {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [saving, setSaving] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ course_type: '', label: '', min_students: '', max_students: '', base_price: '', data_group: '' });
  const [addErr, setAddErr] = useState('');
  const [editing, setEditing] = useState(null); // 整列 + 表單狀態
  const [editErr, setEditErr] = useState('');

  const today = (rows && rows[0]?.current_date) ? fmtDate(rows[0].current_date) : fmtDate(new Date().toISOString());

  async function load() {
    try {
      const data = await courseTypesApi.list();
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      toast.error(e?.response?.data?.error || '載入失敗');
      setRows([]);
    }
  }
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function toggleActive(row) {
    setSaving(row.course_type);
    try {
      await courseTypesApi.update(row.course_type, { is_active: !row.is_active });
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.error || '更新失敗');
    } finally { setSaving(null); }
  }

  async function handleAdd(e) {
    e.preventDefault();
    setAddErr('');
    // 「拿掉所有驗證」：僅課程編號（主鍵）需可解析為整數，其餘交由後端做安全預設。
    const ct = parseInt(form.course_type, 10);
    if (isNaN(ct)) return setAddErr('課程編號必須為整數');
    try {
      await courseTypesApi.create({
        course_type: ct,
        label: form.label,
        min_students: form.min_students,
        max_students: form.max_students,
        base_price: form.base_price,
        data_group: form.data_group.trim() || null,
      });
      setShowAdd(false);
      setForm({ course_type: '', label: '', min_students: '', max_students: '', base_price: '', data_group: '' });
      toast.success(`已新增「${form.label.trim() || autoLabel(ct)}」`);
      await load();
    } catch (e) {
      setAddErr(e?.response?.data?.error || '新增失敗');
    }
  }

  function startEdit(row) {
    setEditing({
      course_type: row.course_type,
      label: row.label,
      base_price: String(row.base_price ?? 0),
      min_students: String(row.min_students ?? 1),
      max_students: String(row.max_students),
      is_active: !!row.is_active,
      data_group: row.data_group || '',
      // 生效方式 + 排程時間（datetime-local 值；若已有排程則預填，方便修改）
      mode: 'immediate',
      scheduled_effective_date: toLocalInput(row.scheduled_effective_date),
      // 唯讀 metadata（日軌）
      created_at: row.created_at,
      updated_at: row.updated_at,
      effective_date: row.effective_date,
      cur_scheduled: row.scheduled_effective_date,
      pending: row.pending_changes || null,
      _live: { label: row.label, base_price: row.base_price, min_students: row.min_students, max_students: row.max_students, is_active: row.is_active, data_group: row.data_group },
    });
    setEditErr('');
  }

  async function handleSaveEdit(e) {
    e.preventDefault();
    setEditErr('');
    // 「拿掉所有驗證」：不再檢查名稱長度/學生人數範圍/大小關係/價格與排程日期；
    // 直接送出，由後端做型別解析與安全預設。
    const patch = {
      label: editing.label,
      base_price: editing.base_price,
      min_students: editing.min_students,
      max_students: editing.max_students,
      is_active: editing.is_active,
      data_group: editing.data_group.trim() || null,
    };
    // 排程：選了「排程生效」且有填時間才送 scheduled_effective_date（datetime-local，台北時區）。
    // 未來時間 → 排程；過去/現在 → 後端視為立即生效。
    const dt = editing.scheduled_effective_date;
    const isFuture = editing.mode === 'scheduled' && !!dt && new Date(dt).getTime() > Date.now();
    if (editing.mode === 'scheduled' && dt) patch.scheduled_effective_date = dt;
    setSaving(editing.course_type);
    try {
      await courseTypesApi.update(editing.course_type, patch);
      toast.success(isFuture ? `已排程於 ${fmtDateTime(dt)} 生效` : '已更新（立即生效）');
      setEditing(null);
      await load();
    } catch (err) {
      setEditErr(err?.response?.data?.error || '更新失敗');
    } finally { setSaving(null); }
  }

  async function cancelSchedule() {
    if (!editing) return;
    setSaving(editing.course_type);
    try {
      await courseTypesApi.update(editing.course_type, { clear_schedule: true });
      toast.success('已取消排程');
      setEditing(null);
      await load();
    } catch (err) {
      toast.error(err?.response?.data?.error || '取消排程失敗');
    } finally { setSaving(null); }
  }

  async function handleDelete(row) {
    if (!window.confirm(`確定刪除「${row.label}」嗎？（有報名記錄的類型無法刪除）`)) return;
    setSaving(row.course_type);
    try {
      await courseTypesApi.remove(row.course_type);
      toast.success(`已刪除「${row.label}」`);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.error || '刪除失敗');
    } finally { setSaving(null); }
  }

  if (!rows) return <LoadingSpinner fullPage />;

  const inputCls = 'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary';

  function closeEdit() { setEditing(null); setEditErr(''); }

  // 行內編輯面板（主色調）。以函式呼叫方式 inline 進 render（非 <Component/>），避免每次輸入時整塊重新掛載而失焦。
  const renderEditPanel = () => (
    <div className="rounded-xl border border-brand-primary/25 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="h-4 w-1 rounded-full bg-brand-primary" />
          <div className="font-semibold text-brand-primary">
            編輯課程需求：{editing._live.label}
            <span className="ml-1 text-xs font-normal text-gray-400">（系統代碼 {editing.course_type}）</span>
          </div>
        </div>
        <button type="button" onClick={closeEdit} className="rounded-md px-2 py-1 text-sm text-gray-400 hover:bg-gray-100 hover:text-gray-700">關閉 ✕</button>
      </div>

      {/* 待生效排程 banner：目前值 vs 即將生效值 */}
      {editing.pending && editing.cur_scheduled && (
        <div className="mb-4 rounded-lg border border-brand-primary/30 bg-brand-primary/5 p-3 text-sm">
          <div className="mb-2 font-semibold text-brand-primary">已排程：{fmtDateTime(editing.cur_scheduled)} 生效</div>
          <table className="w-full text-xs">
            <thead><tr className="text-gray-500"><th className="text-left font-medium">欄位</th><th className="text-left font-medium">目前值</th><th className="text-left font-medium">即將生效值</th></tr></thead>
            <tbody>
              {Object.keys(editing.pending).filter((k) => FIELD_LABELS[k] && String(editing.pending[k]) !== String(editing._live[k])).map((k) => (
                <tr key={k} className="border-t border-gray-100">
                  <td className="py-1 text-gray-600">{FIELD_LABELS[k]}</td>
                  <td className="py-1">{showVal(k, editing._live[k])}</td>
                  <td className="py-1 font-semibold text-brand-primary">{showVal(k, editing.pending[k])}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" onClick={cancelSchedule} disabled={saving === editing.course_type}
            className="mt-2 rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50">取消排程</button>
        </div>
      )}

      <form onSubmit={handleSaveEdit} className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <label className="mb-1 block text-xs font-semibold text-brand-primary">名稱</label>
          <input type="text" value={editing.label} onChange={(e) => setEditing((s) => ({ ...s, label: e.target.value }))} className={inputCls} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-brand-primary">每期價格（每人，NT$）</label>
          <input type="number" step="100" value={editing.base_price} onChange={(e) => setEditing((s) => ({ ...s, base_price: e.target.value }))} className={inputCls} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-brand-primary">狀態</label>
          <select value={editing.is_active ? '1' : '0'} onChange={(e) => setEditing((s) => ({ ...s, is_active: e.target.value === '1' }))} className={inputCls}>
            <option value="1">啟用中</option>
            <option value="0">已停用</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-brand-primary">最少學生</label>
          <input type="number" value={editing.min_students} onChange={(e) => setEditing((s) => ({ ...s, min_students: e.target.value }))} className={inputCls} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-brand-primary">最多學生</label>
          <input type="number" value={editing.max_students} onChange={(e) => setEditing((s) => ({ ...s, max_students: e.target.value }))} className={inputCls} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-brand-primary">資料管理群組</label>
          <input type="text" value={editing.data_group} onChange={(e) => setEditing((s) => ({ ...s, data_group: e.target.value }))} className={inputCls} placeholder="例：新北高中【櫃台】" />
        </div>

        {/* 生效方式 */}
        <div className="col-span-full rounded-lg border border-brand-primary/15 bg-brand-primary/5 p-3">
          <div className="mb-2 text-xs font-semibold text-brand-primary">生效方式</div>
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-1.5">
              <input type="radio" className="accent-brand-primary" checked={editing.mode === 'immediate'} onChange={() => setEditing((s) => ({ ...s, mode: 'immediate' }))} /> 立即生效
            </label>
            <label className="flex items-center gap-1.5">
              <input type="radio" className="accent-brand-primary" checked={editing.mode === 'scheduled'} onChange={() => setEditing((s) => ({ ...s, mode: 'scheduled' }))} /> 排程生效
            </label>
            {editing.mode === 'scheduled' && (
              <input type="datetime-local" value={editing.scheduled_effective_date} onChange={(e) => setEditing((s) => ({ ...s, scheduled_effective_date: e.target.value }))}
                className="rounded-lg border border-gray-300 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-brand-primary" />
            )}
          </div>
          <p className="mt-1.5 text-xs text-gray-400">排程生效：選未來「日期＋時間」，到時間前正式資料不變，時間一到由系統自動套用（每 5 分鐘檢查一次）。選過去／現在的時間＝立即生效。</p>
        </div>

        {/* 資料管理資訊（日軌） */}
        <div className="col-span-full grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border border-gray-100 bg-gray-50 p-3 text-xs text-gray-600 sm:grid-cols-3">
          <div>資料建立日期：<span className="font-medium text-gray-800">{fmtDate(editing.created_at)}</span></div>
          <div>最後更新日期：<span className="font-medium text-gray-800">{fmtDate(editing.updated_at)}</span></div>
          <div>今天日期：<span className="font-medium text-gray-800">{today}</span></div>
          <div>目前生效日：<span className="font-medium text-gray-800">{fmtDate(editing.effective_date)}</span></div>
          <div>排程生效時間：<span className="font-medium text-gray-800">{editing.cur_scheduled ? fmtDateTime(editing.cur_scheduled) : '無排程'}</span></div>
          <div>資料管理群組：<span className="font-medium text-gray-800">{editing._live.data_group || '—'}</span></div>
        </div>

        {editErr && <p className="col-span-full text-sm text-red-600">{editErr}</p>}
        <div className="col-span-full flex gap-2 pt-1">
          <button type="submit" disabled={saving === editing.course_type}
            className="rounded-lg bg-brand-primary px-5 py-2 text-sm font-semibold text-white shadow-sm hover:opacity-90 disabled:opacity-50">
            {saving === editing.course_type ? '儲存中…' : (editing.mode === 'scheduled' ? '排程儲存' : '立即儲存')}
          </button>
          <button type="button" onClick={closeEdit} className="rounded-lg border border-gray-300 px-5 py-2 text-sm hover:bg-gray-50">取消</button>
        </div>
      </form>
    </div>
  );

  return (
    <div>
      <PageHeader
        title="課程需求管理"
        subtitle="F-A07 · 各品相的師生比與「每期價格（每人）」唯一來源（停用後 LIFF 報名頁不再顯示）"
        actions={
          <button
            onClick={() => { setShowAdd(true); setAddErr(''); }}
            className="rounded-lg bg-brand-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90"
          >
            + 新增課程需求
          </button>
        }
      />

      {showAdd && (
        <div className="mb-6 rounded-xl border border-blue-200 bg-blue-50 p-5">
          <div className="mb-3 font-semibold text-blue-800">新增課程需求</div>
          <form onSubmit={handleAdd} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">課程編號（正整數）</label>
              <input type="number" value={form.course_type}
                onChange={(e) => { const ct = e.target.value; setForm((f) => ({ ...f, course_type: ct, label: f.label || autoLabel(parseInt(ct, 10)), max_students: f.max_students || ct })); }}
                className={inputCls} placeholder="例：4" required />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">名稱（顯示用）</label>
              <input type="text" value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} className={inputCls} placeholder="例：一對四" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">每期價格（每人，NT$）</label>
              <input type="number" step="100" value={form.base_price} onChange={(e) => setForm((f) => ({ ...f, base_price: e.target.value }))} className={inputCls} placeholder="例：9000" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">最少學生人數</label>
              <input type="number" value={form.min_students} onChange={(e) => setForm((f) => ({ ...f, min_students: e.target.value }))} className={inputCls} placeholder="例：2" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">最多學生人數</label>
              <input type="number" value={form.max_students} onChange={(e) => setForm((f) => ({ ...f, max_students: e.target.value }))} className={inputCls} placeholder="例：4" />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">資料管理群組（選填）</label>
              <input type="text" value={form.data_group} onChange={(e) => setForm((f) => ({ ...f, data_group: e.target.value }))} className={inputCls} placeholder="例：新北高中【櫃台】" />
            </div>
            {addErr && <p className="col-span-full text-sm text-red-600">{addErr}</p>}
            <div className="col-span-full flex gap-2">
              <button type="submit" className="rounded-lg bg-brand-primary px-5 py-2 text-sm font-semibold text-white hover:opacity-90">新增</button>
              <button type="button" onClick={() => { setShowAdd(false); setForm({ course_type: '', label: '', min_students: '', max_students: '', base_price: '', data_group: '' }); setAddErr(''); }}
                className="rounded-lg border border-gray-300 px-5 py-2 text-sm hover:bg-gray-50">取消</button>
            </div>
          </form>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-semibold text-gray-600">課程需求</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-600">每期價格</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-600">最少</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-600">最多</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-600">系統代碼</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-600">狀態</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-600">排程</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-600">建立 / 更新</th>
              <th className="px-4 py-3 text-right font-semibold text-gray-600">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 && (
              <tr><td colSpan={9} className="py-12 text-center text-gray-400">尚無課程需求設定</td></tr>
            )}
            {rows.map((row) => {
              const isEditing = editing?.course_type === row.course_type;
              return (
                <React.Fragment key={row.course_type}>
                  <tr className={`transition ${isEditing ? 'bg-brand-primary/5' : 'hover:bg-gray-50'} ${!row.is_active && !isEditing ? 'opacity-50' : ''}`}>
                    <td className="px-4 py-4 font-semibold text-gray-800">{row.label}</td>
                    <td className="px-4 py-4 font-medium text-gray-800">{fmtMoney(row.base_price)}</td>
                    <td className="px-4 py-4 text-gray-600">{row.min_students ?? 1} 人</td>
                    <td className="px-4 py-4 text-gray-600">{row.max_students} 人</td>
                    <td className="px-4 py-4"><span className="rounded bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-500">{row.course_type}</span></td>
                    <td className="px-4 py-4">
                      {row.is_active
                        ? <span className="rounded-full bg-green-100 px-3 py-1 text-xs font-semibold text-green-700">啟用中</span>
                        : <span className="rounded-full bg-gray-200 px-3 py-1 text-xs font-semibold text-gray-500">已停用</span>}
                    </td>
                    <td className="px-4 py-4 text-xs">
                      {row.scheduled_effective_date
                        ? <span className="rounded-full bg-amber-100 px-2 py-1 font-medium text-amber-700">{fmtDateTime(row.scheduled_effective_date)} 生效</span>
                        : <span className="text-gray-400">無排程</span>}
                    </td>
                    <td className="px-4 py-4 text-xs text-gray-500">{fmtDate(row.created_at)}<br />{fmtDate(row.updated_at)}</td>
                    <td className="px-4 py-4 text-right">
                      <div className="flex justify-end gap-2">
                        <button onClick={() => (isEditing ? closeEdit() : startEdit(row))} disabled={saving === row.course_type}
                          className={`rounded-lg border px-3 py-1.5 text-xs font-medium disabled:opacity-50 ${isEditing ? 'border-brand-primary bg-brand-primary text-white hover:opacity-90' : 'border-gray-300 hover:bg-gray-50'}`}>
                          {isEditing ? '收合' : '編輯'}
                        </button>
                        <button onClick={() => toggleActive(row)} disabled={saving === row.course_type || isEditing}
                          className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium hover:bg-gray-50 disabled:opacity-50">
                          {saving === row.course_type ? '…' : row.is_active ? '停用' : '啟用'}
                        </button>
                        <button onClick={() => handleDelete(row)} disabled={saving === row.course_type || isEditing}
                          className="rounded-lg border border-red-200 px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50">刪除</button>
                      </div>
                    </td>
                  </tr>
                  {isEditing && (
                    <tr className="bg-brand-primary/5">
                      <td colSpan={9} className="px-4 pb-5 pt-1">
                        {renderEditPanel()}
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-4 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-700">
        提示：每期價格（每人）以本頁為唯一來源，課程介紹維護頁僅能讀取。已有報名記錄的課程需求無法刪除，請改為「停用」（停用後 LIFF 報名流程不再顯示）。
      </div>
    </div>
  );
}
