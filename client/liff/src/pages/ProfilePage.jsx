import React, { useEffect, useMemo, useState } from 'react';
import { parentsApi } from '../api/parents';
import { venuesApi } from '../api/venues';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { normalizeGender } from '../utils/format';

const BLOOD_TYPE_OPTIONS = ['A', 'B', 'O', 'AB', '不清楚'];
const emptyStudent = { name: '', id_number: '', birth_date: '', gender: '生理男', blood_type: '不清楚' };
const inputCls = 'w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand-primary';
// 漏填必填時，輸入框亮紅框
const errCls = 'border-brand-error bg-brand-error/5 focus:border-brand-error';
const fieldCls = (hasErr) => `${inputCls} ${hasErr ? errCls : ''}`;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TW_ID_RE = /^[A-Z][12]\d{8}$/;

// 家長必填欄位：姓名 / 館別 / 性別 / Email（身分欄位已移除，後端統一預設「一般身分」）
function validateParent(f) {
  const e = {};
  if (!String(f.name || '').trim()) e.name = '必填';
  if (!String(f.primary_venue_id || '').trim()) e.primary_venue_id = '必填';
  if (!String(f.gender || '').trim()) e.gender = '必填';
  if (!String(f.email || '').trim()) e.email = '必填';
  else if (!EMAIL_RE.test(f.email.trim())) e.email = 'Email 格式有誤';
  return e;
}

// 學員必填欄位：姓名 / 身分證字號 / 出生年月日
function validateStudent(f) {
  const e = {};
  if (!String(f.name || '').trim()) e.name = '必填';
  if (!String(f.id_number || '').trim()) e.id_number = '必填';
  else if (!TW_ID_RE.test(f.id_number.trim().toUpperCase())) e.id_number = '身分證格式有誤';
  if (!String(f.birth_date || '').trim()) e.birth_date = '必填';
  return e;
}

function parentFormFrom(parent) {
  return {
    name: parent?.name || '',
    phone: parent?.phone || '',
    primary_venue_id: parent?.primary_venue_id || '',
    // 身分欄位已從 UI 移除：沿用既有值，未設定時預設「一般身分」。
    identity: parent?.identity || '一般身分',
    gender: normalizeGender(parent?.gender),
    email: parent?.email || '',
    home_phone: parent?.home_phone || '',
    line_id: parent?.line_id || '',
    home_address: parent?.home_address || '',
  };
}

function syncErrMsg(e) {
  const code = e?.response?.data?.code;
  const status = e?.response?.status;
  const MAP = {
    FIELD_REQUIRED: '請完成標示 ＊ 的必填欄位',
    EMAIL_INVALID: 'Email 格式有誤',
    VENUE_NOT_FOUND: '館別不存在，請重新選擇',
    STUDENT_ID_DUPLICATED: '此身分證字號已有學員資料，請確認後再試；若需協助請聯絡客服。',
  };
  if (code && MAP[code]) return MAP[code];
  if (status === 400) return e?.response?.data?.error || '資料格式有誤，請確認後再試';
  if (status === 409) return '資料已存在，請確認後再試；若需協助請聯絡客服。';
  return '資料暫時無法儲存，請稍後再試。';
}

function normalizeBloodType(v) {
  const value = String(v || '').trim().toUpperCase();
  return BLOOD_TYPE_OPTIONS.includes(value) ? value : '不清楚';
}

