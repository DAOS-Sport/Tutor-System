import React, { useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import DataTable from '../components/DataTable';
import StatusBadge from '../components/StatusBadge';
import FilterBar from '../components/FilterBar';
import StaffEditModal from './StaffEditModal';
import ConfirmDialog from '../components/ConfirmDialog';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { staffApi } from '../api/staff';
import { venuesApi } from '../api/venues';
import { roleLabel } from '../utils/format';

const EMPTY_FILTERS = { status: 'all', venueId: '', name: '', role: '', phone: '', senior: '' };
const ROLE_TONE = { admin: 'primary', manager: 'teal', staff: 'gold', coach: 'green', lifeguard: 'amber' };
const MULTIPLIER_MIN = 1.00;
const MULTIPLIER_MAX = 1.50;
const HARD_DELETE_WARNING = '警告：此操作為物理級硬刪除（Hard Delete），將永久抹除本地資料庫中的員工紀錄。請確保您已在 Ragic 端同步修正或刪除了對應的髒資料，否則夜間同步時此髒資料將會再次寫入。是否確認刪除？';

/**
 * 密碼欄：眼睛圖示檢視密碼。密碼以 bcrypt 雜湊保存無法直接還原，
 * 點眼睛時由後端確認「是否仍為預設（手機號碼）」：是→顯示明碼；員工已自行改過→提示無法顯示。
 */
function PasswordCell({ row, isAdmin, onReset }) {
  const [shown, setShown] = useState(false);
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);

  async function toggle() {
    if (shown) { setShown(false); return; }
    if (!data && !busy) {
      setBusy(true);
      try { setData(await staffApi.passwordHint(row.id)); }
      catch { setData({ error: true }); }
      finally { setBusy(false); }
    }
    setShown(true);
  }

  let display = '••••••••';
  if (shown) {
    if (busy) display = '…';
    else if (!data || data.error) display = '讀取失敗';
    else if (!data.has_account) display = '無登入帳號';
    else if (data.missing_default_phone) display = '未設定手機';
    else if (data.is_default) display = data.password;
    else display = '已自行修改，無法顯示';
  }
  const revealable = !shown || (data && data.is_default);

  return (
    <div className="inline-flex items-center gap-2">
      <span className={`font-mono tracking-widest ${shown && data?.is_default ? 'text-gray-800' : 'text-gray-400'}`}>{display}</span>
      <button type="button" onClick={toggle} title={shown ? '隱藏密碼' : '檢視密碼'}
        className="text-gray-400 hover:text-brand-primary" aria-label={shown ? '隱藏密碼' : '檢視密碼'}>
        {shown && revealable ? '🙈' : '👁'}
      </button>
      {isAdmin && (
        <button type="button" onClick={() => onReset(row)}
          className="text-xs font-medium text-brand-amber hover:underline"
          title={`重設 ${row.name} 的密碼為原始密碼（手機號碼）`}>
          重設密碼
        </button>
      )}
    </div>
  );
}

function roleBadges(row) {
  const knownRoles = Array.isArray(row.known_roles) ? row.known_roles : [];
  const coachActive = row.coach_profile_status === 'active' || row.coach_active;
  const lifeguardActive = !!row.lifeguard_active;

  // A0.5：role==='staff' 常只是「沒有更精確分類」的 DB enum 保底值（roleVal 的 fallback）。
  // 若員工其實有教練/救生員等具體身分（is_coach / is_lifeguard），且 is_counter 並非 true
  // （代表根本沒偵測到櫃檯關鍵字，role='staff' 只是保底），就不該再顯示「行政櫃檯」徽章，
  // 只顯示其真正的身分；反之（is_counter===true，或完全沒有任何具體身分信號）維持原本
  // 顯示「行政櫃檯」的行為不變（一般泛用員工不受影響）。
  const hasOtherIdentity = !!row.is_coach || !!row.is_lifeguard;
  const suppressStaffBadge = row.is_counter !== true && hasOtherIdentity;

  const badges = [];
  if (!(row.role === 'staff' && suppressStaffBadge)) {
    badges.push({ role: row.role, active: true });
  }
  for (const role of knownRoles) {
    if (role === 'staff' && suppressStaffBadge) continue;
    if (!role || badges.some((b) => b.role === role)) continue;
    let active = false;
    if (role === 'coach') active = row.has_coach_profile ? coachActive : false;
    else if (role === 'lifeguard') active = lifeguardActive;
    badges.push({ role, active });
  }
  if (row.has_coach_profile && row.role !== 'coach' && !badges.some((b) => b.role === 'coach')) {
    badges.push({ role: 'coach', active: coachActive });
  }
  if (row.is_lifeguard && !badges.some((b) => b.role === 'lifeguard')) {
    badges.push({ role: 'lifeguard', active: lifeguardActive });
  }
  return badges.map(({ role, active }) => (
    <StatusBadge
      key={role}
      tone={active ? (ROLE_TONE[role] || 'gray') : 'disabledRole'}
      title={active ? undefined : `${roleLabel(role)}身分暫停保留`}
    >
      {roleLabel(role)}
    </StatusBadge>
  ));
}

