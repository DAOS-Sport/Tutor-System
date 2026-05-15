import React, { useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { ragicStagingApi } from '../api/ragicStaging';

const STATUS_LABEL = {
  pending:       { text: '待審核', cls: 'bg-amber-100 text-amber-800' },
  approved:      { text: '已通過', cls: 'bg-brand-green/15 text-brand-green' },
  rejected:      { text: '已退回', cls: 'bg-red-100 text-red-700' },
  auto_resolved: { text: '已自動解除', cls: 'bg-gray-200 text-gray-600' },
};
const CHANGE_LABEL = {
  new:        { text: '新增',   cls: 'bg-brand-teal/15 text-brand-teal' },
  update:     { text: '更新',   cls: 'bg-blue-100 text-blue-700' },
  deactivate: { text: '停用',   cls: 'bg-red-50 text-red-700' },
};
const FORM_LABEL = {
  H01_STAFF:   '員工',
  H01_COACHES: '教練',
  H05_VENUES:  '場館',
};

function fmtDate(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString('zh-TW', { hour12: false }); } catch { return ts; }
}

function DiffTable({ diff, payload, changeType }) {
  if (changeType === 'new') {
    const entries = Object.entries(payload || {}).filter(([k]) => !['id', 'code', 'ragic_employee_id'].includes(k));
    return (
      <div className="rounded bg-gray-50 p-2 text-xs">
        <div className="mb-1 font-bold text-gray-700">新增資料</div>
        {entries.map(([k, v]) => (
          <div key={k} className="flex gap-2"><span className="text-gray-500">{k}:</span><span className="text-gray-800">{String(v)}</span></div>
        ))}
      </div>
    );
  }
  if (!diff || Object.keys(diff).length === 0) {
    return <div className="text-xs text-gray-500">（無欄位差異）</div>;
  }
  return (
    <table className="w-full text-xs">
      <thead><tr className="text-left text-gray-500"><th className="py-0.5">欄位</th><th>原值</th><th>新值</th></tr></thead>
      <tbody>
        {Object.entries(diff).map(([f, v]) => (
          <tr key={f}>
            <td className="py-0.5 pr-2 font-mono text-gray-600">{f}</td>
            <td className="pr-2 text-gray-500 line-through">{String(v.from ?? '')}</td>
            <td className="text-brand-primary font-bold">{String(v.to ?? '')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StagingCard({ row, busy, onApprove, onReject, selected, onToggle }) {
  const st = STATUS_LABEL[row.status] || STATUS_LABEL.pending;
  const ct = CHANGE_LABEL[row.change_type] || { text: row.change_type, cls: 'bg-gray-100 text-gray-600' };
  const formText = FORM_LABEL[row.form_code] || row.form_code;
  const entityName = row.payload_json?.name || row.entity_id;
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2">
          {row.status === 'pending' ? (
            <input type="checkbox" className="mt-1" checked={selected} onChange={onToggle} />
          ) : null}
          <div>
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${ct.cls}`}>{ct.text}</span>
              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[11px] text-gray-600">{formText}</span>
              <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${st.cls}`}>{st.text}</span>
            </div>
            <div className="mt-1 text-sm font-bold text-gray-800">{entityName}</div>
            <div className="text-[11px] text-gray-500">ID: <span className="font-mono">{row.entity_id}</span> ・ 抓取於 {fmtDate(row.fetched_at)}</div>
          </div>
        </div>
      </div>
      <div className="mt-2">
        <DiffTable diff={row.diff_json} payload={row.payload_json} changeType={row.change_type} />
      </div>
      {row.status === 'rejected' && row.reject_reason ? (
        <div className="mt-2 rounded bg-red-50 px-2 py-1 text-xs text-red-700">退回原因：{row.reject_reason}</div>
      ) : null}
      {(row.status === 'approved' || row.status === 'rejected') && row.reviewer_name ? (
        <div className="mt-1 text-[11px] text-gray-500">{row.reviewer_name} 於 {fmtDate(row.reviewed_at)} 處理</div>
      ) : null}
      {row.status === 'pending' ? (
        <div className="mt-3 flex justify-end gap-2">
          <button
            disabled={busy}
            onClick={() => onReject(row)}
            className="rounded border border-gray-300 px-3 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >退回</button>
          <button
            disabled={busy}
            onClick={() => onApprove(row.id)}
            className="rounded bg-brand-primary px-3 py-1 text-xs font-bold text-white hover:bg-brand-teal disabled:opacity-50"
          >通過並套用</button>
        </div>
      ) : null}
    </div>
  );
}

export default function RagicStagingPage() {
  const toast = useToast();
  const [items, setItems] = useState(null);
  const [filterStatus, setFilterStatus] = useState('pending');
  const [filterForm, setFilterForm] = useState('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(new Set());

  async function load() {
    setItems(null);
    try {
      const r = await ragicStagingApi.list({ status: filterStatus, form: filterForm || undefined, search: search || undefined });
      setItems(r.items || []);
      setSelected(new Set());
    } catch (e) {
      toast.error(e?.response?.data?.error || '載入失敗');
      setItems([]);
    }
  }
  useEffect(() => { load(); }, [filterStatus, filterForm]); // eslint-disable-line

  async function approve(id) {
    setBusy(true);
    try {
      await ragicStagingApi.approve(id);
      toast.success('已通過並套用至正式表');
      load();
    } catch (e) { toast.error(e?.response?.data?.error || '通過失敗'); }
    finally { setBusy(false); }
  }
  async function reject(row) {
    const reason = window.prompt(`退回 ${row.payload_json?.name || row.entity_id}，請輸入原因：`);
    if (!reason || !reason.trim()) return;
    setBusy(true);
    try {
      await ragicStagingApi.reject(row.id, reason.trim());
      toast.success('已退回');
      load();
    } catch (e) { toast.error(e?.response?.data?.error || '退回失敗'); }
    finally { setBusy(false); }
  }
  async function bulkApprove() {
    const ids = Array.from(selected);
    if (!ids.length) { toast.warning('請先勾選'); return; }
    if (!window.confirm(`一次通過 ${ids.length} 筆？`)) return;
    setBusy(true);
    try {
      const r = await ragicStagingApi.bulkApprove(ids);
      const okN = (r.approved || []).length;
      const failN = (r.failed || []).length;
      if (failN === 0) toast.success(`已通過 ${okN} 筆`);
      else toast.warning(`已通過 ${okN} 筆，失敗 ${failN} 筆`);
      load();
    } catch (e) { toast.error(e?.response?.data?.error || '批次通過失敗'); }
    finally { setBusy(false); }
  }
  function toggleAll() {
    if (!items) return;
    const pendingIds = items.filter(r => r.status === 'pending').map(r => r.id);
    if (selected.size === pendingIds.length) setSelected(new Set());
    else setSelected(new Set(pendingIds));
  }
  function toggleOne(id) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  }

  const pendingCount = useMemo(() => (items || []).filter(r => r.status === 'pending').length, [items]);

  return (
    <div>
      <PageHeader
        title="Ragic 待審核"
        description="Ragic 同步抓回的差異會先進入此區，由管理員人工審核後才寫入正式表。退回的內容若 Ragic 端仍有差異，下次同步會重新進入待審區。"
        actions={
          filterStatus === 'pending' && pendingCount > 0 ? (
            <button
              type="button"
              disabled={busy || selected.size === 0}
              onClick={bulkApprove}
              className="rounded bg-brand-primary px-4 py-2 text-sm font-bold text-white shadow-sm transition hover:bg-brand-teal disabled:opacity-50"
            >批次通過 ({selected.size})</button>
          ) : null
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {['pending', 'approved', 'rejected', 'auto_resolved', 'all'].map(s => (
          <button
            key={s}
            onClick={() => setFilterStatus(s)}
            className={`rounded px-3 py-1 text-xs font-bold ${filterStatus === s ? 'bg-brand-primary text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
          >{s === 'all' ? '全部' : (STATUS_LABEL[s]?.text || s)}</button>
        ))}
        <span className="mx-2 h-5 w-px bg-gray-300" />
        <select
          value={filterForm}
          onChange={(e) => setFilterForm(e.target.value)}
          className="rounded border border-gray-300 bg-white px-2 py-1 text-xs"
        >
          <option value="">所有來源</option>
          <option value="H01_STAFF">H01 員工</option>
          <option value="H01_COACHES">H01 教練</option>
          <option value="H05_VENUES">H05 場館</option>
        </select>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') load(); }}
          placeholder="搜尋 ID / 內容…"
          className="w-40 rounded border border-gray-300 px-2 py-1 text-xs"
        />
        <button onClick={load} className="rounded border border-gray-300 px-3 py-1 text-xs hover:bg-gray-50">搜尋</button>
        {filterStatus === 'pending' && items && pendingCount > 0 ? (
          <button onClick={toggleAll} className="rounded border border-gray-300 px-3 py-1 text-xs hover:bg-gray-50">
            {selected.size === pendingCount ? '取消全選' : '全選 pending'}
          </button>
        ) : null}
      </div>

      {items === null ? (
        <LoadingSpinner />
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-8 text-center text-sm text-gray-500">
          目前沒有資料。
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {items.map(row => (
            <StagingCard
              key={row.id}
              row={row}
              busy={busy}
              selected={selected.has(row.id)}
              onToggle={() => toggleOne(row.id)}
              onApprove={approve}
              onReject={reject}
            />
          ))}
        </div>
      )}

      <div className="mt-6 rounded-lg bg-gray-50 p-4 text-xs text-gray-600">
        <div className="font-bold text-gray-700">說明</div>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          <li>同步只會寫入差異；同 entity 已有 pending 時，新差異直接覆蓋舊的 pending row。</li>
          <li>退回（rejected）後，下次 Ragic 同步若仍有差異，<span className="font-bold">會</span>重新進入待審區（依 spec）。如要永久忽略，請於 Ragic 端把資料調整為與系統一致。</li>
          <li>通過時仍尊重各欄位的 *_overridden_at 保護（後台手動編輯過的不會被覆蓋）。</li>
          <li>系統內部欄位（multiplier / is_senior / role / line_token / 銀行帳戶）永不從 Ragic 同步。</li>
        </ul>
      </div>
    </div>
  );
}
