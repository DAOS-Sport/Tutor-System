import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { enrollmentsApi } from '../api/enrollments';
import { venuesApi } from '../api/venues';
import { staffApi } from '../api/staff';
import { customerParentsApi } from '../api/customers';
import { courseTypesApi } from '../api/courseTypes';

const SESSIONS_PER_PERIOD = 6; // 一期固定 6 堂；總堂數 > 6 後端自動拆單。
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };

// ── 內嵌 SVG 圖示（Lucide 風格 stroke，免外部依賴） ──────────────────────
function Svg({ d, className = 'w-4 h-4' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
      {Array.isArray(d) ? d.map((p, i) => <path key={i} d={p} />) : <path d={d} />}
    </svg>
  );
}
const I = {
  search: ['m21 21-4.34-4.34', 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z'],
  userPlus: ['M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2', 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z', 'M19 8v6', 'M22 11h-6'],
  chevron: 'm6 9 6 6 6-6',
  x: ['M18 6 6 18', 'm6 6 12 12'],
  trash: ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'],
  check: 'M20 6 9 17l-5-5',
  folder: ['M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z', 'M12 11v6', 'M9 14h6'],
  shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z', 'M12 8v4', 'M12 16h.01'],
  db: ['M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5', 'M3 5c0 1.66 4 3 9 3s9-1.34 9-3-4-3-9-3-9 1.34-9 3'],
};

function Label({ children }) {
  return <label className="mb-1.5 block text-xs font-bold uppercase tracking-wider text-slate-500">{children}</label>;
}
function Inp({ value, onChange, type = 'text', placeholder, disabled, className = '' }) {
  return (
    <input
      type={type} value={value} disabled={disabled} placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={`w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-semibold outline-none transition-all focus:border-indigo-500 focus:bg-white focus:ring-4 focus:ring-indigo-500/10 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 ${className}`}
    />
  );
}
function Sel({ value, onChange, children, disabled }) {
  return (
    <select
      value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}
      className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-semibold outline-none transition-all focus:border-indigo-500 focus:bg-white focus:ring-4 focus:ring-indigo-500/10 disabled:bg-slate-100 disabled:text-slate-400"
    >
      {children}
    </select>
  );
}
function StepCard({ no, color, title, children }) {
  return (
    <div className="relative rounded-2xl border border-slate-200/80 bg-white p-6 shadow-sm">
      <div className={`absolute bottom-4 left-0 top-4 w-1 rounded-r-full ${color.bar}`} />
      <div className="mb-5 flex items-center gap-3">
        <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${color.badge}`}>{no}</span>
        <h3 className="text-sm font-extrabold tracking-wide text-slate-800">{title}</h3>
      </div>
      {children}
    </div>
  );
}

// 模糊搜尋下拉（async）
function SearchCombobox({ onSearch, onPick, renderOption, footer }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [opts, setOpts] = useState([]);
  const [loading, setLoading] = useState(false);
  const qRef = useRef(q); qRef.current = q;
  useEffect(() => {
    if (!q.trim()) { setOpts([]); setLoading(false); return undefined; }
    let alive = true; setLoading(true);
    const t = setTimeout(async () => {
      try { const r = await onSearch(q.trim()); if (alive && qRef.current.trim()) setOpts(r || []); }
      catch { if (alive) setOpts([]); } finally { if (alive) setLoading(false); }
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="relative">
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3.5 text-slate-400"><Svg d={I.search} /></span>
        <input
          value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
          placeholder="輸入家長姓名或手機號碼搜尋..."
          className="w-full rounded-xl border border-slate-200 bg-slate-50/80 py-3 pl-10 pr-4 text-sm font-semibold outline-none transition-all placeholder-slate-400 focus:border-indigo-500 focus:bg-white focus:ring-4 focus:ring-indigo-500/10"
        />
      </div>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 right-0 z-40 mt-1.5 max-h-72 overflow-y-auto rounded-xl border border-slate-200/90 bg-white shadow-2xl">
            {loading && <div className="p-3 text-center text-xs text-slate-400">搜尋中…</div>}
            {!loading && q.trim() && opts.length === 0 && <div className="p-3 text-center text-xs text-slate-400">無此關聯家長</div>}
            {!loading && !q.trim() && <div className="p-3 text-center text-xs text-slate-400">輸入姓名或電話以模糊搜尋…</div>}
            {opts.map((o) => (
              <button key={o.id} type="button"
                onClick={() => { onPick(o); setOpen(false); setQ(''); setOpts([]); }}
                className="flex w-full items-center justify-between border-b border-slate-100 p-3 text-left text-xs last:border-0 hover:bg-indigo-50/80">
                {renderOption(o)}
              </button>
            ))}
            {footer && <div className="border-t border-slate-100">{footer}</div>}
          </div>
        </>
      )}
    </div>
  );
}

const FRESH = {
  courseType: '', totalSessions: 6, className: '', levelNote: '', submittedAt: '',
  basePrice: '', allowance: '', actual: '', paymentMethod: '轉帳', paymentDetail: '',
  payer: '', taxId: '', carrier: '', workType: '',
};

export default function ManualEnrollPage() {
  const { user, isStaff } = useAuth();
  const toast = useToast();

  const [formOpen, setFormOpen] = useState(true);
  const [extraOpen, setExtraOpen] = useState(false);

  const [parent, setParent] = useState(null);
  const [pickedStudentIds, setPickedStudentIds] = useState([]);
  const [extraStudents, setExtraStudents] = useState('');
  const [showNewStudent, setShowNewStudent] = useState(false);
  const [ns, setNs] = useState({ name: '', gender: '', birth_date: '', id_number: '' });
  const [np, setNp] = useState({ name: '', phone: '', gender: '', email: '' });

  const [venues, setVenues] = useState([]);
  const [venueId, setVenueId] = useState('');
  const [coaches, setCoaches] = useState([]);
  const [coachId, setCoachId] = useState('');
  const [coachesLoading, setCoachesLoading] = useState(false);

  // 課程需求（課程需求管理 /admin/course-types = course_type_configs，每期價格唯一來源）
  const [courseTypes, setCourseTypes] = useState([]);
  const [courseTypesLoading, setCourseTypesLoading] = useState(true);
  const activeCourseTypes = useMemo(() => courseTypes.filter((c) => c.is_active), [courseTypes]);

  const [f, setF] = useState(FRESH);
  const upd = (k) => (v) => setF((p) => ({ ...p, [k]: v }));

  const [busy, setBusy] = useState(false);
  const [filed, setFiled] = useState([]);

  useEffect(() => { venuesApi.list().then((v) => setVenues(v || [])).catch(() => {}); }, []);
  useEffect(() => {
    courseTypesApi.list()
      .then((d) => setCourseTypes(Array.isArray(d) ? d : []))
      .catch(() => setCourseTypes([]))
      .finally(() => setCourseTypesLoading(false));
  }, []);
  useEffect(() => {
    if (isStaff && user?.venue_id) { setVenueId(user.venue_id); return; }
    if (parent?.primary_venue_id) setVenueId(parent.primary_venue_id);
  }, [parent, isStaff, user]);
  useEffect(() => {
    if (!venueId) { setCoaches([]); return undefined; }
    let alive = true; setCoachesLoading(true);
    staffApi.coachesByVenue(venueId, 'active')
      .then((d) => alive && setCoaches(d || []))
      .catch(() => alive && setCoaches([]))
      .finally(() => alive && setCoachesLoading(false));
    return () => { alive = false; };
  }, [venueId]);

  const venueName = (id) => venues.find((v) => v.id === id)?.name || id || '—';
  const coachName = useMemo(() => coaches.find((c) => c.id === coachId)?.name || '', [coaches, coachId]);
  const lessons = Number(f.totalSessions) || 0;
  const numPeriods = Math.max(1, Math.ceil(lessons / SESSIONS_PER_PERIOD));
  const unitPrice = lessons > 0 ? Math.round((num(f.actual) / lessons) * 10) / 10 : 0;

  const studentNames = useMemo(() => {
    const picked = (parent?.students || []).filter((s) => pickedStudentIds.includes(s.id)).map((s) => s.name);
    const extra = extraStudents.split(/[、,，\n]/).map((s) => s.trim()).filter(Boolean);
    return [...new Set([...picked, ...extra])];
  }, [parent, pickedStudentIds, extraStudents]);

  // 金額：原價 − 折讓 = 實際；實際可手改（反推折讓）；單價 = 實際 / 堂數（唯讀）。
  function onBase(v) { setF((p) => ({ ...p, basePrice: v, actual: String(Math.max(0, num(v) - num(p.allowance))) })); }
  function onAllowance(v) { setF((p) => ({ ...p, allowance: v, actual: String(Math.max(0, num(p.basePrice) - num(v))) })); }
  function onActual(v) { setF((p) => ({ ...p, actual: v, allowance: String(Math.max(0, num(p.basePrice) - num(v))) })); }
  // 選組別 → 自動帶出「課程需求管理」設定的每期價格（原價），折讓沿用現有值重算實收；
  // 帶完仍可手動覆蓋，跟原價欄位的既有編輯行為一致。
  function onCourseType(v) {
    const cfg = activeCourseTypes.find((c) => String(c.course_type) === String(v));
    setF((p) => ({
      ...p,
      courseType: v,
      ...(cfg ? { basePrice: String(cfg.base_price ?? ''), actual: String(Math.max(0, num(cfg.base_price) - num(p.allowance))) } : {}),
    }));
  }
  function preset(p) {
    const b = num(f.basePrice);
    if (b <= 0) { toast.error('請先輸入原始費用（原價）'); return; }
    let d;
    if (p === 'clear') d = b; else if (p === '0.9') d = Math.round(b * 0.1); else if (p === '0.95') d = Math.round(b * 0.05); else d = Math.min(p, b);
    onAllowance(String(d));
  }

  async function searchParents(q) {
    const params = /^[\d\-+\s]+$/.test(q) ? { phone: q.replace(/[\s-]/g, '') } : { name: q };
    return customerParentsApi.list(params);
  }
  async function linkParent(id) {
    try { const full = await customerParentsApi.get(id); setParent(full); setPickedStudentIds([]); setExtraStudents(''); }
    catch { toast.error('載入家長失敗'); }
  }
  async function createParent() {
    if (!np.name.trim() || !np.phone.trim()) { toast.error('家長姓名與電話必填'); return; }
    try {
      const created = await customerParentsApi.create({
        name: np.name.trim(), phone: np.phone.trim(), gender: np.gender, email: np.email.trim(),
        primary_venue_id: isStaff ? user?.venue_id : (venueId || ''),
      });
      toast.success('已新增家長'); setNp({ name: '', phone: '', gender: '', email: '' }); await linkParent(created.id);
    } catch (err) { toast.error(err?.response?.data?.error || '新增家長失敗'); }
  }
  async function createStudent() {
    if (!parent || !ns.name.trim()) { toast.error('學員姓名必填'); return; }
    try {
      await customerParentsApi.update(parent.id, { students: [{ name: ns.name.trim(), gender: ns.gender, birth_date: ns.birth_date, id_number: ns.id_number.trim() }] });
      toast.success('已新增學員'); setShowNewStudent(false); setNs({ name: '', gender: '', birth_date: '', id_number: '' });
      const full = await customerParentsApi.get(parent.id); setParent(full);
    } catch (err) { toast.error(err?.response?.data?.error || '新增學員失敗'); }
  }
  const toggleStudent = (id) => setPickedStudentIds((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const changeParent = () => { setParent(null); setPickedStudentIds([]); setExtraStudents(''); };

  async function fileOne() {
    if (!parent) { toast.error('請先連結家長 (Z01)'); return; }
    if (!studentNames.length) { toast.error('請選擇或填寫至少一位學員'); return; }
    if (!venueId) { toast.error('請選擇報名館別'); return; }
    if (!coachId && !coachName) { toast.error('請選擇授課教練'); return; }
    if (!f.courseType) { toast.error('請選擇組別型態（需先於「課程需求管理」建立）'); return; }
    if (lessons < 1) { toast.error('請填寫有效的總堂數'); return; }
    if (num(f.basePrice) < 0 || num(f.actual) < 0) { toast.error('金額不正確'); return; }
    const last5 = f.paymentMethod === '轉帳' && /^\d{5}$/.test(f.paymentDetail.trim()) ? f.paymentDetail.trim() : '';
    if (f.paymentMethod === '轉帳' && f.paymentDetail.trim() && !last5) { toast.error('轉帳末 5 碼需為 5 位數字'); return; }

    setBusy(true);
    const snap = {
      parentName: parent.name, parentPhone: parent.phone, students: [...studentNames],
      venue: venueName(venueId), coach: coachName || '（待指派）',
      groupType: courseTypes.find((t) => String(t.course_type) === String(f.courseType))?.label,
      className: f.className.trim() || '—', lessons, basePrice: num(f.basePrice), discount: num(f.allowance),
      actual: num(f.actual), unit: unitPrice, paymentMethod: f.paymentMethod, paymentDetail: f.paymentDetail.trim() || '—',
    };
    try {
      const res = await enrollmentsApi.create({
        parent_name: parent.name, parent_phone: parent.phone, students: studentNames,
        venue_id: venueId, coach: coachName || '（待指派）', coach_id: coachId || null,
        course_type: Number(f.courseType), total_sessions: lessons,
        original_price: num(f.basePrice), final_price: num(f.actual),
        allowance_amount: num(f.allowance), unit_price: unitPrice,
        payment_method: f.paymentMethod, transfer_last_5: last5,
        payer: f.payer.trim(), class_name: f.className.trim(), tax_id: f.taxId.trim(),
        level_note: f.levelNote.trim(), work_type: f.workType.trim(), carrier: f.carrier.trim(),
        full_sessions: lessons, submitted_at: f.submittedAt || undefined,
      });
      setFiled((prev) => [...prev, { ...snap, key: (res.enrollment_ids || [res.id]).join(','), ids: res.enrollment_ids || [res.id], count: res.count || 1 }]);
      toast.success(`已建檔 ${res.count || 1} 張訂單（待對帳）`);
      setF({ ...FRESH, submittedAt: f.submittedAt }); setCoachId('');
    } catch (err) { toast.error(err?.response?.data?.error || '手動建檔失敗'); }
    finally { setBusy(false); }
  }

  function exportCsv() {
    if (!filed.length) return;
    const head = ['編號', '家長', '電話', '學員', '館別', '班級', '組別', '教練', '堂數', '原價', '折讓', '實收', '單價', '付款', '對帳碼'];
    const rows = filed.map((r) => [r.ids.join(' '), r.parentName, r.parentPhone, r.students.join(' '), r.venue, r.className, r.groupType, r.coach, r.lessons, r.basePrice, r.discount, r.actual, r.unit, r.paymentMethod, r.paymentDetail]);
    const csv = [head, ...rows].map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `手動建檔_${filed.length}筆.csv`; a.click();
    URL.revokeObjectURL(a.href);
    toast.success('已匯出 CSV');
  }

  const filteredStudents = parent?.students || [];

  return (
    <div className="space-y-6">
      {/* 標題 */}
      <div className="flex flex-col justify-between gap-4 border-b border-slate-200/80 pb-5 md:flex-row md:items-center">
        <div>
          <h1 className="flex items-center gap-3 text-2xl font-black tracking-tight text-slate-900">
            <span className="rounded-xl bg-indigo-50 p-2 text-indigo-600"><Svg d={I.userPlus} className="h-6 w-6" /></span>
            手動報名建檔
          </h1>
          <p className="mt-2 flex items-center gap-2 text-xs font-medium text-slate-500">
            <span className="inline-flex h-1.5 w-1.5 rounded-full bg-indigo-500" />
            連結 Z01 家長 / Z02 學員 → 自動堂數金額運算 → 一筆一筆往下建（狀態待對帳，不寫 Ragic）。
          </p>
        </div>
        <button type="button" onClick={() => setFormOpen((v) => !v)}
          className="flex items-center gap-2 self-start rounded-xl border border-slate-200 bg-white px-4 py-2 text-xs font-bold text-slate-600 shadow-sm hover:bg-slate-50">
          <Svg d={I.chevron} className={`h-4 w-4 transition-transform ${formOpen ? 'rotate-180' : ''}`} />
          {formOpen ? '收起建檔表單' : '展開建檔表單'}
        </button>
      </div>

      {/* 建檔表單（可收合） */}
      {formOpen && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12">
            {/* 左：對象 + 課程 */}
            <div className="space-y-6 lg:col-span-8">
              <StepCard no="01" title="關聯對象設定 (Z01 & Z02)" color={{ bar: 'bg-indigo-500', badge: 'bg-indigo-500/10 text-indigo-600' }}>
                <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                  <div>
                    <Label>家長資料（Z01 模糊搜尋）*</Label>
                    {parent ? (
                      <div className="flex items-center justify-between rounded-xl border border-indigo-200 bg-indigo-50/40 px-3.5 py-2.5">
                        <div className="text-sm"><b className="text-indigo-900">{parent.name}</b><span className="ml-2 font-mono text-xs text-indigo-700">{parent.phone}</span></div>
                        <button type="button" onClick={changeParent} className="text-slate-400 hover:text-slate-600"><Svg d={I.x} /></button>
                      </div>
                    ) : (
                      <SearchCombobox
                        onSearch={searchParents}
                        onPick={(p) => linkParent(p.id)}
                        renderOption={(p) => (
                          <>
                            <div className="flex items-center gap-2"><span className="text-sm font-extrabold text-slate-800">{p.name}</span><span className="font-semibold text-slate-400">{p.phone}</span></div>
                            <span className="rounded-md border border-indigo-100 bg-indigo-50 px-2 py-0.5 text-[10px] font-bold text-indigo-700">{p.student_count ?? 0} 位學員</span>
                          </>
                        )}
                        footer={
                          <div className="grid grid-cols-2 gap-2 p-2.5" onMouseDown={(e) => e.stopPropagation()}>
                            <div className="col-span-2 text-[11px] font-bold text-slate-400">查無？新增家長：</div>
                            <Inp value={np.name} onChange={(v) => setNp({ ...np, name: v })} placeholder="家長姓名 *" />
                            <Inp value={np.phone} onChange={(v) => setNp({ ...np, phone: v })} placeholder="行動電話 *" className="font-mono" />
                            <button type="button" onMouseDown={(e) => { e.preventDefault(); createParent(); }} className="col-span-2 rounded-xl bg-indigo-600 px-3 py-2 text-sm font-bold text-white hover:bg-indigo-700">建立並連結</button>
                          </div>
                        }
                      />
                    )}
                  </div>

                  <div>
                    <Label>關聯學員（Z02 對應名單）*</Label>
                    {!parent ? (
                      <div className="flex items-center gap-2 rounded-xl border border-dashed border-slate-200 bg-slate-50/50 px-4 py-3 text-sm font-semibold text-slate-400">請先在左側連結家長</div>
                    ) : (
                      <div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {filteredStudents.map((s) => (
                            <label key={s.id} className={`flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm font-semibold ${pickedStudentIds.includes(s.id) ? 'border-indigo-400 bg-indigo-50 text-indigo-800' : 'border-slate-200 text-slate-600'}`}>
                              <input type="checkbox" checked={pickedStudentIds.includes(s.id)} onChange={() => toggleStudent(s.id)} />{s.name}
                            </label>
                          ))}
                          {filteredStudents.length === 0 && <span className="text-sm text-slate-400">尚無學員</span>}
                          <button type="button" onClick={() => setShowNewStudent((v) => !v)} className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-sm font-semibold text-slate-600 hover:bg-slate-50">＋新增</button>
                        </div>
                        {showNewStudent && (
                          <div className="mt-2 grid grid-cols-2 gap-2 rounded-xl border border-indigo-100 bg-indigo-50/50 p-2.5">
                            <Inp value={ns.name} onChange={(v) => setNs({ ...ns, name: v })} placeholder="學員姓名 *" />
                            <Sel value={ns.gender} onChange={(v) => setNs({ ...ns, gender: v })}><option value="">性別</option><option value="男">男</option><option value="女">女</option></Sel>
                            <Inp type="date" value={ns.birth_date} onChange={(v) => setNs({ ...ns, birth_date: v })} />
                            <Inp value={ns.id_number} onChange={(v) => setNs({ ...ns, id_number: v })} placeholder="身分證字號" className="font-mono" />
                            <button type="button" onClick={createStudent} className="col-span-2 rounded-xl bg-indigo-600 px-3 py-2 text-sm font-bold text-white hover:bg-indigo-700">新增至此家長</button>
                          </div>
                        )}
                        <input value={extraStudents} onChange={(e) => setExtraStudents(e.target.value)} placeholder="或臨時名單（頓號分隔）" className="mt-1.5 w-full rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold outline-none focus:border-indigo-500" />
                        {studentNames.length > 0 && <p className="mt-1.5 text-[11px] font-bold text-emerald-600">本筆學員：{studentNames.join('、')}</p>}
                      </div>
                    )}
                  </div>
                </div>
              </StepCard>

              <StepCard no="02" title="課程與組別課務" color={{ bar: 'bg-teal-500', badge: 'bg-teal-500/10 text-teal-600' }}>
                <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
                  <div>
                    <Label>註冊館別 *</Label>
                    <Sel value={venueId} onChange={(v) => { setVenueId(v); setCoachId(''); }} disabled={isStaff}>
                      <option value="">請選擇</option>
                      {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                    </Sel>
                  </div>
                  <div>
                    <Label>授課教練 *</Label>
                    <Sel value={coachId} onChange={setCoachId} disabled={!venueId || coachesLoading}>
                      <option value="">{!venueId ? '請先選館別' : (coachesLoading ? '載入中…' : '請選取教練')}</option>
                      {coaches.map((c) => <option key={c.id} value={c.id}>{c.name}{c.is_senior ? ' ⭐' : ''}</option>)}
                    </Sel>
                  </div>
                  <div>
                    <Label>組別型態 *</Label>
                    <Sel value={f.courseType} onChange={onCourseType} disabled={courseTypesLoading || activeCourseTypes.length === 0}>
                      <option value="">{courseTypesLoading ? '載入中…' : (activeCourseTypes.length === 0 ? '尚無可用課程需求' : '請選擇組別')}</option>
                      {activeCourseTypes.map((t) => (
                        <option key={t.course_type} value={t.course_type}>{t.label}・NT$ {Number(t.base_price || 0).toLocaleString('en-US')}</option>
                      ))}
                    </Sel>
                    {!courseTypesLoading && activeCourseTypes.length === 0 && (
                      <p className="mt-1.5 text-[11px] font-semibold text-amber-600">
                        尚未有任何啟用中的課程需求，請先至
                        <Link to="/course-types" className="mx-1 underline hover:text-amber-700">課程需求管理</Link>
                        建立品項後才能建檔。
                      </p>
                    )}
                  </div>
                  <div><Label>班級名稱</Label><Inp value={f.className} onChange={upd('className')} placeholder="輸入特定班級編號" /></div>
                  <div><Label>購買總堂數 *</Label><Inp type="number" value={f.totalSessions} onChange={upd('totalSessions')} className="font-extrabold" /></div>
                  <div><Label>報名指定時間</Label><Inp type="datetime-local" value={f.submittedAt} onChange={upd('submittedAt')} /></div>
                </div>
                {numPeriods > 1 && <p className="mt-3 text-xs font-bold text-amber-600">＞6 堂：將自動拆成 {numPeriods} 張訂單（每期 6 堂）。</p>}
              </StepCard>
            </div>

            {/* 右：財務 */}
            <div className="lg:col-span-4">
              <StepCard no="03" title="財務金額與對帳" color={{ bar: 'bg-emerald-500', badge: 'bg-emerald-500/10 text-emerald-600' }}>
                <div className="space-y-4">
                  <div>
                    <Label>原始費用（原價）*</Label>
                    <div className="relative">
                      <span className="absolute inset-y-0 left-0 flex items-center pl-3.5 text-sm font-extrabold text-slate-400">$</span>
                      <input type="number" value={f.basePrice} onChange={(e) => onBase(e.target.value)} placeholder="請輸入金額"
                        className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-8 pr-3 text-sm font-black text-slate-900 outline-none focus:border-emerald-500 focus:bg-white focus:ring-4 focus:ring-emerald-500/10" />
                    </div>
                  </div>
                  <div>
                    <Label>折讓金額</Label>
                    <div className="relative">
                      <span className="absolute inset-y-0 left-0 flex items-center pl-3.5 text-sm font-extrabold text-slate-400">-$</span>
                      <input type="number" value={f.allowance} onChange={(e) => onAllowance(e.target.value)} placeholder="0"
                        className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2.5 pl-9 pr-3 text-sm font-bold text-red-600 outline-none focus:border-emerald-500 focus:bg-white focus:ring-4 focus:ring-emerald-500/10" />
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      <button type="button" onClick={() => preset('clear')} className="rounded bg-slate-100 px-2 py-1 text-[10px] font-bold text-slate-600 hover:bg-slate-200">免收</button>
                      <button type="button" onClick={() => preset(500)} className="rounded bg-red-50 px-2 py-1 text-[10px] font-bold text-red-600 hover:bg-red-100">-$500</button>
                      <button type="button" onClick={() => preset(1000)} className="rounded bg-red-50 px-2 py-1 text-[10px] font-bold text-red-600 hover:bg-red-100">-$1000</button>
                      <button type="button" onClick={() => preset('0.9')} className="rounded bg-amber-50 px-2 py-1 text-[10px] font-bold text-amber-700 hover:bg-amber-100">9折</button>
                      <button type="button" onClick={() => preset('0.95')} className="rounded bg-amber-50 px-2 py-1 text-[10px] font-bold text-amber-700 hover:bg-amber-100">95折</button>
                    </div>
                  </div>
                  <div className="my-4 h-px bg-slate-100" />
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-slate-400">實際金額（應繳）</label>
                      <div className="relative">
                        <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-xs font-black text-emerald-600">$</span>
                        <input type="number" value={f.actual} onChange={(e) => onActual(e.target.value)}
                          className="w-full rounded-xl border border-emerald-200 bg-emerald-50/40 py-2.5 pl-7 pr-2 text-sm font-black text-emerald-800 outline-none focus:border-emerald-500 focus:bg-white focus:ring-4 focus:ring-emerald-500/10" />
                      </div>
                    </div>
                    <div>
                      <label className="mb-1.5 block text-[10px] font-bold uppercase tracking-wider text-slate-400">實收單價（每堂）</label>
                      <div className="relative">
                        <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-xs font-bold text-slate-400">$</span>
                        <input type="text" value={unitPrice || ''} readOnly placeholder="自動"
                          className="w-full cursor-not-allowed rounded-xl border border-slate-200 bg-slate-100/70 py-2.5 pl-6 pr-2 text-sm font-bold text-slate-500" />
                      </div>
                    </div>
                  </div>
                  {num(f.basePrice) > 0 && (
                    <div className="flex items-center gap-1.5 rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-1.5 text-[11px] font-bold text-emerald-600">
                      <Svg d={I.check} className="h-3.5 w-3.5" /><span>對帳金額算式：原價 − 折讓 = 實收</span>
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-4">
                    <div><Label>收付方式</Label>
                      <Sel value={f.paymentMethod} onChange={upd('paymentMethod')}>
                        <option value="轉帳">銀行轉帳</option><option value="現金">現金</option><option value="信用卡">信用卡</option><option value="LINE Pay">LINE Pay</option>
                      </Sel>
                    </div>
                    <div>
                      <Label>{f.paymentMethod === '轉帳' ? '轉帳末 5 碼' : f.paymentMethod === '現金' ? '備註' : '交易末碼'}</Label>
                      <Inp value={f.paymentDetail} onChange={upd('paymentDetail')} disabled={f.paymentMethod === '現金'} placeholder={f.paymentMethod === '轉帳' ? '後 5 碼' : '對帳代碼'} className="font-mono" />
                    </div>
                  </div>
                </div>
              </StepCard>
            </div>
          </div>

          {/* 補充行政資訊（可展開） */}
          <div className="rounded-2xl border border-slate-200/80 bg-slate-50 p-5">
            <button type="button" onClick={() => setExtraOpen((v) => !v)} className="flex w-full items-center justify-between">
              <span className="flex items-center gap-2.5 text-xs font-bold tracking-wide text-slate-600"><Svg d={I.folder} className="h-4 w-4 text-slate-400" />補充行政資訊（收款人、統編、發票載具、作業型態、程度，點選展開選填）</span>
              <Svg d={I.chevron} className={`h-4 w-4 text-slate-400 transition-transform ${extraOpen ? 'rotate-180' : ''}`} />
            </button>
            {extraOpen && (
              <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-5">
                <div><Label>收款人</Label><Inp value={f.payer} onChange={upd('payer')} placeholder="行政人員" /></div>
                <div><Label>統一編號</Label><Inp value={f.taxId} onChange={upd('taxId')} placeholder="8 碼統編" className="font-mono" /></div>
                <div><Label>發票載具</Label><Inp value={f.carrier} onChange={upd('carrier')} placeholder="/ABC1234" className="font-mono" /></div>
                <div><Label>作業型態</Label><Inp value={f.workType} onChange={upd('workType')} placeholder="新報名 / 續報" /></div>
                <div><Label>程度說明</Label><Inp value={f.levelNote} onChange={upd('levelNote')} placeholder="懼水、有基礎…" /></div>
              </div>
            )}
          </div>

          {/* 動作列 */}
          <div className="flex flex-col items-center justify-between gap-4 rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm sm:flex-row">
            <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
              <Svg d={I.shield} className="h-4 w-4 shrink-0 text-amber-500" />
              <span>建檔後狀態為 <span className="rounded bg-amber-100 px-1.5 py-0.5 font-extrabold text-amber-800">待對帳</span>，沿用家長/學員可連續往下建。</span>
            </div>
            <div className="flex w-full gap-3 sm:w-auto">
              <button type="button" onClick={() => setF({ ...FRESH, submittedAt: f.submittedAt })} className="flex-1 rounded-xl border border-slate-200 bg-slate-50 px-6 py-3 text-xs font-bold text-slate-700 hover:bg-slate-100 sm:flex-initial">清空課程</button>
              <button type="button" onClick={fileOne} disabled={busy} className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-slate-900 to-indigo-950 px-8 py-3 text-xs font-extrabold text-white shadow-lg shadow-indigo-900/10 hover:from-indigo-900 hover:to-indigo-950 disabled:opacity-50 sm:flex-initial">
                <Svg d={I.userPlus} className="h-4 w-4" />{busy ? '建檔中…' : `＋ 建立本筆報名（${numPeriods} 張）`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 已建檔清單 */}
      <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm">
        <div className="flex flex-col justify-between gap-4 border-b border-slate-200/80 bg-slate-50/80 p-5 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3">
            <h2 className="text-sm font-extrabold tracking-wide text-slate-800">本次操作建檔歷程（暫存累計）</h2>
            <span className="rounded-full bg-indigo-600 px-2.5 py-0.5 text-[11px] font-black text-white">{filed.length} 筆</span>
          </div>
          {filed.length > 0 && (
            <div className="flex gap-2">
              <button onClick={exportCsv} className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50"><Svg d={I.download} className="h-3.5 w-3.5 text-emerald-600" />導出 CSV</button>
              <Link to="/reconcile" className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-bold text-slate-700 hover:bg-slate-50">前往待對帳</Link>
            </div>
          )}
        </div>
        {filed.length === 0 ? (
          <div className="py-16 text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full border border-slate-100 bg-slate-50 text-slate-400"><Svg d={I.db} className="h-6 w-6" /></div>
            <h4 className="text-sm font-bold text-slate-700">目前尚無已建檔紀錄</h4>
            <p className="mx-auto mt-1 max-w-sm text-xs text-slate-400">完成上方建檔流程後，會一筆一筆往下累加於此供複查與匯出。</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/50 text-[10px] font-bold uppercase tracking-wider text-slate-500">
                  <th className="p-4 pl-6">關聯學員</th><th className="p-4">館別 / 班別</th><th className="p-4">教練 & 堂數</th>
                  <th className="p-4">定價 / 折讓</th><th className="p-4">實收 & 單價</th><th className="p-4">付款 / 對帳</th>
                  <th className="p-4 text-center">狀態</th><th className="p-4 pr-6 text-right">移除</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 font-semibold text-slate-700">
                {filed.map((r) => (
                  <tr key={r.key} className="transition hover:bg-slate-50/80">
                    <td className="p-4 pl-6">
                      <div className="flex items-center gap-1.5 text-sm font-extrabold text-slate-950"><span className="h-1.5 w-1.5 rounded-full bg-indigo-500" />{r.students.join('、')}</div>
                      <div className="mt-1 text-[10px] text-slate-400">家長：{r.parentName}（{r.parentPhone}）· <span className="font-mono">{r.ids.join('、')}</span></div>
                    </td>
                    <td className="p-4"><span className="mb-1.5 inline-block rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-extrabold text-slate-700">{r.venue}</span><div className="text-xs font-bold text-slate-800">{r.className}</div><div className="mt-0.5 text-[10px] text-slate-400">{r.groupType}</div></td>
                    <td className="p-4"><div className="font-bold text-slate-800">{r.coach}</div><div className="mt-1 text-[10px] text-slate-400">規劃 <b className="text-slate-700">{r.lessons} 堂</b>{r.count > 1 ? ` · ${r.count} 期` : ''}</div></td>
                    <td className="p-4"><div className="text-slate-500">原價 ${r.basePrice.toLocaleString()}</div><div className="mt-0.5 text-red-500">折讓 -${r.discount.toLocaleString()}</div></td>
                    <td className="p-4"><div className="text-sm font-black text-emerald-700">${r.actual.toLocaleString()}</div><div className="mt-1 text-[10px] text-slate-400">均價 ${r.unit}/堂</div></td>
                    <td className="p-4"><div className="text-xs font-extrabold text-slate-800">{r.paymentMethod}</div><div className="mt-1 text-[10px] text-slate-400">{r.paymentDetail}</div></td>
                    <td className="p-4 text-center"><span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[10px] font-black text-amber-800"><span className="h-1 w-1 rounded-full bg-amber-500" />待對帳</span></td>
                    <td className="p-4 pr-6 text-right">
                      <button onClick={() => setFiled((p) => p.filter((x) => x.key !== r.key))} title="僅從本次清單移除，不會刪除已建檔的訂單" className="rounded-lg p-2 text-slate-400 transition hover:bg-red-50 hover:text-red-600"><Svg d={I.trash} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
