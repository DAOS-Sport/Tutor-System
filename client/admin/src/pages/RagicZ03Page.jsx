import React, { useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import ConfirmDialog from '../components/ConfirmDialog';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { ragicZ03Api } from '../api/ragicZ03';

// Task #70 邊緣案例處理準則（同 RagicStagingPage）：
// skipAuthRedirect=true，401 由頁面自己判斷是否登出，其餘錯誤顯示 toast + 重試。
//
// 卡片版面沿用舊版設計（橘色家長資訊 header / 藍色學員資料 mini-table / 卡片底部快速動作），
// 預設全部唯讀；只有按下「編輯」才會把家長欄位切成輸入框，交給 PATCH /ragic-z03/:id/draft
// 儲存（完整時後端會寫回 Ragic；LINE UID 由家長登入流程自動綁定）。

const STATUS_LABEL = {
  pending:   { text: '待處理', cls: 'bg-amber-100 text-amber-800' },
  resolved:  { text: '已修正', cls: 'bg-brand-green/15 text-brand-green' },
  manual_review: { text: '人工審核', cls: 'bg-red-100 text-red-700' },
  dismissed: { text: '已忽略', cls: 'bg-gray-200 text-gray-600' },
};

// 讀模式顯示的家長欄位（比照舊版卡片：2 欄排版，住家地址獨佔一整列）
const PARENT_VIEW_FIELDS = [
  ['phone', '電話'],
  ['venue_raw', '館別'],
  ['identity_raw', '身分'],
  ['gender_raw', '性別'],
  ['email_raw', 'Email'],
  ['home_phone_raw', '住家電話'],
  ['home_address_raw', '住家地址', true],
  ['line_id_raw', 'LINE ID'],
  ['line_uid_raw', '家教系統uid'],
];

// 編輯模式可寫入的家長欄位 —— 對應後端 Z03_RECORD_UPDATE_FIELDS
// （server/services/ragicAdmin.js 的 saveZ03RecordDraft）。LINE UID 由家長登入時自動綁定，
// 櫃台不可在 Z03 手填；住家電話/LINE ID/學生數/住家地址/LINE 對話網址也不做人工回填。
// [field, label, fullWidth, required]
const PARENT_EDIT_FIELDS = [
  ['raw_name',       '家長姓名',               false, true],
  ['phone',          '電話',                   false, true],
  ['venue_raw',      '館別',                   false, true],
  ['identity_raw',   '身分',                   false, true],
  ['gender_raw',     '性別',                   false, true],
  ['email_raw',      'Email',                  false, true],
];

const PARENT_READONLY_EDIT_FIELDS = [
  ['line_uid_raw', '家教系統uid（LINE UID）', '由家長登入時自動寫入，櫃台不可手動填寫'],
];

const STUDENT_EDIT_FIELDS = [
  ['seq_raw', '項次'],
  ['student_status_raw', '學員身分'],
  ['name_raw', '學生姓名'],
  ['birth_date_raw', '出生年月日'],
  ['gender_raw', '性別'],
  ['id_number_raw', '身分證字號'],
  ['blood_type_raw', '血型'],
  ['age_raw', '歲數'],
  ['student_code_raw', '學員編號'],
  ['registered_phone_raw', '登記電話'],
];

// 後端 GET /ragic-z03 目前不支援 limit/offset（見 server/services/ragicAdmin.js
// listZ03Records），一次會回傳整批符合篩選條件的資料（可能上千筆）。這裡改用前端
// 分頁視窗（load more）避免一次把上千張卡片塞進 DOM，而不動後端 API。
const PAGE_SIZE = 30;

function text(v) {
  return v == null ? '' : String(v);
}

function fmtDate(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString('zh-TW', { hour12: false }); } catch { return ts; }
}

