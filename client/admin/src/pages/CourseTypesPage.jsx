import React, { useEffect, useState } from 'react';
import DateTimePicker from '../../../shared/DateTimePicker.jsx';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { courseTypesApi } from '../api/courseTypes';
import { formatTWDateTime, formatTWDateTimeSeconds, toTaipeiDateTimeInput, taipeiInputToDate } from '../utils/format';

const autoLabel = (ct) => {
  const map = { 1: '一對一', 2: '一對二', 3: '一對三', 4: '一對四', 5: '一對五', 6: '一對六' };
  return map[ct] || `一對${ct}`;
};

const fmtDate = (v) => (v ? String(v).slice(0, 10).replace(/-/g, '/') : '—');
const fmtMoney = (v) => `NT$ ${Number(v || 0).toLocaleString('en-US')}`;
const fmtDateTime = formatTWDateTime;
const fmtDateTimeSec = formatTWDateTimeSeconds;
const toLocalInput = toTaipeiDateTimeInput;
// 無法解析回 NaN：後續比較一律為 false，會退回「立即生效」這個保守分支，後端仍會再驗一次。
const taipeiInputInstant = (value) => { const d = taipeiInputToDate(value); return d ? d.getTime() : NaN; };
const FIELD_LABELS = { label: '名稱', base_price: '每期價格', min_students: '最少學生', max_students: '最多學生', is_active: '狀態', data_group: '資料管理群組', trial_enabled: '提供試上', trial_price: '試上單價', tier_prices: '加成級距價格' };
// 1.5 / '1.50' → '1.50'（與後端 services/coursePricing.js tierKey 同規則）
const tierKey = (m) => (Number.isFinite(Number(m)) && Number(m) > 0 ? Number(m) : 1).toFixed(2);
const tierPct = (m) => `${Math.round((Number(m) - 1) * 100)}%`;
// 軌跡顯示：{'1.50':9000} → 「50% NT$ 9,000」；空的顯示「未設定」。
const showTierPrices = (v) => {
  if (!v || typeof v !== 'object') return '未設定';
  const ks = Object.keys(v).sort();
  if (!ks.length) return '未設定';
  return ks.map((k) => `${tierPct(k)} ${fmtMoney(v[k])}`).join('、');
};
const showVal = (k, v) => (
  k === 'tier_prices' ? showTierPrices(v)
    : k === 'base_price' ? fmtMoney(v)
    : k === 'trial_price' ? (v == null || v === '' ? '未設定' : fmtMoney(v))
      : k === 'is_active' ? (v ? '啟用中' : '已停用')
        : k === 'trial_enabled' ? (v ? '提供' : '不提供')
          : (v ?? '—'));

