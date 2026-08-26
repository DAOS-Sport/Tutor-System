import React, { useEffect, useMemo, useState } from 'react';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { rolePermissionsApi } from '../api/rolePermissions';
import { usePermissions } from '../context/PermissionContext';

/**
 * F-A06 第二層：個別人員例外。
 *
 * ── 為什麼是三態而不是勾選框 ──
 * 例外是相對角色的差異，有三種狀態：跟隨角色、單獨開通、單獨收回。
 * 勾選框只有兩態，表達不了「沒有例外」和「例外剛好跟角色一樣」的差別 ——
 * 而那個差別很重要：日後調整角色權限時，「跟隨角色」的人會跟著變，
 * 設過例外的人不會。用勾選框做的話，管理員會以為改了角色就全部生效。
 *
 * ── 為什麼只列有登入帳號的人 ──
 * 員工四百多位，能登入後台的十幾個。沒有帳號的人沒有權限可談。
 */
const FOLLOW = 'follow';
const GRANT = 'grant';
const REVOKE = 'revoke';

export default function UserOverridesPanel({ resources, groups }) {
  const toast = useToast();
  const { reload: reloadMine } = usePermissions();
  const [users, setUsers] = useState(null);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [draft, setDraft] = useState({});     // { resource_key: FOLLOW|GRANT|REVOKE }
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    rolePermissionsApi.users()
      .then((d) => setUsers(Array.isArray(d) ? d : []))
      .catch((e) => { setUsers([]); setErr(e?.response?.data?.error || '載入帳號清單失敗'); });
  }, []);

  async function pick(id) {
    setSelected(id);
    setDetail(null);
    try {
      const d = await rolePermissionsApi.user(id);
      setDetail(d);
      const next = {};
      for (const r of resources) {
        const ov = d.overrides[r.key];
        next[r.key] = ov === undefined ? FOLLOW : (ov ? GRANT : REVOKE);
      }
      setDraft(next);
    } catch (e) {
      setErr(e?.response?.data?.error || '載入個人權限失敗');
    }
  }

  const dirty = useMemo(() => {
    if (!detail) return false;
    for (const r of resources) {
      const ov = detail.overrides[r.key];
      const was = ov === undefined ? FOLLOW : (ov ? GRANT : REVOKE);
      if (draft[r.key] !== was) return true;
    }
    return false;
  }, [detail, draft, resources]);

  async function save() {
    if (!detail || !dirty) return;
    setSaving(true);
    try {
      const overrides = {};
      for (const [k, v] of Object.entries(draft)) {
        if (v === GRANT) overrides[k] = true;
        else if (v === REVOKE) overrides[k] = false;
        // FOLLOW 就是不送 —— 沒有列＝沒有例外
      }
      await rolePermissionsApi.setUser(detail.user.id, overrides);
      toast.success(`已更新「${detail.user.name}」的個人權限`);
      await pick(detail.user.id);
      await reloadMine();
    } catch (e) {
      toast.error(e?.response?.data?.error || '儲存失敗');
    } finally {
      setSaving(false);
    }
  }

  /**
   * 模糊搜尋。比對姓名、登入帳號（＝員工編號）、角色、以及停用狀態。
   *
   * 為什麼是「每個詞都要中」而不是整串比對：櫃檯記得的往往是片段組合
   * ——「柏彥 admin」「1305 主管」——而不是完整字串。整串比對這兩種都查不到。
   * 大小寫與前後空白一律正規化：員工編號有時被記成小寫，貼上來也常帶空白。
   */
  const filtered = (() => {
    if (!users) return [];
    const terms = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return users;
    return users.filter((u) => {
      const hay = [
        u.name, u.username, u.role,
        u.is_active === false ? '已停用 停用 disabled' : '啟用中',
        u.override_count > 0 ? '例外' : '',
      ].join(' ').toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  })();

  if (!users) return <LoadingSpinner />;

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
      <div className="rounded-xl border border-gray-200 bg-white">
        <div className="border-b border-gray-100 px-4 py-3">
          <div className="mb-2 text-xs font-bold text-gray-500">
            有後台登入帳號的人（{q.trim() ? filtered.length + ' / ' + users.length : users.length}）
          </div>
          <div className="relative">
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜尋姓名 / 員工編號 / 角色"
              className="min-h-[44px] w-full rounded-lg border border-gray-300 py-2 pl-8 pr-9 text-sm focus:border-brand-teal focus:outline-none md:min-h-0"
            />
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 strokeWidth="2" strokeLinecap="round"
                 className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400">
              <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            {q && (
              <button type="button" onClick={() => setQ('')} aria-label="清除搜尋"
                className="absolute right-1 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-600">
                ✕
              </button>
            )}
          </div>
        </div>
        <ul className="max-h-[560px] overflow-y-auto">
          {filtered.length === 0 && (
            <li className="px-4 py-8 text-center text-xs text-gray-400">
              找不到符合「{q.trim()}」的人
            </li>
          )}
          {filtered.map((u) => (
            <li key={u.id}>
              <button type="button" onClick={() => pick(u.id)}
                className={`flex w-full items-center justify-between px-4 py-2.5 text-left text-sm hover:bg-gray-50 ${
                  selected === u.id ? 'bg-brand-primary/5 font-bold text-brand-primary' : ''
                }`}>
                <span className="min-w-0">
                  <span className="block truncate">{u.name}</span>
                  <span className="block truncate text-[10px] font-normal text-gray-400">
                    {u.username} · {u.role}
                    {u.is_active === false ? ' · 已停用' : ''}
                  </span>
                </span>
                {u.override_count > 0 && (
                  <span className="ml-2 shrink-0 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-bold text-amber-800">
                    {u.override_count} 例外
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div>
        {err && <p className="mb-3 rounded-lg bg-red-50 px-4 py-3 text-xs text-red-700">{err}</p>}

        {!selected && (
          <p className="rounded-xl border border-dashed border-gray-300 px-6 py-12 text-center text-sm text-gray-400">
            從左邊選一個人，設定他跟角色不一樣的地方
          </p>
        )}

        {selected && !detail && <LoadingSpinner />}

        {detail && (
          <>
            <p className="mb-3 rounded-lg bg-gray-50 px-4 py-3 text-xs leading-6 text-gray-600">
              <strong>{detail.user.name}</strong> 目前的角色是「{detail.user.role}」。
              下面每一頁預設「跟隨角色」—— 之後調整角色權限時會跟著變。
              設成開通或收回之後，這一頁就跟角色脫鉤，改角色也不會影響他。
            </p>

            <div className="mb-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
              <table className="w-full min-w-[560px] text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-bold text-gray-500">頁面</th>
                    <th className="px-3 py-3 text-center text-xs font-bold text-gray-500">角色預設</th>
                    <th className="px-3 py-3 text-center text-xs font-bold text-gray-500">這個人</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => (
                    <React.Fragment key={g.title}>
                      <tr className="bg-gray-50/70">
                        <td colSpan={3} className="px-4 py-2 text-xs font-bold text-gray-600">{g.title}</td>
                      </tr>
                      {g.items.map((it) => {
                        const roleHas = detail.role_allowed.includes(it.key);
                        const v = draft[it.key] || FOLLOW;
                        const effective = v === GRANT ? true : v === REVOKE ? false : roleHas;
                        return (
                          <tr key={it.key} className="border-t border-gray-100">
                            <td className="px-4 py-2">
                              <div className="text-gray-800">{it.label}</div>
                              <div className="font-mono text-[10px] text-gray-400">{it.path}</div>
                            </td>
                            <td className="px-3 py-2 text-center text-xs text-gray-400">
                              {roleHas ? '可見' : '不可見'}
                            </td>
                            <td className="px-3 py-2 text-center">
                              <select value={v}
                                onChange={(e) => setDraft((c) => ({ ...c, [it.key]: e.target.value }))}
                                className={`rounded-lg border px-2 py-1 text-xs ${
                                  v === FOLLOW ? 'border-gray-200 text-gray-600'
                                    : v === GRANT ? 'border-brand-green bg-brand-green/5 font-bold text-brand-green'
                                      : 'border-red-300 bg-red-50 font-bold text-red-700'
                                }`}>
                                <option value={FOLLOW}>跟隨角色（{roleHas ? '可見' : '不可見'}）</option>
                                <option value={GRANT}>單獨開通</option>
                                <option value={REVOKE}>單獨收回</option>
                              </select>
                              <div className="mt-0.5 text-[10px] text-gray-400">
                                實際：{effective ? '看得到' : '看不到'}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex items-center gap-3">
              <button type="button" onClick={save} disabled={!dirty || saving}
                className="rounded-lg bg-brand-primary px-5 py-2 text-sm font-bold text-white disabled:opacity-40">
                {saving ? '儲存中…' : '儲存變更'}
              </button>
              <span className="text-xs text-gray-500">
                {dirty ? '有未儲存的變更' : '沒有未儲存的變更'}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