function rowToDraft(row) {
  const record = {};
  PARENT_EDIT_FIELDS.forEach(([field]) => { record[field] = text(row[field]); });
  return {
    record,
    students: (row.students || []).map((s) => {
      const out = { id: s.id };
      STUDENT_EDIT_FIELDS.forEach(([field]) => { out[field] = text(s[field]); });
      return out;
    }),
  };
}

function missingText(missing) {
  return (missing || []).map((m) => m.label || m.key).filter(Boolean).join('、');
}

function FieldInput({ value, onChange, placeholder = '', className = '' }) {
  return (
    <input
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`h-8 w-full min-w-0 rounded border border-gray-300 bg-white px-2 text-xs font-normal text-gray-800 outline-none focus:border-brand-teal focus:ring-1 focus:ring-brand-teal ${className}`}
    />
  );
}

function ReadonlyField({ label, value, hint }) {
  return (
    <label className="block min-w-0 text-[11px] font-bold text-gray-500">
      {label}
      <input
        value={value || ''}
        readOnly
        placeholder="登入後自動更新"
        className="mt-0.5 h-8 w-full min-w-0 rounded border border-gray-200 bg-gray-100 px-2 text-xs font-normal text-gray-500 outline-none"
      />
      {hint ? <span className="mt-0.5 block text-[10px] font-normal leading-4 text-gray-400">{hint}</span> : null}
    </label>
  );
}

