import React, { useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { rolePermissionsApi } from '../api/rolePermissions';
import { usePermissions } from '../context/PermissionContext';
import UserOverridesPanel from './UserOverridesPanel';

/**
 * F-A06 角色權限管理
 *
 * 縱軸是後台的每一個頁面（依側邊選單的分組），橫軸是角色，勾選＝看得到。
 * 系統管理員那一欄鎖住全開 —— 做成可編輯的話，有人可以在這個畫面上把自己
 * 鎖在門外，而唯一的解鎖入口正好也被鎖住了。
 */
export default function RolePermissionsPage() {
  const toast = useToast();
  const { reload: reloadMine } = usePermissions();
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState({});
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [tab, setTab] = useState('role');

  async function load() {
    setLoadError('');
    try {
      const d = await rolePermissionsApi.list();
      setData(d);
      const next = {};
      for (const r of d.roles) next[r.key] = new Set(d.matrix[r.key] || []);
      setDraft(next);
    } catch (e) {
      // data 給空結構而不是留 null：卡在 null 會讓畫面永遠轉圈，
      // 使用者連「出了什麼事」都看不到。
      setData({ resources: [], roles: [], matrix: {} });
      setLoadError(e?.response?.data?.error || '載入角色權限失敗');
    }
  }
  useEffect(() => { load(); }, []);

  const groups = useMemo(() => {
    const g = [];
    for (const r of data?.resources || []) {
      let bucket = g.find((x) => x.title === r.group);
      if (!bucket) { bucket = { title: r.group, items: [] }; g.push(bucket); }
      bucket.items.push(r);
    }
    return g;
  }, [data]);

  const dirtyRoles = useMemo(() => {
    if (!data) return [];
    return data.roles.filter((r) => {
      if (r.immutable) return false;
      const before = [...(data.matrix[r.key] || [])].sort().join(',');
      const after = [...(draft[r.key] || [])].sort().join(',');
      return before !== after;
    }).map((r) => r.key);
  }, [data, draft]);

  function toggle(roleKey, resKey) {
    setDraft((cur) => {
      const next = { ...cur };
      const s = new Set(next[roleKey] || []);
      if (s.has(resKey)) s.delete(resKey); else s.add(resKey);
      next[roleKey] = s;
      return next;
    });
  }

  function toggleGroup(roleKey, items, on) {
    setDraft((cur) => {
      const next = { ...cur };
      const s = new Set(next[roleKey] || []);
      for (const it of items) { if (on) s.add(it.key); else s.delete(it.key); }
      next[roleKey] = s;
      return next;
    });
  }

  async function save() {
    if (!dirtyRoles.length) return;
    setSaving(true);
    try {
      for (const role of dirtyRoles) {
        await rolePermissionsApi.setRole(role, [...(draft[role] || [])]);
      }
      toast.success('已更新 ' + dirtyRoles.length + ' 個角色的權限');
      await load();
      await reloadMine();
    } catch (e) {
      toast.error(e?.response?.data?.error || '儲存失敗');
    } finally {
      setSaving(false);
    }
  }

  if (!data) return <LoadingSpinner fullPage />;

  const nonBackoffice = data.roles.filter((r) => !r.backoffice);

  return (
    <div>
      <PageHeader title="角色權限管理"
        subtitle="勾選各角色看得到哪些頁面。未勾選的頁面不會出現在該角色的選單裡，也無法直接開啟。" />

      {/* 兩層：先依角色定調，再針對特定人員開例外。 */}
      <div className="mb-4 flex gap-1 border-b border-gray-200">
        {[['role', '依角色'], ['user', '個別人員例外']].map(([k, label]) => (
          <button key={k} type="button" onClick={() => setTab(k)}
            className={`-mb-px border-b-2 px-4 py-2 text-sm ${
              tab === k ? 'border-brand-primary font-bold text-brand-primary'
                        : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            {label}
          </button>
        ))}
      </div>

      {loadError && (
        <div className="mb-4 rounded-xl border border-red-200 bg-red-50 p-5">
          <div className="mb-2 text-sm font-bold text-red-700">無法載入角色權限</div>
          <p className="mb-3 text-xs leading-6 text-red-700">{loadError}</p>
          <p className="mb-4 text-xs leading-6 text-gray-600">
            若訊息是「伺服器上找不到這支 API」，代表前端已更新、但伺服器還在跑舊版程式。
            這種情況重新整理沒有用，要重新啟動或重新發布伺服器。
          </p>
          <button type="button" onClick={load}
            className="rounded-lg bg-brand-primary px-4 py-2 text-sm font-semibold text-white hover:opacity-90">
            重新載入
          </button>
        </div>
      )}

      {tab === 'user' && <UserOverridesPanel resources={data.resources} groups={groups} />}

      {tab === 'role' && nonBackoffice.length > 0 && (
        <p className="mb-4 max-w-4xl rounded-lg bg-amber-50 px-4 py-2.5 text-xs leading-6 text-amber-800">
          <strong>{nonBackoffice.map((r) => r.label).join('、')}</strong>
          目前還不能登入後台，在這裡勾選的設定會先存起來，等開放登入後才會生效。
        </p>
      )}

      {tab === 'role' && (<>
      {/* 表頭吸頂，捲到下面幾組時還看得到自己在勾哪個角色。
          寬度不設上限：先前限在 max-w-5xl（1024px），在 1687px 的螢幕上
          整張表擠在左邊、右側空掉一大片，很不協調。
          角色欄改成固定 w-40（160px）而不是百分比 —— 百分比會讓「頁面」欄
          隨視窗一起變胖（1383px 內容區時它會吃到 580px 去放一行標籤），
          而真正需要寬度的是要點的那四格。固定寬之後視窗愈寬，
          多出來的空間全部給「頁面」欄，勾選區維持在舒適的 160px。
          奇數列淡底色是用來對行的：34 個頁面 × 4 欄，
          沒有橫向參考線很容易勾到隔壁那一列。 */}
      <div className="mb-4 overflow-x-auto rounded-xl border border-gray-200 bg-white">
        <table className="w-full min-w-[600px] text-sm">
          <thead className="sticky top-0 z-10 bg-gray-50 shadow-[0_1px_0_rgba(0,0,0,0.06)]">
            <tr>
              <th className="px-4 py-3 text-left text-[13px] font-bold tracking-wide text-gray-500">頁面</th>
              {data.roles.map((r) => (
                <th key={r.key} className="w-40 px-2 py-3 text-center text-[13px] font-bold text-gray-700">
                  <div className="leading-tight">{r.label}</div>
                  <div className="mt-0.5 text-[11px] font-normal text-gray-400">
                    {r.immutable
                      ? '全開'
                      : (draft[r.key] || new Set()).size + ' / ' + data.resources.length}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <React.Fragment key={g.title}>
                <tr className="bg-gray-100/80">
                  <td className="px-4 py-2 text-[13px] font-bold tracking-wide text-gray-700">{g.title}</td>
                  {data.roles.map((r) => {
                    const s = draft[r.key] || new Set();
                    const all = g.items.every((it) => s.has(it.key));
                    return (
                      <td key={r.key} className="px-1 py-1.5 text-center">
                        {r.immutable ? <span className="text-[10px] text-gray-300">—</span> : (
                          <button type="button"
                            onClick={() => toggleGroup(r.key, g.items, !all)}
                            className="rounded px-1.5 py-0.5 text-[10px] font-medium text-brand-primary hover:bg-brand-primary/10">
                            {all ? '全不選' : '全選'}
                          </button>
                        )}
                      </td>
                    );
                  })}
                </tr>
                {g.items.map((it) => (
                  <tr key={it.key} className="border-t border-gray-100 odd:bg-gray-50/50 hover:bg-brand-primary/5">
                    {/* 路徑收進同一行：原本佔第二行，34 個頁面就多出 34 行高度，
                        捲動距離變長、對照欄位更容易看錯行。 */}
                    {/* 路徑用 11px 而不是 10px：它是拿來核對「這一列是不是我要的頁面」的，
                        10px 的等寬數字在一般螢幕上要湊近看。 */}
                    <td className="px-4 py-2">
                      <span className="text-[14px] text-gray-800">{it.label}</span>
                      <span className="ml-2 font-mono text-[11px] text-gray-400">{it.path}</span>
                    </td>
                    {data.roles.map((r) => {
                      const checked = r.immutable || (draft[r.key] || new Set()).has(it.key);
                      return (
                        <td key={r.key} className="p-0 text-center">
                          {/* 整格都是點擊區。原本只有 13px 的勾選框可以點，
                              在 34 × 5 的格子裡要精準命中很累，也容易勾錯隔壁欄。 */}
                          <label
                            className={`flex h-full w-full items-center justify-center py-1.5 ${
                              r.immutable ? 'cursor-not-allowed' : 'cursor-pointer'}`}
                            title={r.immutable ? '系統管理員永遠可見全部頁面'
                              : `${r.label}：${it.label}`}>
                            <input type="checkbox" checked={checked} disabled={r.immutable}
                              onChange={() => toggle(r.key, it.key)}
                              className={`h-4 w-4 ${r.immutable ? 'opacity-30' : 'cursor-pointer'}`} />
                          </label>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center gap-3">
        <button type="button" onClick={save} disabled={!dirtyRoles.length || saving}
          className="rounded-lg bg-brand-primary px-5 py-2 text-sm font-bold text-white disabled:opacity-40">
          {saving ? '儲存中…' : '儲存變更'}
        </button>
        <span className="text-xs text-gray-500">
          {dirtyRoles.length
            ? '未儲存：' + dirtyRoles.map((k) => data.roles.find((r) => r.key === k)?.label).join('、')
            : '沒有未儲存的變更'}
        </span>
      </div>
      </>)}
    </div>
  );
}

