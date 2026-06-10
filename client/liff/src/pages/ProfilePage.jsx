import React, { useEffect, useMemo, useState } from 'react';
import { parentsApi } from '../api/parents';
import { venuesApi } from '../api/venues';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

const emptyStudent = { name: '', id_number: '', birth_date: '', gender: '男', blood_type: '' };
const inputCls = 'w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-brand-primary';

function parentFormFrom(parent) {
  return {
    name: parent?.name || '',
    phone: parent?.phone || '',
    primary_venue_id: parent?.primary_venue_id || '',
    identity: parent?.identity || '',
    gender: parent?.gender || '',
    email: parent?.email || '',
    home_phone: parent?.home_phone || '',
    line_id: parent?.line_id || '',
    home_address: parent?.home_address || '',
  };
}

// Ragic 同步失敗時，盡量把後端的真實原因顯示出來，方便家長回報 / 排查
function syncErrMsg(e) {
  const d = e?.response?.data;
  return d?.detail || d?.error || 'Ragic 同步失敗，請稍後再試';
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
    setStudentForm({
      name: s.name || '',
      id_number: s.id_number || '',
      birth_date: String(s.birth_date || '').slice(0, 10),
      gender: s.gender || '男',
      blood_type: s.blood_type || '',
    });
  }

  function resetStudentForm() {
    setEditingId(null);
    setStudentForm(emptyStudent);
  }

  async function saveStudent(e) {
    e.preventDefault();
    setBusy('student');
    try {
      const saved = editingId
        ? await parentsApi.updateStudent(editingId, studentForm)
        : await parentsApi.createStudent(studentForm);
      const nextStudents = editingId
        ? students.map((s) => (s.id === editingId ? saved : s))
        : [...students, saved];
      updateAuth({ ...profile, students: nextStudents });
      resetStudentForm();
      toast.success(editingId ? '學員資料已更新' : '學員已新增');
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

      <Section title="編輯資料">
        <form className="grid gap-3" onSubmit={saveParent}>
          <Field label="家長姓名">
            <input className={inputCls} value={parentForm.name} onChange={(e) => setParentForm({ ...parentForm, name: e.target.value })} required />
          </Field>
          <Field label="手機">
            <input className={`${inputCls} bg-gray-50 text-gray-500`} value={parentForm.phone} readOnly />
          </Field>
          <Field label="館別">
            <select className={inputCls} value={parentForm.primary_venue_id || ''} onChange={(e) => setParentForm({ ...parentForm, primary_venue_id: e.target.value })}>
              <option value="">未指定</option>
              {venues.map((v) => <option key={v.id} value={v.id}>{v.name || v.id}</option>)}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="身分">
              <input className={inputCls} value={parentForm.identity} onChange={(e) => setParentForm({ ...parentForm, identity: e.target.value })} />
            </Field>
            <Field label="性別">
              <select className={inputCls} value={parentForm.gender || ''} onChange={(e) => setParentForm({ ...parentForm, gender: e.target.value })}>
                <option value="">未指定</option>
                <option value="男">男</option>
                <option value="女">女</option>
              </select>
            </Field>
          </div>
          <Field label="Email">
            <input type="email" className={inputCls} value={parentForm.email} onChange={(e) => setParentForm({ ...parentForm, email: e.target.value })} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="住家電話">
              <input className={inputCls} value={parentForm.home_phone} onChange={(e) => setParentForm({ ...parentForm, home_phone: e.target.value })} />
            </Field>
            <Field label="LINE ID">
              <input className={inputCls} value={parentForm.line_id} onChange={(e) => setParentForm({ ...parentForm, line_id: e.target.value })} />
            </Field>
          </div>
          <Field label="住家地址">
            <input className={inputCls} value={parentForm.home_address} onChange={(e) => setParentForm({ ...parentForm, home_address: e.target.value })} />
          </Field>
          <button type="submit" disabled={!!busy} className="rounded-lg bg-brand-primary py-2.5 text-sm font-bold text-white disabled:opacity-60">
            {busy === 'parent' ? '同步中...' : '儲存家長資料'}
          </button>
        </form>
      </Section>

      <Section title={`學員清單（${students.length}）`}>
        <div className="space-y-2">
          {students.map((s) => (
            <div key={s.id} className="rounded-lg border border-gray-100 p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-bold text-gray-900">{s.name}</div>
                  <div className="text-xs text-gray-500">{s.id_number}</div>
                  <div className="mt-0.5 text-xs text-gray-500">{String(s.birth_date || '').slice(0, 10)}・{s.gender || '未指定'}{s.blood_type ? `・${s.blood_type}` : ''}</div>
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

        <form className="mt-3 grid gap-3 border-t border-gray-100 pt-3" onSubmit={saveStudent}>
          <h4 className="text-xs font-bold text-gray-700">{editingId ? '編輯學員' : '新增學員'}</h4>
          <Field label="姓名">
            <input className={inputCls} value={studentForm.name} onChange={(e) => setStudentForm({ ...studentForm, name: e.target.value })} required />
          </Field>
          <Field label="身分證字號">
            <input className={inputCls} value={studentForm.id_number} onChange={(e) => setStudentForm({ ...studentForm, id_number: e.target.value.toUpperCase() })} required />
          </Field>
          <Field label="出生年月日">
            <input type="date" className={inputCls} value={studentForm.birth_date} onChange={(e) => setStudentForm({ ...studentForm, birth_date: e.target.value })} required />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="性別">
              <select className={inputCls} value={studentForm.gender} onChange={(e) => setStudentForm({ ...studentForm, gender: e.target.value })}>
                <option value="男">男</option>
                <option value="女">女</option>
              </select>
            </Field>
            <Field label="血型">
              <input className={inputCls} value={studentForm.blood_type} onChange={(e) => setStudentForm({ ...studentForm, blood_type: e.target.value })} />
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
      </Section>

      <p className="px-1 pb-2 text-[11px] text-gray-400">
        本系統保留師生對話記錄供場館管理使用。
      </p>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="mb-4 rounded-xl border border-gray-200 bg-white p-3">
      <h3 className="mb-2 text-xs font-bold text-brand-primary">{title}</h3>
      {children}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600">{label}</span>
      {children}
    </label>
  );
}