// Ragic 風格編輯卡片的樣式（全部 scope 在 .ragic-edit 下，避免與全站 class 撞名）。
const RAGIC_CSS = `
.ragic-edit{font-size:13.5px;color:#23303f;line-height:1.5}
.ragic-edit .card{background:#fff;border:1px solid #d0d7df;border-radius:4px;box-shadow:0 2px 10px rgba(30,60,110,.08);overflow:hidden}
.ragic-edit .hdr{background:#2a60ab;color:#fff;display:flex;align-items:center;justify-content:space-between;padding:11px 16px}
.ragic-edit .hdr .ttl{display:flex;align-items:center;gap:9px;font-size:15px;font-weight:700}
.ragic-edit .hdr .ttl::before{content:"";width:4px;height:17px;background:#ffd43b;border-radius:2px}
.ragic-edit .hdr .code{font-size:12px;font-weight:400;opacity:.85}
.ragic-edit .hdr .x{cursor:pointer;opacity:.85;font-size:13px;background:none;border:none;color:#fff;font-family:inherit}
.ragic-edit .hdr .x:hover{opacity:1}
.ragic-edit .tabs{display:flex;gap:3px;padding:8px 12px 0;background:#f4f6f9;border-bottom:1px solid #c9d4e0;flex-wrap:wrap}
.ragic-edit .tab{padding:7px 15px;font-size:13px;font-weight:600;color:#5e6b7a;background:#dde4ec;border:1px solid #c9d4e0;border-bottom:none;border-radius:5px 5px 0 0;cursor:pointer;position:relative;top:1px}
.ragic-edit .tab.t-em{background:#f3b27a;color:#5a3208}
.ragic-edit .tab.active{background:#fff;color:#2a60ab;box-shadow:0 -1px 0 #2a60ab inset}
.ragic-edit .panel{padding:16px}
.ragic-edit .grid{display:grid;grid-template-columns:max-content 1fr max-content 1fr;border-top:1px solid #c9d4e0;border-left:1px solid #c9d4e0}
.ragic-edit .lbl,.ragic-edit .cell{border-right:1px solid #c9d4e0;border-bottom:1px solid #c9d4e0;min-height:34px}
.ragic-edit .lbl{background:#e9eef4;color:#1f3a5f;font-weight:600;display:flex;align-items:center;padding:6px 11px;white-space:nowrap;font-size:12.5px}
.ragic-edit .lbl .req{color:#d32f2f;margin-right:3px}
.ragic-edit .cell{background:#fff;display:flex;align-items:center;padding:6px 11px;gap:6px;min-width:0}
.ragic-edit .cell.editable{cursor:pointer}
.ragic-edit .cell.editable:hover{background:#f1f8ff}
.ragic-edit .ehint{margin-left:auto;font-size:11px;opacity:0}
.ragic-edit .cell.editable:hover .ehint{opacity:.4}
.ragic-edit .cell.readonly{background:#fafbfc;color:#46545f;cursor:default}
.ragic-edit .cell.is-dim{opacity:.45;pointer-events:none}
.ragic-edit .cell-tx{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ragic-edit .muted{color:#9aa3ad}
.ragic-edit .cal{font-size:11px;opacity:.45;margin-left:auto}
.ragic-edit .ed{width:100%;min-width:60px;border:1px solid #7ba7d9;background:#fff;padding:4px 6px;font:inherit;color:#23303f;outline:none;border-radius:2px}
.ragic-edit .ed:focus{border-color:#2a60ab;box-shadow:0 0 0 2px rgba(42,96,171,.15)}
.ragic-edit .pill{display:inline-block;padding:2px 11px;border-radius:11px;font-size:12px;font-weight:700;line-height:1.6}
.ragic-edit .pill.ok{background:#7cc47f;color:#163a17}
.ragic-edit .pill.warn{background:#f6b45a;color:#5a3a08}
.ragic-edit .pill.done{background:#d4dae0;color:#48535d}
.ragic-edit .pill.off{background:#e6b0aa;color:#5a1d17}
.ragic-edit .effbox{border:1px solid #c9d4e0;background:#f7f9fc;padding:12px 13px;margin-top:13px;border-radius:4px}
.ragic-edit .effbox .rrow{display:flex;gap:22px;align-items:center;font-weight:600;flex-wrap:wrap}
.ragic-edit .effbox label{cursor:pointer;display:flex;gap:6px;align-items:center}
.ragic-edit .effbox .hint{margin-top:8px;font-size:12px;color:#7a8593;line-height:1.6}
.ragic-edit .sched-banner{border:1px solid rgba(42,96,171,.3);background:rgba(42,96,171,.05);border-radius:4px;padding:11px 13px;margin-bottom:13px}
.ragic-edit .sched-banner h4{margin:0 0 8px;font-size:13px;color:#2a60ab}
.ragic-edit .sched-banner table{width:100%;border-collapse:collapse;font-size:12px}
.ragic-edit .sched-banner th{text-align:left;font-weight:500;color:#7a8593;padding:2px 4px}
.ragic-edit .sched-banner td{padding:3px 4px;border-top:1px solid #eef1f4}
.ragic-edit .sched-banner .nv{font-weight:700;color:#2a60ab}
.ragic-edit .lnk-btn{margin-top:8px;background:#fff;border:1px solid #f0b9b3;color:#c0392b;border-radius:5px;padding:5px 11px;font-size:12px;font-weight:600;cursor:pointer}
.ragic-edit .lnk-btn:hover:not(:disabled){background:#fdecea}
.ragic-edit .lnk-btn:disabled{opacity:.5;cursor:default}
.ragic-edit .trail-hd{background:#f0f4f9;color:#1f3a5f;padding:8px 13px;font-weight:700;font-size:13px;border:1px solid #c9d4e0;border-bottom:none;border-radius:3px 3px 0 0}
.ragic-edit .trail{border:1px solid #c9d4e0;max-height:240px;overflow-y:auto}
.ragic-edit .trail .row{display:flex;justify-content:space-between;align-items:flex-start;padding:9px 13px;border-bottom:1px solid #eef1f4;gap:12px}
.ragic-edit .trail .row:last-child{border-bottom:none}
.ragic-edit .trail .op{font-weight:600;color:#2f3d4c}
.ragic-edit .trail .who{font-size:12px;color:#8a95a2;margin-top:2px}
.ragic-edit .trail .chg{font-size:12px;color:#5a6675;margin-top:3px}
.ragic-edit .trail .ts{font-size:12px;color:#8a95a2;white-space:nowrap}
.ragic-edit .trail .empty{padding:13px;text-align:center;color:#9aa3ad;font-size:12.5px}
.ragic-edit .acts{display:flex;gap:10px;padding:16px;background:#f7f9fc;border-top:1px solid #c9d4e0}
.ragic-edit .btn{padding:9px 22px;border-radius:5px;font-size:13.5px;font-weight:700;cursor:pointer;border:1px solid transparent;font-family:inherit}
.ragic-edit .btn:disabled{opacity:.5;cursor:default}
.ragic-edit .btn-primary{background:#2a60ab;color:#fff}
.ragic-edit .btn-primary:hover:not(:disabled){background:#1f4d8c}
.ragic-edit .btn-ghost{background:#fff;color:#4a5663;border-color:#cdd5de}
.ragic-edit .btn-ghost:hover{background:#eef1f4}
.ragic-edit .err{color:#d32f2f;font-size:13px;padding:0 16px 4px}
@media (max-width:720px){.ragic-edit .grid{grid-template-columns:minmax(96px,max-content) 1fr}.ragic-edit .lbl{white-space:normal;line-height:1.35}}
`;