export default function ProfilePage() {
  const { parent, user, setUser } = useAuth();
  const toast = useToast();
  const [profile, setProfile] = useState(parent);
  const [parentForm, setParentForm] = useState(() => parentFormFrom(parent));
  const [studentForm, setStudentForm] = useState(emptyStudent);
  const [editingId, setEditingId] = useState(null);
  const [busy, setBusy] = useState('');
  const [venues, setVenues] = useState([]);
  const [parentErrors, setParentErrors] = useState({});
  const [studentErrors, setStudentErrors] = useState({});
  // 編輯資料：橫條式折疊。先點「編輯資料」展開兩個子橫條，再各自點擊往下展開內容。
  const [editOpen, setEditOpen] = useState(false);
  const [parentOpen, setParentOpen] = useState(false);
  const [studentOpen, setStudentOpen] = useState(false);

  // 改值時即時清掉該欄的紅框
  function setParentField(key, value) {
    setParentForm((p) => ({ ...p, [key]: value }));
    setParentErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
  }
  function setStudentField(key, value) {
    setStudentForm((p) => ({ ...p, [key]: value }));
    setStudentErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
  }

  useEffect(() => {
    let alive = true;
    parentsApi.me()
      .then((data) => {
        if (!alive) return;
        setProfile(data);
        setParentForm(parentFormFrom(data));
        if (user) setUser({ ...user, data });
      })
      .catch(() => alive && toast.error('個人資料載入失敗'));
    venuesApi.list?.()
      .then((data) => alive && setVenues(Array.isArray(data) ? data : []))
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const students = useMemo(
    () => (profile?.students || []).filter((s) => s?.is_active !== false),
    [profile]
  );

  function updateAuth(nextProfile) {
    setProfile(nextProfile);
    setParentForm(parentFormFrom(nextProfile));
    if (user) setUser({ ...user, data: nextProfile });
  }

  async function saveParent(e) {
    e.preventDefault();
    const errs = validateParent(parentForm);
    if (Object.keys(errs).length) {
      setParentErrors(errs);
      toast.error('請完成標示 ＊ 的必填欄位');
      return;
    }
    setParentErrors({});
    setBusy('parent');
    try {
      const data = await parentsApi.updateMe(parentForm);
      updateAuth(data);
      toast.success('家長資料已更新');
    } catch (err) {
      toast.error(syncErrMsg(err));
    } finally {
      setBusy('');
    }
  }

  function editStudent(s) {
    setEditingId(s.id);
    setStudentErrors({});
    setStudentForm({
      name: s.name || '',
      id_number: s.id_number || '',
      birth_date: String(s.birth_date || '').slice(0, 10),
      gender: normalizeGender(s.gender) || '生理男',
      blood_type: normalizeBloodType(s.blood_type),
    });
  }

  function resetStudentForm() {
    setEditingId(null);
    setStudentForm(emptyStudent);
    setStudentErrors({});
  }

  async function saveStudent(e) {
    e.preventDefault();
    const errs = validateStudent(studentForm);
    if (Object.keys(errs).length) {
      setStudentErrors(errs);
      toast.error('請完成標示 ＊ 的必填欄位');
      return;
    }
    setStudentErrors({});
    setBusy('student');
    try {
      const saved = editingId
        ? await parentsApi.updateStudent(editingId, studentForm)
        : await parentsApi.createStudent(studentForm);
      // 擇一儲存：學員一定先存進本地 DB；sync_warning 表示雲端同步暫緩（家長資料未補齊），
      // 仍視為儲存成功並更新清單，只是改顯示警示而非綠色成功。
      const { sync_warning: syncWarning, merged_existing: mergedExisting, ...savedStudent } = saved || {};
      const hasExisting = students.some((s) => s.id === savedStudent.id);
      const nextStudents = editingId
        ? students.map((s) => (s.id === editingId ? savedStudent : s))
        : hasExisting
          ? students.map((s) => (s.id === savedStudent.id ? savedStudent : s))
          : [...students, savedStudent];
      updateAuth({ ...profile, students: nextStudents });
      resetStudentForm();
      if (syncWarning) {
        toast.warning(syncWarning);
      } else {
        toast.success(editingId || mergedExisting ? '學員資料已更新' : '學員已新增');
      }
    } catch (err) {
      toast.error(syncErrMsg(err));
    } finally {
      setBusy('');
    }
  }

  async function deactivateStudent(id) {
    if (!window.confirm('確定停用這位學員？')) return;
    setBusy(`delete:${id}`);
    try {
      await parentsApi.deleteStudent(id);
      updateAuth({ ...profile, students: students.filter((s) => s.id !== id) });
      if (editingId === id) resetStudentForm();
      toast.success('學員已停用');
    } catch (err) {
      toast.error(syncErrMsg(err));
    } finally {
      setBusy('');
    }
  }

  if (!profile) return null;

  return (
    <div className="px-4 py-4 pb-10">
      <div className="mb-4 rounded-xl bg-brand-primary p-4 text-white">
        <div className="text-xs opacity-80">家長帳號</div>
        <div className="mt-0.5 text-lg font-bold">{profile.name}</div>
        <div className="mt-1 text-xs opacity-90">{profile.phone}</div>
        {profile.email && <div className="text-xs opacity-90">{profile.email}</div>}
      </div>

      {/* 編輯資料：橫條 → 點擊展開「家長資料 / 學員資料」兩個子橫條 → 各自再點擊往下展開內容 */}
      <div className="mb-4">
        <Collapsible title="編輯資料" open={editOpen} onToggle={() => setEditOpen((o) => !o)} accent>
          <div className="space-y-2.5">
            <Collapsible title="家長資料" open={parentOpen} onToggle={() => setParentOpen((o) => !o)} nested>
              <p className="mb-2 text-[11px] text-gray-400">家長資料於註冊後鎖定為唯讀，如需修改請洽櫃台 / 客服。</p>
              <div className="grid gap-3">
                <ReadonlyField label="家長姓名" value={parentForm.name} />
                <ReadonlyField label="手機" value={parentForm.phone} />
                <ReadonlyField label="館別" value={venues.find((v) => v.id === parentForm.primary_venue_id)?.name || parentForm.primary_venue_id} />
                <ReadonlyField label="性別" value={parentForm.gender} />
                <ReadonlyField label="Email" value={parentForm.email} />
                <div className="grid grid-cols-2 gap-3">
                  <ReadonlyField label="住家電話" value={parentForm.home_phone} />
                  <ReadonlyField label="LINE ID" value={parentForm.line_id} />
                </div>
                <ReadonlyField label="住家地址" value={parentForm.home_address} />
              </div>
            </Collapsible>

            <Collapsible title="學員資料" subtitle={`共 ${students.length} 位`} open={studentOpen} onToggle={() => setStudentOpen((o) => !o)} nested>
              <div className="space-y-2">
                {students.map((s) => (
                  <div key={s.id} className="rounded-lg border border-gray-100 p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-sm font-bold text-gray-900">{s.name}</div>
                        <div className="text-xs text-gray-500">{s.id_number}</div>
                        <div className="mt-0.5 text-xs text-gray-500">{String(s.birth_date || '').slice(0, 10)}・{normalizeGender(s.gender) || '未指定'}{s.blood_type ? `・${s.blood_type}` : ''}</div>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <button type="button" onClick={() => editStudent(s)} className="rounded-md border border-gray-200 px-2.5 py-1.5 text-xs font-medium text-gray-700">編輯</button>
                        <button type="button" disabled={busy === `delete:${s.id}`} onClick={() => deactivateStudent(s.id)} className="rounded-md border border-brand-error/40 px-2.5 py-1.5 text-xs font-medium text-brand-error disabled:opacity-60">
                          {busy === `delete:${s.id}` ? '同步中' : '停用'}
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <form className="mt-3 grid gap-3 border-t border-gray-100 pt-3" onSubmit={saveStudent} noValidate>
                <h4 className="text-xs font-bold text-gray-700">{editingId ? '編輯學員' : '新增學員'}</h4>
                <Field label="姓名" required error={studentErrors.name}>
                  <input className={fieldCls(studentErrors.name)} value={studentForm.name} onChange={(e) => setStudentField('name', e.target.value)} />
                </Field>
                <Field label="身分證字號" required error={studentErrors.id_number}>
                  <input className={fieldCls(studentErrors.id_number)} value={studentForm.id_number} onChange={(e) => setStudentField('id_number', e.target.value.toUpperCase())} />
                </Field>
                <Field label="出生年月日" required error={studentErrors.birth_date}>
                  <input type="date" className={fieldCls(studentErrors.birth_date)} value={studentForm.birth_date} onChange={(e) => setStudentField('birth_date', e.target.value)} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="性別">
                    <select className={inputCls} value={studentForm.gender} onChange={(e) => setStudentField('gender', e.target.value)}>
                      <option value="生理男">生理男</option>
                      <option value="生理女">生理女</option>
                      <option value="不方便透漏">不方便透漏</option>
                    </select>
                  </Field>
                  <Field label="血型">
                    <select className={inputCls} value={studentForm.blood_type} onChange={(e) => setStudentField('blood_type', e.target.value)}>
                      {BLOOD_TYPE_OPTIONS.map((type) => (
                        <option key={type} value={type}>{type}</option>
                      ))}
                    </select>
                  </Field>
                </div>
                <div className="flex gap-2">
                  <button type="submit" disabled={!!busy} className="flex-1 rounded-lg bg-brand-primary py-2.5 text-sm font-bold text-white disabled:opacity-60">
                    {busy === 'student' ? '同步中...' : (editingId ? '儲存學員' : '新增學員')}
                  </button>
                  {editingId && (
                    <button type="button" onClick={resetStudentForm} className="rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-700">取消</button>
                  )}
                </div>
              </form>
            </Collapsible>
          </div>
        </Collapsible>
      </div>

      <p className="px-1 pb-2 text-[11px] text-gray-400">
        本系統保留師生對話記錄供場館管理使用。
      </p>
    </div>
  );
}

// 橫條式折疊：點標題列展開／收合內容。accent＝最外層（左側主色條、字較大）；nested＝子層（較精簡）。
function Collapsible({ title, subtitle, open, onToggle, accent, nested, children }) {
  return (
    <div className={`overflow-hidden rounded-xl border bg-white ${open ? 'border-brand-primary/30' : 'border-gray-200'}`}>
      <button
        type="button"
        onClick={onToggle}
        className={`flex w-full items-center justify-between gap-2 px-4 text-left active:bg-gray-50 ${nested ? 'py-2.5' : 'py-3.5'}`}
      >
        <span className="flex min-w-0 items-center gap-2">
          {accent && <span className="h-4 w-1 shrink-0 rounded-full bg-brand-primary" />}
          <span className={`truncate font-bold text-brand-primary ${nested ? 'text-sm' : 'text-base'}`}>{title}</span>
          {subtitle && <span className="shrink-0 text-xs font-normal text-gray-400">{subtitle}</span>}
        </span>
        <ChevronIcon className={`shrink-0 text-gray-400 transition ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="border-t border-gray-100 px-3 py-3">{children}</div>}
    </div>
  );
}

function ChevronIcon({ className = '' }) {
  return (
    <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

// 唯讀欄位：標籤 + 灰底唯讀值（家長資料註冊後鎖定使用）。
function ReadonlyField({ label, value }) {
  return (
    <div className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600">{label}</span>
      <div className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-700">{value || '—'}</div>
    </div>
  );
}

function Field({ label, required, error, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600">
        {label}{required && <span className="ml-0.5 font-bold text-brand-error">＊</span>}
      </span>
      {children}
      {error && <span className="mt-1 block text-[11px] font-medium text-brand-error">{error}</span>}
    </label>
  );
}