// 學員編輯表格欄位較多，容器加 overflow-x-auto + min-w，寧可讓表格本身橫向捲動
// 也不要撐爆卡片（防破版需求）。
function StudentEditTable({ students, onChange }) {
  if (!students.length) {
    return (
      <div className="rounded border border-dashed border-gray-300 bg-gray-50 p-2 text-[11px] text-gray-500">
        沒有學員資料
      </div>
    );
  }
  return (
    <div className="max-w-full min-w-0 overflow-x-auto rounded border border-blue-100">
      <table className="w-full min-w-[760px] border-collapse text-[11px]">
        <thead>
          <tr className="bg-blue-50 text-left font-bold text-blue-900">
            {STUDENT_EDIT_FIELDS.map(([field, label]) => (
              <th key={field} className="border border-blue-100 px-1.5 py-1">{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {students.map((student, index) => (
            <tr key={student.id || index} className="bg-white">
              {STUDENT_EDIT_FIELDS.map(([field]) => (
                <td key={field} className="border border-blue-100 p-1 align-top">
                  <FieldInput value={student[field]} onChange={(v) => onChange(index, field, v)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Z03Card({ row, busyKey, onResolve, onDismiss, onSaveDraft, onDeleteRequest }) {
  const st = STATUS_LABEL[row.status] || STATUS_LABEL.pending;
  const [fixedName, setFixedName] = useState('');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => rowToDraft(row));
  const isPending = row.status === 'pending';

  const busy = Boolean(busyKey);
  const resolving = busyKey === `resolve:${row.id}`;
  const dismissing = busyKey === `dismiss:${row.id}`;
  const saving = busyKey === `save:${row.id}`;

  function startEdit() {
    setDraft(rowToDraft(row));
    setEditing(true);
  }
  function cancelEdit() {
    setDraft(rowToDraft(row));
    setEditing(false);
  }
  function updateRecord(field, value) {
    setDraft((prev) => ({ ...prev, record: { ...prev.record, [field]: value } }));
  }
  function updateStudent(index, field, value) {
    setDraft((prev) => ({
      ...prev,
      students: prev.students.map((s, i) => (i === index ? { ...s, [field]: value } : s)),
    }));
  }
  async function handleSave() {
    const ok = await onSaveDraft(row.id, draft);
    if (ok) setEditing(false);
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
      <div className="flex items-start justify-between gap-2 border-b border-gray-100 bg-orange-50 px-3 py-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${st.cls}`}>{st.text}</span>
            <span className="text-[11px] text-gray-500">z01_ragic_record_id: <span className="font-mono">{row.z01_ragic_record_id}</span></span>
          </div>
          <div className="mt-1 truncate text-sm font-bold text-red-600">「{row.raw_name || '（空白）'}」</div>
          <div className="text-[11px] text-gray-500">抓取於 {fmtDate(row.fetched_at)}</div>
          <div className="text-[11px] text-gray-500">來源更新 {fmtDate(row.source_updated_at)} ・ {row.reason_code || '—'} ・ {row.claim_state || 'UNRESOLVED'}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => (editing ? cancelEdit() : startEdit())}
            className="whitespace-nowrap rounded border border-gray-300 bg-white px-2 py-1 text-[11px] font-bold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >{editing ? '取消編輯' : '編輯'}</button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onDeleteRequest(row)}
            className="whitespace-nowrap rounded border border-red-300 bg-white px-2 py-1 text-[11px] font-bold text-red-600 hover:bg-red-50 disabled:opacity-50"
          >轉人工審核</button>
        </div>
      </div>

      {editing ? (
        <div className="grid min-w-0 grid-cols-1 gap-2 px-3 py-2 text-xs sm:grid-cols-2">
          {PARENT_EDIT_FIELDS.map(([field, label, full, required]) => (
            <label key={field} className={`block min-w-0 text-[11px] font-bold text-gray-600 ${full ? 'sm:col-span-2' : ''}`}>
              {label}{required && <span className="ml-0.5 text-red-500">*</span>}
              <FieldInput value={draft.record[field]} onChange={(v) => updateRecord(field, v)} className="mt-0.5" />
            </label>
          ))}
          {PARENT_READONLY_EDIT_FIELDS.map(([field, label, hint]) => (
            <ReadonlyField key={field} label={label} value={row[field]} hint={hint} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 px-3 py-2 text-xs">
          {PARENT_VIEW_FIELDS.map(([field, label, full]) => (
            <div key={field} className={`min-w-0 break-all ${full ? 'col-span-2' : ''}`}>
              <span className="text-gray-500">{label}：</span>
              {row[field] || (field === 'line_uid_raw' ? '（尚未登入）' : '—')}
            </div>
          ))}
        </div>
      )}

      {editing ? (
        <div className="min-w-0 border-t border-gray-100 bg-blue-50 px-3 py-2">
          <div className="mb-1 text-[11px] font-bold text-blue-800">學員資料（{draft.students.length} 位，可編輯）</div>
          <StudentEditTable students={draft.students} onChange={updateStudent} />
        </div>
      ) : row.students && row.students.length > 0 ? (
        <div className="min-w-0 border-t border-gray-100 bg-blue-50 px-3 py-2">
          <div className="mb-1 text-[11px] font-bold text-blue-800">學員資料（{row.students.length} 位，原始值）</div>
          <div className="max-w-full overflow-x-auto">
            <table className="w-full min-w-[520px] text-[11px]">
              <thead>
                <tr className="text-left text-gray-500">
                  <th className="pr-2">姓名</th><th className="pr-2">學員身分</th><th className="pr-2">出生年月日</th>
                  <th className="pr-2">性別</th><th className="pr-2">身分證字號</th><th className="pr-2">血型</th><th>登記電話</th>
                </tr>
              </thead>
              <tbody>
                {row.students.map((s) => (
                  <tr key={s.id}>
                    <td className="pr-2 text-sm font-bold text-gray-800">{s.name_raw || '—'}</td>
                    <td className="pr-2">{s.student_status_raw || '—'}</td>
                    <td className="pr-2">{s.birth_date_raw || '—'}</td>
                    <td className="pr-2">{s.gender_raw || '—'}</td>
                    <td className="pr-2">{s.id_number_raw || '—'}</td>
                    <td className="pr-2">{s.blood_type_raw || '—'}</td>
                    <td>{s.registered_phone_raw || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {editing ? (
        <div className="mt-auto border-t border-gray-100">
          {isPending ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-gray-100 bg-gray-50 px-3 py-2">
              <span className="w-full text-[11px] font-bold text-gray-600">只修正姓名（不動其他欄位）：</span>
              <input
                value={fixedName}
                onChange={(e) => setFixedName(e.target.value)}
                placeholder="輸入正確姓名"
                className="h-8 min-w-[120px] flex-1 rounded border border-gray-300 px-2 text-xs outline-none focus:border-brand-teal focus:ring-1 focus:ring-brand-teal"
              />
              <button
                type="button"
                disabled={busy || !fixedName.trim()}
                onClick={() => onResolve(row.id, fixedName.trim())}
                className="whitespace-nowrap rounded bg-brand-primary px-3 py-1 text-xs font-bold text-white hover:bg-brand-teal disabled:opacity-50"
              >{resolving ? '處理中…' : '確認修正並寫回 Ragic'}</button>
            </div>
          ) : null}
          <div className="flex flex-wrap items-center justify-end gap-2 px-3 py-2">
            <button
              type="button"
              disabled={busy}
              onClick={cancelEdit}
              className="whitespace-nowrap rounded border border-gray-300 px-3 py-1 text-xs font-bold text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >取消</button>
            <button
              type="button"
              disabled={busy}
              onClick={handleSave}
              className="whitespace-nowrap rounded bg-brand-primary px-3 py-1 text-xs font-bold text-white hover:bg-brand-teal disabled:opacity-50"
            >{saving ? '儲存中…' : '儲存'}</button>
          </div>
        </div>
      ) : isPending ? (
        <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 px-3 py-2">
          <span className="text-[11px] text-gray-500">點右上「編輯」修正姓名或補齊資料</span>
          <button
            type="button"
            disabled={busy}
            onClick={() => onDismiss(row.id)}
            className="whitespace-nowrap rounded border border-gray-300 px-3 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >{dismissing ? '處理中…' : '忽略（誤判）'}</button>
        </div>
      ) : (
        <div className="mt-auto border-t border-gray-100 px-3 py-2 text-[11px] text-gray-500">
          {row.status === 'resolved' ? `已改為「${row.fixed_name}」` : '已標記為誤判，不會寫回 Ragic'}
          {row.resolved_at ? ` ・ ${fmtDate(row.resolved_at)}` : ''}
        </div>
      )}
    </div>
  );
}

function LoadError({ onRetry }) {
  return (
    <div className="rounded-lg border border-dashed border-red-200 bg-red-50 p-8 text-center">
      <div className="text-sm font-bold text-red-700">無法取得 Z03 列表</div>
      <div className="mt-1 text-xs text-red-500">後端暫時無法回應，請稍後重試。</div>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 rounded bg-brand-primary px-4 py-1.5 text-xs font-bold text-white hover:bg-brand-teal"
      >重新載入</button>
    </div>
  );
}

export default function RagicZ03Page() {
  const toast = useToast();
  const { logout } = useAuth();
  const [items, setItems] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [status, setStatus] = useState('pending');
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [stats, setStats] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null); // Z03 row 待確認轉人工審核
  const [deleteBusy, setDeleteBusy] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(queryInput.trim()), 300);
    return () => clearTimeout(timer);
  }, [queryInput]);

  async function loadStats() {
    try {
      const s = await ragicZ03Api.stats();
      setStats(s);
    } catch {
      // stats 失敗不影響主要功能，靜默忽略
    }
  }

  async function load() {
    setItems(null);
    setLoadError(false);
    setVisibleCount(PAGE_SIZE);
    try {
      const r = await ragicZ03Api.list(status, query);
      setItems(r.items || []);
    } catch (e) {
      if (e?.response?.status === 401) {
        toast.error('登入逾期，請重新登入');
        logout();
        return;
      }
      const msg = e?.response?.data?.error || e?.message || '載入失敗';
      toast.error(`Z03 人工整理表：${msg}`);
      setLoadError(true);
    }
  }
  useEffect(() => { loadStats(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [status, query]); // eslint-disable-line react-hooks/exhaustive-deps

  // 只用來局部更新單筆卡片（儲存全欄位編輯後「refresh that record」），不影響其他
  // 已載入卡片或分頁視窗；resolve() / dismiss() 走的是舊版流程，會整批重新載入。
  function replaceItem(item) {
    if (!item) return;
    setItems((prev) => (prev || []).map((row) => (
      row.id === item.id
        ? { ...row, ...item, students: item.students !== undefined ? item.students : row.students }
        : row
    )));
  }

  async function resolve(id, fixedName) {
    setBusyKey(`resolve:${id}`);
    try {
      await ragicZ03Api.resolve(id, fixedName);
      toast.success('已寫回 Ragic，下次凌晨 01:00 同步後會自動出現在客戶資料裡');
      await Promise.all([load(), loadStats()]);
    } catch (e) {
      toast.error(e?.response?.data?.error || '修正失敗');
    } finally {
      setBusyKey('');
    }
  }

  async function dismiss(id) {
    if (!window.confirm('確定要忽略這筆嗎？（判定為誤判，不會寫回 Ragic）')) return;
    setBusyKey(`dismiss:${id}`);
    try {
      await ragicZ03Api.dismiss(id);
      toast.success('已忽略');
      await Promise.all([load(), loadStats()]);
    } catch (e) {
      toast.error(e?.response?.data?.error || '忽略失敗');
    } finally {
      setBusyKey('');
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleteBusy(true);
    try {
      await ragicZ03Api.remove(pendingDelete.id);
      toast.success('已保留來源資料並轉入人工審核');
      setPendingDelete(null);
      await Promise.all([load(), loadStats()]);
    } catch (e) {
      toast.error(e?.response?.data?.error || '刪除失敗');
    } finally {
      setDeleteBusy(false);
    }
  }

  async function saveDraft(id, draft) {
    setBusyKey(`save:${id}`);
    try {
      const result = await ragicZ03Api.saveDraft(id, draft);
      replaceItem(result.item);
      if (result.upgraded) {
        toast.success('已儲存、寫回 Ragic 並同步正式客戶資料');
      } else if (result.synced_to_ragic) {
        toast.success('已儲存並寫回 Ragic；LINE UID 會在家長登入時自動綁定');
      } else if (result.skipped === 'dismissed') {
        toast.info('已儲存；已忽略資料不會寫回 Ragic');
      } else {
        const missing = missingText(result.missing);
        toast.info(missing ? `已儲存，尚缺：${missing}` : '已儲存');
      }
      return true;
    } catch (e) {
      if (e?.response?.data?.saved && e.response.data.item) {
        replaceItem(e.response.data.item);
      }
      toast.error(e?.response?.data?.error || '儲存失敗');
      return false;
    } finally {
      setBusyKey('');
    }
  }

  const rows = useMemo(() => (Array.isArray(items) ? items : []), [items]);
  const visibleRows = useMemo(() => rows.slice(0, visibleCount), [rows, visibleCount]);
  const hasMore = visibleCount < rows.length;

  return (
    <div>
      <PageHeader
        title="Z03 未開通資料整理"
        subtitle="Ragic Z01 裡「尚未綁定 LINE UID」或資料待整理的家長會暫存於此。櫃台只修正必要欄位；LINE UID 由家長登入時自動綁定。"
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {['pending', 'resolved', 'manual_review', 'all'].map((s) => {
          const cnt = stats ? (s === 'all' ? stats.total : stats[s]) : null;
          return (
          <button
            key={s}
            type="button"
            onClick={() => setStatus(s)}
            className={`rounded px-3 py-1 text-xs font-bold ${status === s ? 'bg-brand-primary text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
          >
            {s === 'all' ? '全部' : STATUS_LABEL[s]?.text}
            {cnt != null ? <span className={`ml-1 rounded-full px-1.5 py-0.5 text-[10px] ${status === s ? 'bg-white/20' : 'bg-gray-300 text-gray-600'}`}>{cnt}</span> : null}
          </button>
          );
        })}
        <div className="ml-auto flex min-w-[200px] flex-1 items-center gap-2 sm:max-w-xs">
          <input
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            placeholder="搜尋 record ID、家長/學生姓名、電話或 claim ID"
            className="h-8 w-full min-w-0 rounded border border-gray-300 bg-white px-3 text-xs outline-none focus:border-brand-teal focus:ring-1 focus:ring-brand-teal"
          />
          {queryInput ? (
            <button
              type="button"
              onClick={() => setQueryInput('')}
              className="h-8 whitespace-nowrap rounded border border-gray-300 px-2 text-xs font-bold text-gray-700 hover:bg-gray-50"
            >清除</button>
          ) : null}
        </div>
      </div>

      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500">
        <span>共 {rows.length} 筆{hasMore ? `，目前顯示 ${visibleRows.length} 筆` : ''}</span>
        <button
          type="button"
          onClick={load}
          className="rounded border border-gray-300 px-2 py-1 font-bold text-gray-700 hover:bg-gray-50"
        >重新整理</button>
      </div>

      {items === null && !loadError ? (
        <LoadingSpinner />
      ) : loadError ? (
        <LoadError onRetry={load} />
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-8 text-center text-sm text-gray-500">
          目前沒有資料。
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {visibleRows.map((row) => (
              <Z03Card
                key={row.id}
                row={row}
                busyKey={busyKey}
                onResolve={resolve}
                onDismiss={dismiss}
                onSaveDraft={saveDraft}
                onDeleteRequest={setPendingDelete}
              />
            ))}
          </div>
          {hasMore ? (
            <div className="mt-4 flex justify-center">
              <button
                type="button"
                onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
                className="rounded border border-gray-300 bg-white px-4 py-1.5 text-xs font-bold text-gray-700 hover:bg-gray-50"
              >載入更多（剩 {rows.length - visibleRows.length} 筆）</button>
            </div>
          ) : null}
        </>
      )}

      <div className="mt-6 rounded-lg bg-gray-50 p-4 text-xs text-gray-600">
        <div className="font-bold text-gray-700">說明</div>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          <li>這裡的家長<span className="font-bold">尚未綁定 LINE UID</span>，不會出現在「客戶資料管理」，也不影響任何現有使用者。</li>
          <li>標有 <span className="font-bold text-red-500">*</span> 的欄位為人工整理必填（家長姓名、電話、館別、身分、性別、Email）。LINE UID 不由櫃台填寫。</li>
          <li>卡片預設唯讀；點右上「編輯」後才會出現輸入框。</li>
          <li>「確認修正並寫回 Ragic」只更動 Ragic 該筆的姓名欄位；適合只有姓名錯誤、其他資料都正確的情況。</li>
          <li>資料補齊後按「儲存」會寫回 Ragic；住家電話、LINE ID、學生數、住家地址、LINE 對話網址不由此頁回填。</li>
          <li>家長完成登入綁定後，系統會自動寫入 LINE UID 並同步到正式客戶資料；每日凌晨 01:30 全量同步會再次依此規則分流。</li>
        </ul>
      </div>

      <ConfirmDialog
        open={!!pendingDelete}
        title="將這筆 Z03 資料轉人工審核？"
        confirmLabel="轉人工審核"
        tone="warning"
        busy={deleteBusy}
        onCancel={() => !deleteBusy && setPendingDelete(null)}
        onConfirm={confirmDelete}
      >
        <div className="space-y-2">
          <p>
            「{pendingDelete?.raw_name || '（空白）'}」這筆記錄與其所有學員資料會完整保留，並停止自動認領。
          </p>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            <li>後續 Ragic 同步只會更新同一筆 source record，不會建立重複 Z03。</li>
            <li>此操作不會刪除本地或 Ragic 原始資料；可在「人工審核」分頁繼續查詢。</li>
          </ul>
        </div>
      </ConfirmDialog>
    </div>
  );
}