export default function CourseTypesPage() {
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const [saving, setSaving] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ course_type: '', label: '', min_students: '', max_students: '', base_price: '', data_group: '', trial_enabled: false, trial_price: '' });
  const [addErr, setAddErr] = useState('');
  const [tiers, setTiers] = useState([]);   // 加成級距（只列 >1，1.00 就是每期價格本身）
  const [editing, setEditing] = useState(null); // 整列 + 表單狀態
  const [editErr, setEditErr] = useState('');
  const [activeTab, setActiveTab] = useState('basic'); // Ragic 卡片分頁：basic / eff / sys
  const [editCell, setEditCell] = useState(null);      // 目前「格子編輯」中的欄位 key（null＝無）
  const escRef = React.useRef(false);                  // 標記 Esc 取消，讓接著觸發的 blur 還原
  const cellOrigRef = React.useRef('');                // 進入格子編輯時的原值（Esc 還原用）

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
  // 級距清單載入失敗不擋整頁（只是少了加成價格欄位），維持與軌跡載入相同的容錯策略。
  useEffect(() => {
    courseTypesApi.coachMultipliers()
      .then((list) => setTiers((Array.isArray(list) ? list : [])
        .map((x) => Number(x.multiplier)).filter((m) => Number.isFinite(m) && m > 1).sort((a, b) => a - b)))
      .catch(() => setTiers([]));
  }, []);

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
        trial_enabled: form.trial_enabled,
        trial_price: form.trial_price === '' ? null : form.trial_price,
      });
      setShowAdd(false);
      setForm({ course_type: '', label: '', min_students: '', max_students: '', base_price: '', data_group: '', trial_enabled: false, trial_price: '' });
      toast.success(`已新增「${form.label.trim() || autoLabel(ct)}」`);
      await load();
    } catch (e) {
      setAddErr(e?.response?.data?.error || '新增失敗');
    }
  }

  async function startEdit(row) {
    setEditing({
      course_type: row.course_type,
      label: row.label,
      base_price: String(row.base_price ?? 0),
      min_students: String(row.min_students ?? 1),
      max_students: String(row.max_students),
      is_active: !!row.is_active,
      data_group: row.data_group || '',
      trial_enabled: !!row.trial_enabled,
      trial_price: row.trial_price == null ? '' : String(row.trial_price),
      // 各加成級距明價：字串態（空字串＝未設定，送出時會被後端丟掉）。
      tier_prices: Object.fromEntries(Object.entries(row.tier_prices || {}).map(([k, v]) => [tierKey(k), String(v)])),
      // 生效方式 + 排程起訖（datetime-local 值；若已有排程則預填，方便修改）
      mode: 'immediate',
      scheduled_effective_date: toLocalInput(row.scheduled_effective_date),
      scheduled_effective_until: toLocalInput(row.scheduled_effective_until),
      // 唯讀 metadata（日軌）
      created_at: row.created_at,
      updated_at: row.updated_at,
      effective_date: row.effective_date,
      effective_until: row.effective_until,
      cur_scheduled: row.scheduled_effective_date,
      cur_scheduled_until: row.scheduled_effective_until,
      pending: row.pending_changes || null,
      // 編輯軌跡（非同步載入）
      audit: null,
      auditOpen: false,
      _live: { label: row.label, base_price: row.base_price, min_students: row.min_students, max_students: row.max_students, is_active: row.is_active, data_group: row.data_group, trial_enabled: row.trial_enabled, trial_price: row.trial_price, tier_prices: row.tier_prices || null },
    });
    setEditErr('');
    setActiveTab('basic');
    setEditCell(null);
    try {
      const logs = await courseTypesApi.auditLogs(row.course_type);
      setEditing((s) => (s && s.course_type === row.course_type ? { ...s, audit: Array.isArray(logs) ? logs : [] } : s));
    } catch {
      // 軌跡載入失敗不擋編輯；落定 audit=[] 讓「執行編輯軌跡」顯示「尚無編輯紀錄」而非永遠「載入中…」。
      setEditing((s) => (s && s.course_type === row.course_type ? { ...s, audit: [] } : s));
    }
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
      trial_enabled: editing.trial_enabled,
      trial_price: editing.trial_price === '' ? null : editing.trial_price,
      // 空字串的級距不送值 → 後端 normalizeTierPrices 會丟掉 → 該級距回退「每期價格 x 加成」。
      tier_prices: editing.tier_prices || {},
    };
    // 排程：選「排程生效」必選生效起日；起日在未來＝排程，此時「生效迄日」必填且需晚於起日。
    // 起日在過去/現在 → 後端視為立即生效（不需迄日）。
    const start = editing.scheduled_effective_date;
    const isFuture = editing.mode === 'scheduled' && !!start && taipeiInputInstant(start) > Date.now();
    if (editing.mode === 'scheduled') {
      if (!start) { setEditErr('排程生效請選擇「生效起日」'); return; }
      patch.scheduled_effective_date = start;
      if (isFuture) {
        const until = editing.scheduled_effective_until;
        if (!until) { setEditErr('排程生效需同時填寫「生效起日」與「生效迄日」'); return; }
        if (taipeiInputInstant(until) <= taipeiInputInstant(start)) { setEditErr('「生效迄日」需晚於「生效起日」'); return; }
        patch.scheduled_effective_until = until;
      }
    }
    setSaving(editing.course_type);
    try {
      await courseTypesApi.update(editing.course_type, patch);
      toast.success(isFuture ? `已排程於 ${fmtDateTime(start)} 生效` : '已更新（立即生效）');
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

  function closeEdit() { setEditing(null); setEditErr(''); setActiveTab('basic'); setEditCell(null); }

  // 「格子編輯」共用鍵盤行為：Enter 提交、Esc 取消（取消時設旗標，讓接著的 blur 不提交）。
  const cellKeyDown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); escRef.current = true; e.target.blur(); }
  };
  // 產生一個「點擊即編輯」的格子（顯示 ↔ 非受控 input）。每次按鍵即時 mirror 進 editing，
  // 因此儲存/取消讀到的永遠是最新值（不依賴「按鈕一定先觸發 input blur」這種跨瀏覽器不一致行為）。
  // Esc 以進入編輯時的原值還原。type: text|number|select|datetime；dim＝唯讀灰階；cal＝日曆 icon。
  const ecell = ({ field, type = 'text', display, editValue, options, apply, placeholder, dim, cal }) => {
    // datetime 不走「點擊即編輯」：共用選擇器是彈出面板，點面板內的日期會讓
    // 觸發鈕失焦，剛好撞上下面那個「blur 就結束編輯」的生命週期 —— 面板會在
    // 選到日期的同一瞬間關掉。選擇器本身就長得像控制項，直接常駐即可。
    if (type === 'datetime') {
      return (
        <div className={`cell${dim ? ' is-dim' : ''}`}>
          <DateTimePicker
            mode="datetime" value={editValue || ''} disabled={dim}
            onChange={apply} clearable placeholder={placeholder || '未設定'}
          />
        </div>
      );
    }
    const isEd = editCell === field && !dim;
    // 失焦：Esc 還原原值，否則保留已即時寫入的值；兩種情形都結束格子編輯。
    const onBlur = () => {
      if (escRef.current) { escRef.current = false; apply(cellOrigRef.current); }
      setEditCell(null);
    };
    let inner;
    if (isEd && type === 'select') {
      inner = (
        <select className="ed" autoFocus defaultValue={editValue}
          onChange={(e) => { apply(e.target.value); setEditCell(null); }}
          onBlur={() => setEditCell(null)} onKeyDown={cellKeyDown}>
          {options.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    } else if (isEd) {
      inner = (
        <input className="ed" autoFocus
          type={type === 'number' ? 'number' : type === 'datetime' ? 'datetime-local' : 'text'}
          defaultValue={editValue} onChange={(e) => apply(e.target.value)}
          onBlur={onBlur} onKeyDown={cellKeyDown} />
      );
    } else if (display !== '' && display != null) {
      inner = <><span className="cell-tx">{display}</span>{cal && <span className="cal">📅</span>}<span className="ehint">✎</span></>;
    } else {
      inner = <><span className="muted">{placeholder || '—'}</span>{cal && <span className="cal">📅</span>}<span className="ehint">✎</span></>;
    }
    return (
      <div className={`cell editable${dim ? ' is-dim' : ''}`}
        onClick={() => { if (!dim && editCell !== field) { escRef.current = false; cellOrigRef.current = editValue ?? ''; setEditCell(field); } }}>
        {inner}
      </div>
    );
  };

  // 行內編輯面板（Ragic 風格分頁卡片）。以函式呼叫方式 inline 進 render（非 <Component/>），避免重新掛載失焦。
  const renderEditPanel = () => {
    const now = Date.now();
    // 系統資訊頁的生命週期狀態 pill（待生效／生效中／已過期）
    let lifeTxt = '生效中', lifeCls = 'ok';
    if (editing.pending && editing.cur_scheduled && new Date(editing.cur_scheduled).getTime() > now) { lifeTxt = '待生效'; lifeCls = 'warn'; }
    else if (editing.effective_until && new Date(`${String(editing.effective_until).slice(0, 10)}T23:59:59+08:00`).getTime() < now) { lifeTxt = '已過期'; lifeCls = 'done'; }
    const isSched = editing.mode === 'scheduled';
    const uid = `ct-${String(editing.course_type).padStart(4, '0')}`;
    const fmtLocal = (v) => (v ? String(v).replace(/-/g, '/').replace('T', ' ') : '');

    return (
      <div className="ragic-edit">
        <style>{RAGIC_CSS}</style>
        <div className="card">
          {/* header */}
          <div className="hdr">
            <div className="ttl">編輯課程需求：{editing._live.label}
              <span className="code">（系統代碼 {editing.course_type}）</span>
            </div>
            <button type="button" className="x" onClick={closeEdit}>關閉 ✕</button>
          </div>

          {/* tabs */}
          <div className="tabs">
            <div className={`tab${activeTab === 'basic' ? ' active' : ''}`} onClick={() => { setEditCell(null); setActiveTab('basic'); }}>基本資料</div>
            <div className={`tab${activeTab === 'eff' ? ' active' : ''}`} onClick={() => { setEditCell(null); setActiveTab('eff'); }}>生效設定</div>
            <div className={`tab t-em${activeTab === 'sys' ? ' active' : ''}`} onClick={() => { setEditCell(null); setActiveTab('sys'); }}>系統資訊（資訊人員專用）</div>
          </div>

          {/* 基本資料 */}
          {activeTab === 'basic' && (
            <div className="panel">
              <div className="grid">
                <div className="lbl"><span className="req">＊</span>名稱</div>
                {ecell({ field: 'label', type: 'text', display: editing.label, editValue: editing.label, apply: (v) => setEditing((s) => ({ ...s, label: v })) })}
                <div className="lbl"><span className="req">＊</span>每期價格（每人，NT$）</div>
                {ecell({ field: 'base_price', type: 'number', display: editing.base_price, editValue: editing.base_price, apply: (v) => setEditing((s) => ({ ...s, base_price: v })) })}

                <div className="lbl"><span className="req">＊</span>狀態</div>
                {ecell({ field: 'is_active', type: 'select', options: ['啟用中', '已停用'], display: editing.is_active ? '啟用中' : '已停用', editValue: editing.is_active ? '啟用中' : '已停用', apply: (v) => setEditing((s) => ({ ...s, is_active: v === '啟用中' })) })}
                <div className="lbl">資料管理群組</div>
                {ecell({ field: 'data_group', type: 'text', display: editing.data_group, editValue: editing.data_group, placeholder: '例：新北高中【櫃台】', apply: (v) => setEditing((s) => ({ ...s, data_group: v })) })}

                <div className="lbl"><span className="req">＊</span>最少學生</div>
                {ecell({ field: 'min_students', type: 'number', display: editing.min_students, editValue: editing.min_students, apply: (v) => setEditing((s) => ({ ...s, min_students: v })) })}
                <div className="lbl"><span className="req">＊</span>最多學生</div>
                {ecell({ field: 'max_students', type: 'number', display: editing.max_students, editValue: editing.max_students, apply: (v) => setEditing((s) => ({ ...s, max_students: v })) })}

                <div className="lbl">提供試上</div>
                {ecell({ field: 'trial_enabled', type: 'select', options: ['提供', '不提供'], display: editing.trial_enabled ? '提供' : '不提供', editValue: editing.trial_enabled ? '提供' : '不提供', apply: (v) => setEditing((s) => ({ ...s, trial_enabled: v === '提供' })) })}
                <div className="lbl">試上單價（每人，NT$）</div>
                {ecell({ field: 'trial_price', type: 'number', display: editing.trial_price, editValue: editing.trial_price, placeholder: '未設定（自動推算）', apply: (v) => setEditing((s) => ({ ...s, trial_price: v })) })}

                {tiers.map((m) => {
                  const k = tierKey(m);
                  return (
                    <React.Fragment key={k}>
                      <div className="lbl">加成 {tierPct(m)} 價格（每人，NT$）</div>
                      {ecell({
                        field: `tier_${k}`, type: 'number',
                        display: editing.tier_prices?.[k] ?? '',
                        editValue: editing.tier_prices?.[k] ?? '',
                        placeholder: '未設定',
                        apply: (v) => setEditing((s) => ({ ...s, tier_prices: { ...(s.tier_prices || {}), [k]: v } })),
                      })}
                    </React.Fragment>
                  );
                })}
                {tiers.length > 0 && (
                  <div style={{ gridColumn: '1 / -1', padding: '7px 11px', background: '#fbfcfd', borderRight: '1px solid #c9d4e0', borderBottom: '1px solid #c9d4e0', fontSize: 12, color: '#5e6b7a' }}>
                    加成級距價格留空＝該級距沿用「每期價格 × 加成倍率」自動計算；填了就以填的為準（成交金額以此為唯一來源）。
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 生效設定 */}
          {activeTab === 'eff' && (
            <div className="panel">
              {/* 待生效排程：目前值 vs 即將生效值 */}
              {editing.pending && editing.cur_scheduled && (
                <div className="sched-banner">
                  <h4>已排程：{fmtDateTime(editing.cur_scheduled)} 生效</h4>
                  <table>
                    <thead><tr><th>欄位</th><th>目前值</th><th>即將生效值</th></tr></thead>
                    <tbody>
                      {Object.keys(editing.pending).filter((k) => FIELD_LABELS[k] && String(editing.pending[k]) !== String(editing._live[k])).map((k) => (
                        <tr key={k}>
                          <td>{FIELD_LABELS[k]}</td>
                          <td>{showVal(k, editing._live[k])}</td>
                          <td className="nv">{showVal(k, editing.pending[k])}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <button type="button" className="lnk-btn" onClick={cancelSchedule} disabled={saving === editing.course_type}>取消排程</button>
                </div>
              )}

              <div className="grid">
                <div className="lbl">目前生效起日</div>
                <div className="cell readonly"><span className="cell-tx">{fmtDate(editing.effective_date)}</span></div>
                <div className="lbl">目前生效迄日</div>
                <div className="cell readonly"><span className="cell-tx">{editing.effective_until ? fmtDate(editing.effective_until) : '—'}</span></div>

                <div className="lbl">排程生效起</div>
                {ecell({ field: 'scheduled_effective_date', type: 'datetime', dim: !isSched, cal: true, display: fmtLocal(editing.scheduled_effective_date), editValue: editing.scheduled_effective_date, apply: (v) => setEditing((s) => ({ ...s, scheduled_effective_date: v })) })}
                <div className="lbl">排程生效迄</div>
                {ecell({ field: 'scheduled_effective_until', type: 'datetime', dim: !isSched, cal: true, display: fmtLocal(editing.scheduled_effective_until), editValue: editing.scheduled_effective_until, apply: (v) => setEditing((s) => ({ ...s, scheduled_effective_until: v })) })}
              </div>

              <div className="effbox">
                <div className="rrow">生效方式：
                  <label><input type="radio" name={`eff-${editing.course_type}`} checked={editing.mode === 'immediate'} onChange={() => setEditing((s) => ({ ...s, mode: 'immediate' }))} /> 立即生效</label>
                  <label><input type="radio" name={`eff-${editing.course_type}`} checked={editing.mode === 'scheduled'} onChange={() => setEditing((s) => ({ ...s, mode: 'scheduled' }))} /> 排程生效</label>
                </div>
                <div className="hint">排程生效：選未來「生效起日＋迄日」（兩者必填），到生效起日前正式資料不變，時間一到由系統自動套用（每 5 分鐘檢查一次）。選過去／現在的起日＝立即生效。</div>
              </div>
            </div>
          )}

          {/* 系統資訊（唯讀） */}
          {activeTab === 'sys' && (
            <div className="panel">
              <div className="grid">
                <div className="lbl">狀態</div>
                <div className="cell readonly"><span className={`pill ${lifeCls}`}>{lifeTxt}</span></div>
                <div className="lbl">資料管理群組</div>
                <div className="cell readonly">{editing._live.data_group ? <span className="cell-tx">{editing._live.data_group}</span> : <span className="muted">—</span>}</div>

                <div className="lbl">資料建立日期</div>
                <div className="cell readonly"><span className="cell-tx">{fmtDateTimeSec(editing.created_at)}</span></div>
                <div className="lbl">最後更新日期</div>
                <div className="cell readonly"><span className="cell-tx">{fmtDateTimeSec(editing.updated_at)}</span></div>

                <div className="lbl">今天日期</div>
                <div className="cell readonly"><span className="cell-tx">{today}</span></div>
                <div className="lbl">唯一值</div>
                <div className="cell readonly"><span className="cell-tx">{uid}</span></div>
              </div>
            </div>
          )}

          {/* 執行編輯軌跡（唯讀） */}
          <div style={{ padding: '0 16px 16px' }}>
            <div className="trail-hd">執行編輯軌跡{editing.audit ? `（${editing.audit.length}）` : ''}</div>
            <div className="trail">
              {!editing.audit && <div className="empty">載入中…</div>}
              {editing.audit && editing.audit.length === 0 && <div className="empty">尚無編輯紀錄</div>}
              {editing.audit && editing.audit.map((lg) => (
                <div key={lg.id} className="row">
                  <div>
                    <div className="op">{lg.action}</div>
                    <div className="who">操作人：{lg.by_user || '—'}{lg.note ? `・${lg.note}` : ''}</div>
                    {lg.changes && (
                      <div className="chg">
                        {Object.entries(lg.changes).map(([k, v]) => (
                          <span key={k} style={{ marginRight: 8, display: 'inline-block' }}>
                            {FIELD_LABELS[k] || k}：{(v && v.before !== undefined && v.before !== null) ? `${showVal(k, v.before)} → ` : ''}{showVal(k, v && v.after)}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="ts">{fmtDateTimeSec(lg.at)}</div>
                </div>
              ))}
            </div>
          </div>

          {editErr && <div className="err">{editErr}</div>}

          {/* footer */}
          <div className="acts">
            <button type="button" className="btn btn-primary" disabled={saving === editing.course_type} onClick={handleSaveEdit}>
              {saving === editing.course_type ? '儲存中…' : (isSched ? '排程儲存' : '立即儲存')}
            </button>
            <button type="button" className="btn btn-ghost" onClick={closeEdit}>取消</button>
          </div>
        </div>
      </div>
    );
  };

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
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">提供試上</label>
              <select value={form.trial_enabled ? '1' : '0'} onChange={(e) => setForm((f) => ({ ...f, trial_enabled: e.target.value === '1' }))} className={inputCls}>
                <option value="0">不提供</option>
                <option value="1">提供</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600">試上單價（每人，NT$，選填）</label>
              <input type="number" step="100" value={form.trial_price} onChange={(e) => setForm((f) => ({ ...f, trial_price: e.target.value }))} className={inputCls} placeholder="未填＝自動推算" />
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
              <th className="px-4 py-3 text-left font-semibold text-gray-600">試上</th>
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
              <tr><td colSpan={10} className="py-12 text-center text-gray-400">尚無課程需求設定</td></tr>
            )}
            {rows.map((row) => {
              const isEditing = editing?.course_type === row.course_type;
              return (
                <React.Fragment key={row.course_type}>
                  <tr className={`transition ${isEditing ? 'bg-brand-primary/5' : 'hover:bg-gray-50'} ${!row.is_active && !isEditing ? 'opacity-50' : ''}`}>
                    <td className="px-4 py-4 font-semibold text-gray-800">{row.label}</td>
                    <td className="px-4 py-4 font-medium text-gray-800">{fmtMoney(row.base_price)}</td>
                    <td className="px-4 py-4 text-xs">
                      {row.trial_enabled
                        ? <span className="rounded-full bg-teal-100 px-2 py-1 font-semibold text-teal-700">{row.trial_price != null ? fmtMoney(row.trial_price) : '推算'}</span>
                        : <span className="text-gray-400">—</span>}
                    </td>
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
                      <td colSpan={10} className="px-4 pb-5 pt-1">
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