export default function StaffPage() {
  const toast = useToast();
  const { isAdmin } = useAuth();
  const [staff, setStaff] = useState(null);
  const [venues, setVenues] = useState([]);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [syncing, setSyncing] = useState(false);
  const [createdHint, setCreatedHint] = useState(null);
  const [resetting, setResetting] = useState(null); // staff row pending reset confirm
  const [resetBusy, setResetBusy] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [deleting, setDeleting] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  async function confirmReset() {
    if (!resetting) return;
    setResetBusy(true);
    try {
      const r = await staffApi.resetPassword(resetting.id);
      if (r.notified) {
        toast.success(`已重設 ${r.staff_name || resetting.name} 的密碼，並已透過 LINE 通知`);
      } else {
        const hint = r.default_password_hint || resetting.phone || '手機號碼';
        toast.success(`已重設 ${r.staff_name || resetting.name} 的密碼為手機號碼（${hint}），未發送 LINE 通知，請另行告知`);
      }
      setResetting(null);
    } catch (err) {
      const msg = err?.response?.data?.error || '重設密碼失敗';
      toast.error(msg);
    } finally {
      setResetBusy(false);
    }
  }

  useEffect(() => { venuesApi.list().then(setVenues).catch(() => setVenues([])); }, []);

  function normalizeFilters(f) {
    const out = { ...f };
    if (out.venueId && venues.length) {
      const match = venues.find((v) => v.id === out.venueId || v.name === out.venueId);
      out.venueId = match ? match.id : out.venueId;
    }
    return out;
  }

  useEffect(() => {
    let cancel = false;
    staffApi.list(normalizeFilters(filters)).then((s) => { if (!cancel) setStaff(s); });
    return () => { cancel = true; };
  }, [filters, venues]);

  useEffect(() => {
    if (!Array.isArray(staff)) return;
    const visible = new Set(staff.map((row) => row.id));
    setSelectedIds((prev) => {
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [staff]);

  async function fetchStaffList() {
    const fresh = await staffApi.list(normalizeFilters(filters));
    setStaff(fresh);
    return fresh;
  }

  async function syncRagic() {
    setSyncing(true);
    try {
      const r = await staffApi.syncRagic();
      if (r.skipped) toast.info('未設定 Ragic credentials，略過');
      else {
        toast.success(`已同步 ${r.synced || 0} 筆 H01 影子資料，套用 ${r.h01_applied ?? r.staff_staged ?? 0} 筆員工更新`);
        if (Number(r.unmatched_staff_warning) > 0) {
          toast.warning(`unmatched_staff_warning=${r.unmatched_staff_warning}：H23 係數表有員工編號+姓名未精確對應，已安全跳過`, 6000);
        }
      }
      await fetchStaffList();
    } catch {
      toast.error('Ragic 同步失敗');
    } finally {
      setSyncing(false);
    }
  }

  const venueMap = useMemo(() => Object.fromEntries(venues.map((v) => [v.id, v.name])), [venues]);
  const visibleIds = useMemo(() => (staff || []).map((row) => row.id), [staff]);
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedIds.has(id));
  const [togglingId, setTogglingId] = useState(null);
  const [fieldToggling, setFieldToggling] = useState(null); // `${id}:${field}`，救生員/教練快捷開關忙碌狀態

  if (!staff) return <LoadingSpinner fullPage />;

  function toggleSelected(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAllVisible() {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) visibleIds.forEach((id) => next.delete(id));
      else visibleIds.forEach((id) => next.add(id));
      return next;
    });
  }

  function requestHardDelete(rows) {
    const list = Array.isArray(rows) ? rows.filter(Boolean) : [rows].filter(Boolean);
    if (!list.length) return;
    setDeleting({ rows: list, ids: list.map((row) => row.id) });
  }

  async function confirmHardDelete() {
    if (!deleting?.ids?.length) return;
    setDeleteBusy(true);
    try {
      const res = await staffApi.hardDelete(deleting.ids);
      const n = res?.deleted_staff_ids?.length ?? deleting.ids.length;
      toast.success(`已硬刪除 ${n} 筆員工資料`);
      setSelectedIds(new Set());
      setDeleting(null);
      await fetchStaffList();
    } catch (err) {
      toast.error(err?.response?.data?.error || '硬刪除失敗');
    } finally {
      setDeleteBusy(false);
    }
  }

  async function toggleActive(row) {
    if (togglingId === row.id) return;
    const next = !row.active;
    setStaff((arr) => arr.map((x) => (x.id === row.id ? { ...x, active: next } : x)));
    setTogglingId(row.id);
    try {
      const res = await staffApi.update(row.id, { active: next });
      setStaff((arr) => arr.map((x) => (x.id === res.id ? res : x)));
      toast.success(`已${next ? '啟用' : '停用'} ${res.name}`);
    } catch {
      setStaff((arr) => arr.map((x) => (x.id === row.id ? { ...x, active: row.active } : x)));
      toast.error('狀態切換失敗');
    } finally {
      setTogglingId(null);
    }
  }

  // C2 / 救生員快捷開關：直接切換 coach_active 或 lifeguard_active，不需開啟完整編輯彈窗。
  const FIELD_LABEL = { coach_active: '教練', lifeguard_active: '救生員' };
  async function toggleField(row, field, current) {
    const key = `${row.id}:${field}`;
    if (fieldToggling === key) return;
    const next = !current;
    setFieldToggling(key);
    try {
      const res = await staffApi.update(row.id, { [field]: next });
      setStaff((arr) => arr.map((x) => (x.id === res.id ? res : x)));
      toast.success(`已${next ? '啟用' : '停用'} ${res.name} 的${FIELD_LABEL[field] || ''}身分`);
    } catch {
      toast.error('狀態切換失敗');
    } finally {
      setFieldToggling(null);
    }
  }

  async function saveEdit() {
    if (!editing) return;
    if (editing.role === 'coach') {
      const mult = Number(editing.multiplier);
      if (Number.isNaN(mult) || mult < MULTIPLIER_MIN || mult > MULTIPLIER_MAX) {
        toast.error(`修課係數需介於 ${MULTIPLIER_MIN.toFixed(2)} – ${MULTIPLIER_MAX.toFixed(2)}（100% – 150%）`);
        return;
      }
    }
    setBusy(true);
    try {
      if (editing.isNew) {
        if (!/^[A-Z][0-9A-Z]{1,9}$/.test(String(editing.id || ''))) {
          toast.error('員工編號格式：英文字母開頭、2–10 碼英數');
          setBusy(false);
          return;
        }
        if (!editing.name?.trim()) { toast.error('姓名必填'); setBusy(false); return; }
        if (!String(editing.phone || '').trim()) {
          toast.error('手機必填，登入帳號與預設密碼會使用手機號碼');
          setBusy(false);
          return;
        }
        // 建立前確認 — 明示預設密碼規則
        const confirmMsg = `將建立員工 ${editing.name.trim()}（${editing.id}）：\n` +
          `• 角色：${roleLabel(editing.role)}\n` +
          `• 後台登入帳號：${String(editing.phone || '').trim()}\n` +
          `• 預設登入密碼 = 手機號碼（${String(editing.phone || '').trim()}），請通知該員工首次登入後立即修改\n\n確認建立？`;
        if (!window.confirm(confirmMsg)) { setBusy(false); return; }
        const venueIds = Array.isArray(editing.venue_ids)
          ? editing.venue_ids
          : (editing.venue_id ? [editing.venue_id] : []);
        const body = {
          id: editing.id, name: editing.name.trim(), role: editing.role,
          venue_ids: venueIds,
          venue_id: venueIds[0] || null,
          phone: String(editing.phone || '').trim(),
          is_senior: editing.role === 'coach' ? !!editing.is_senior : false,
          multiplier: editing.role === 'coach' ? Number(editing.multiplier || 1) : 1,
          active: editing.active !== false,
        };
        // Task #91：新建教練時若彈窗已填 coach_profile，連同 bio / specialties / email 一起送
        if (editing.role === 'coach' && editing.coach_profile) {
          body.coach_profile = {
            bio_rich_text: editing.coach_profile.bio_rich_text ?? '',
            specialties: Array.isArray(editing.coach_profile.specialties) ? editing.coach_profile.specialties : [],
            email: editing.coach_profile.email ?? '',
          };
        }
        const res = await staffApi.create(body);
        toast.success(`已建立 ${res.name}（${res.id}）`);
        setCreatedHint({
          id: res.id, name: res.name,
          username: res.login_username || res.phone || res.id,
          password: res.default_password_hint || res.phone || res.id,
        });
        const fresh = await staffApi.list(normalizeFilters(filters));
        setStaff(fresh);
        setEditing(null);
      } else {
        if (!editing.ragic_locked && !String(editing.phone || '').trim()) {
          toast.error('手機必填，登入帳號與預設密碼會使用手機號碼');
          setBusy(false);
          return;
        }
        const venueIds = Array.isArray(editing.venue_ids)
          ? editing.venue_ids
          : (editing.venue_id ? [editing.venue_id] : []);
        // Task #91：dual-role 教練（角色非 coach 但勾選 coach_active）也應同步傳 is_senior / multiplier，
        // 否則 backend 會把這些欄位歸 0 / 1，造成「兼任教練改了係數但其實沒存進去」。
        const coachIdentityOn = editing.role === 'coach' || editing.coach_active || editing.has_coach_profile;
        const patch = {
          name: editing.name,
          phone: String(editing.phone || '').trim(),
          role: editing.role,
          is_senior: coachIdentityOn ? !!editing.is_senior : false,
          multiplier: coachIdentityOn ? Number(editing.multiplier || 1) : 1,
          active: !!editing.active,
          venue_ids: venueIds,
          venue_id: venueIds[0] || null,
        };
        if (editing.role !== 'coach') patch.coach_active = !!editing.coach_active;
        // 救生員身分 is_lifeguard 為 Ragic 判定唯讀值，只有它為真時，lifeguard_active 開關才有意義。
        if (editing.is_lifeguard) patch.lifeguard_active = !!editing.lifeguard_active;
        // Task #91：若編輯彈窗動過 coach_profile，連同 bio / specialties / email 一起送
        if (editing.coach_profile && coachIdentityOn) {
          patch.coach_profile = {
            bio_rich_text: editing.coach_profile.bio_rich_text ?? '',
            specialties: Array.isArray(editing.coach_profile.specialties) ? editing.coach_profile.specialties : [],
            email: editing.coach_profile.email ?? '',
          };
          if (editing.coach_profile.intro_review_status) {
            patch.coach_profile.intro_review_status = editing.coach_profile.intro_review_status;
          }
        }
        // Task #91 fix：介紹圖順序 / 刪除一起送回（後端在同一交易內持久化）
        if (editing.bio_media_dirty && Array.isArray(editing.bio_media)) {
          patch.bio_media = editing.bio_media.map((m, i) => ({ id: m.id, sort_order: i }));
        }
        const res = await staffApi.update(editing.id, patch);
        setStaff((arr) => arr.map((x) => (x.id === res.id ? res : x)));
        toast.success(`已更新 ${res.name}`);
        setEditing(null);
      }
    } catch (err) {
      const msg = err?.response?.data?.error || (editing.isNew ? '建立失敗' : '更新失敗');
      toast.error(msg);
    } finally {
      setBusy(false);
    }
  }

  // Task #91：打開編輯時拉完整 staff detail（包含 coach_profile + bio_media）
  async function openEditor(row) {
    setEditing({ ...row });
    try {
      const detail = await staffApi.get(row.id);
      if (detail) setEditing((cur) => (cur && cur.id === row.id ? { ...cur, ...detail } : cur));
    } catch {
      // 列表已有 row 基本資料；detail 失敗仍可儲存（不阻擋）
    }
  }

  function startCreate() {
    setEditing({
      isNew: true, id: '', name: '', phone: '', role: 'staff', venue_id: '', venue_ids: [],
      is_senior: false, multiplier: 1, active: true,
    });
  }

  const columns = [
    { key: '__select', label: (
        <input
          type="checkbox"
          checked={allVisibleSelected}
          onChange={toggleSelectAllVisible}
          aria-label="全選目前列表員工"
          className="h-4 w-4 rounded border-gray-300 text-brand-primary focus:ring-brand-teal"
        />
      ),
      className: 'w-10 text-center',
      render: (r) => (
        <input
          type="checkbox"
          checked={selectedIds.has(r.id)}
          onChange={() => toggleSelected(r.id)}
          aria-label={`選取 ${r.name}`}
          className="h-4 w-4 rounded border-gray-300 text-brand-primary focus:ring-brand-teal"
        />
      ) },
    { key: 'id', label: '編號', render: (r) => <span className="font-mono text-xs text-gray-500">{r.id}</span> },
    { key: 'name', label: '姓名', render: (r) => <span className="font-medium">{r.name}</span> },
    { key: 'role', label: '角色',
      render: (r) => <div className="flex flex-wrap items-center gap-1.5">{roleBadges(r)}</div> },
    { key: 'venue_ids', label: '場館', render: (r) => {
        // Task #90：多場館 chip 顯示
        const ids = Array.isArray(r.venue_ids) && r.venue_ids.length
          ? r.venue_ids
          : (r.venue_id ? [r.venue_id] : []);
        if (!ids.length) return <span className="text-gray-300">—</span>;
        return (
          <div className="flex flex-wrap gap-1">
            {ids.map((vid) => (
              <span key={vid} className="rounded-full bg-brand-teal/10 px-2 py-0.5 text-xs font-medium text-brand-primary">
                {venueMap[vid] || vid}
              </span>
            ))}
          </div>
        );
      } },
    { key: 'phone', label: '電話' },
    { key: 'is_senior', label: '資深', className: 'text-center',
      render: (r) => r.role === 'coach'
        ? (r.is_senior ? <StatusBadge tone="gold">資深</StatusBadge> : <span className="text-gray-400">—</span>)
        : <span className="text-gray-300">N/A</span> },
    { key: 'multiplier', label: '修課係數', className: 'text-right',
      render: (r) => r.role === 'coach' ? <span className="font-mono">{Number(r.multiplier).toFixed(2)}</span> : <span className="text-gray-300">—</span> },
    { key: 'has_login_account', label: '登入帳號', className: 'text-center',
      render: (r) => r.has_login_account
        ? <StatusBadge tone={r.login_active ? 'green' : 'gray'} title={r.login_username || ''}>
            {r.login_active ? '可登入' : '已停用'}
          </StatusBadge>
        : <span className="text-gray-300 text-xs">無</span> },
    // LINE UID（辨識碼）：地端實際綁定值，比照打卡系統顯示，供與 Ragic H01「個人LINE ID」核對是否同步。
    { key: 'line_uid', label: 'LINE UID',
      render: (r) => r.line_uid
        ? <span className="font-mono text-xs text-brand-primary break-all" title={r.line_uid}>{r.line_uid}</span>
        : <span className="text-gray-300 text-xs">尚未綁定</span> },
    { key: 'has_coach_profile', label: '教練資料', className: 'text-center',
      render: (r) => {
        if (!r.has_coach_profile) return <span className="text-gray-300 text-xs">無</span>;
        const busyRow = fieldToggling === `${r.id}:coach_active`;
        return (
          <button type="button" onClick={() => toggleField(r, 'coach_active', r.coach_active)}
            disabled={busyRow}
            className="inline-block hover:opacity-80 disabled:cursor-wait disabled:opacity-60"
            title={r.coach_active ? '點擊停用教練身分' : '點擊啟用教練身分'}>
            <StatusBadge tone={r.coach_active ? 'green' : 'gray'}>
              {busyRow ? '處理中…' : (r.coach_active ? '上架中' : '已下架')}
            </StatusBadge>
          </button>
        );
      } },
    { key: 'is_lifeguard', label: '救生員', className: 'text-center',
      render: (r) => {
        if (!r.is_lifeguard) return <span className="text-gray-300 text-xs">無</span>;
        const busyRow = fieldToggling === `${r.id}:lifeguard_active`;
        return (
          <button type="button" onClick={() => toggleField(r, 'lifeguard_active', r.lifeguard_active)}
            disabled={busyRow}
            className="inline-block hover:opacity-80 disabled:cursor-wait disabled:opacity-60"
            title={r.lifeguard_active ? '點擊停用救生員身分' : '點擊啟用救生員身分'}>
            <StatusBadge tone={r.lifeguard_active ? 'green' : 'gray'}>
              {busyRow ? '處理中…' : (r.lifeguard_active ? '上架中' : '已下架')}
            </StatusBadge>
          </button>
        );
      } },
    { key: 'active', label: '狀態',
      render: (r) => {
        const busyRow = togglingId === r.id;
        const on = !!r.active;
        return (
          <div className="inline-flex items-center gap-2">
            <button type="button" onClick={() => toggleActive(r)} disabled={busyRow}
              role="switch" aria-checked={on} aria-busy={busyRow}
              aria-label={`${on ? '停用' : '啟用'} ${r.name}`}
              title={on ? '點擊停用' : '點擊啟用'}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:cursor-wait ${on ? 'bg-brand-green' : 'bg-gray-300'}`}>
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${on ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
            {busyRow && <span aria-hidden className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-gray-300 border-t-brand-primary" />}
          </div>
        );
      },
    },
    { key: 'password', label: '密碼', className: 'text-center',
      render: (r) => <PasswordCell row={r} isAdmin={isAdmin} onReset={setResetting} /> },
    { key: 'actions', label: '操作', className: 'text-right',
      render: (r) => (
        <div className="flex flex-wrap justify-end gap-2 whitespace-nowrap">
          <button className="text-xs font-medium text-brand-teal hover:underline" onClick={() => openEditor(r)}>
            編輯
          </button>
          <button className="text-xs font-bold text-brand-error hover:underline" onClick={() => requestHardDelete(r)}>
            硬刪除
          </button>
        </div>
      ) },
  ];

  const filterFields = [
    { key: 'status', label: '狀態', type: 'select', options: [
        { value: 'all', label: '全部' }, { value: 'active', label: '開啟' }, { value: 'inactive', label: '關閉' }] },
    { key: 'venueId', label: '所屬場館', type: 'combo',
      options: venues.map((v) => ({ value: v.id, label: `${v.id} ${v.name}` })), placeholder: '可輸入或選擇' },
    { key: 'name', label: '姓名', type: 'combo',
      options: (staff || []).map((s) => ({ value: s.name, label: s.name })), placeholder: '可輸入或選擇' },
    { key: 'role', label: '角色', type: 'select', options: [
        { value: '', label: '全部' }, { value: 'admin', label: '系統管理員' },
        { value: 'manager', label: '主管' }, { value: 'staff', label: '行政櫃檯' },
        { value: 'coach', label: '教練' }, { value: 'lifeguard', label: '救生員' }] },
    { key: 'phone', label: '電話', type: 'input', placeholder: '末 4 碼或全號' },
    { key: 'senior', label: '資深', type: 'radio', options: [
        { value: '', label: '不限' }, { value: 'yes', label: '是' }, { value: 'no', label: '否' }] },
  ];

  return (
    <div>
      <PageHeader
        title="員工帳號管理"
        subtitle="F-A02 · 員工 / 登入帳號 / 教練資料三表單一事實來源；新建後自動建立登入帳號"
        actions={(
          <div className="flex gap-2">
            <button type="button"
              onClick={() => requestHardDelete(staff.filter((row) => selectedIds.has(row.id)))}
              disabled={selectedIds.size === 0}
              className="rounded-lg bg-brand-error px-4 py-2 text-sm font-bold text-white hover:bg-brand-error-strong disabled:cursor-not-allowed disabled:opacity-40">
              {selectedIds.size > 0 ? `批量刪除 (${selectedIds.size})` : '批量刪除'}
            </button>
            <button type="button" onClick={startCreate}
              className="rounded-lg bg-brand-primary px-4 py-2 text-sm font-bold text-white hover:bg-brand-teal">
              ＋ 新建員工
            </button>
            <button type="button" onClick={syncRagic} disabled={syncing}
              className="rounded-lg bg-brand-teal px-4 py-2 text-sm font-bold text-white hover:bg-brand-primary disabled:opacity-50">
              {syncing ? '同步中…' : '立即同步 Ragic'}
            </button>
          </div>
        )}
      />
      <FilterBar fields={filterFields} values={filters} onChange={setFilters} onReset={() => setFilters(EMPTY_FILTERS)} />
      <DataTable columns={columns} rows={staff} rowKey={(r) => r.id} />

      <StaffEditModal
        editing={editing} setEditing={setEditing} venues={venues} busy={busy} onSave={saveEdit}
        multiplierMin={MULTIPLIER_MIN} multiplierMax={MULTIPLIER_MAX}
      />

      <ConfirmDialog
        open={!!resetting}
        title="重設員工密碼"
        confirmLabel="確認重設"
        tone="primary"
        busy={resetBusy}
        confirmDisabled={!!resetting && !String(resetting.phone || '').trim()}
        onCancel={() => !resetBusy && setResetting(null)}
        onConfirm={confirmReset}
      >
        {resetting && (
          <div className="space-y-2">
            <p>
              將把 <span className="font-bold">{resetting.name}</span>
              （編號 <span className="font-mono">{resetting.id}</span>）的後台登入密碼
              重設為手機號碼 <span className="font-mono font-bold">{resetting.phone || '未設定'}</span>。
            </p>
            {!String(resetting.phone || '').trim() && (
              <p className="rounded bg-amber-50 px-3 py-2 text-xs font-medium text-amber-800">
                此員工尚未設定手機，請先在員工頁補上手機後再重設密碼。
              </p>
            )}
            <p className="text-xs text-gray-500">
              系統會嘗試以 LINE 通知該員工（若未綁定 LINE 則略過，請改用其他方式告知）。
              請提醒對方登入後立即修改密碼。
            </p>
          </div>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={!!deleting}
        title="硬刪除員工資料"
        confirmLabel="確認無誤，強制執行"
        tone="danger"
        busy={deleteBusy}
        onCancel={() => !deleteBusy && setDeleting(null)}
        onConfirm={confirmHardDelete}
      >
        {deleting && (
          <div className="space-y-3">
            <p className="font-semibold text-brand-error">{HARD_DELETE_WARNING}</p>
            <div className="max-h-36 overflow-y-auto rounded border border-gray-200 bg-gray-50 p-2 text-xs text-gray-600">
              {deleting.rows.map((row) => (
                <div key={row.id} className="flex justify-between gap-3 py-0.5">
                  <span className="font-mono">{row.id}</span>
                  <span className="truncate">{row.name}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </ConfirmDialog>

      {createdHint && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          onClick={(e) => e.target === e.currentTarget && setCreatedHint(null)}
          role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
            <h3 className="mb-3 text-lg font-bold text-brand-green">✓ 員工已建立</h3>
            <p className="mb-2 text-sm text-gray-700">
              已為 <span className="font-bold">{createdHint.name}</span>（編號 <span className="font-mono">{createdHint.id}</span>）
              建立後台登入帳號與教練資料（若為教練）。
            </p>
            <div className="my-3 rounded-lg bg-amber-50 border border-amber-200 p-3 text-sm">
              <div className="font-medium text-amber-900">預設登入資訊</div>
              <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-amber-900">
                <span>帳號</span><span className="font-mono">{createdHint.username}</span>
                <span>密碼</span><span className="font-mono">{createdHint.password}</span>
              </div>
              <p className="mt-2 text-xs text-amber-800">請通知該員工首次登入後立即修改密碼。</p>
            </div>
            <div className="flex justify-end">
              <button onClick={() => setCreatedHint(null)}
                className="rounded-lg bg-brand-teal px-4 py-2 text-sm font-bold text-white hover:bg-brand-primary">
                知道了
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
