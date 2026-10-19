import React, { useEffect, useMemo, useState } from 'react';
import LoadingSpinner from '../components/LoadingSpinner';
import { rolePermissionsApi } from '../api/rolePermissions';
import { formatTWDateTime } from '../utils/format';

/**
 * 角色權限 B 期：權限變更紀錄（唯讀）。
 *
 * 存檔是「整組取代」，原本只留最後一次是誰改的。這裡列出每一次存檔
 * 實際改了什麼：哪個角色／哪個人，哪幾頁或哪幾個動作被開通、收回。
 */
const PAGE_SIZE = 30;

const TYPE_LABEL = { role: '角色', user: '個人例外', staff_roles: '員工身分' };
const ROLE_NAME = {
  admin: '系統管理員', manager: '場館主管', staff: '行政櫃檯', coach: '教練', lifeguard: '救生員',
};

function describe(type, value) {
  if (value === null || value === undefined) return type === 'user' ? '跟隨角色' : '無';
  if (type === 'user') return value === 'allow' ? '單獨開通' : '單獨收回';
  return '有';
}

export default function PermissionAuditPanel({ resources = [], roles = [] }) {
  const [data, setData] = useState(null);
  const [offset, setOffset] = useState(0);
  const [type, setType] = useState('');
  const [err, setErr] = useState('');

  const labelOf = useMemo(() => {
    const m = {};
    for (const r of resources) m[r.key] = r.label;
    for (const r of roles) m[r.key] = r.label;
    return (k) => m[k] || ROLE_NAME[k] || k;
  }, [resources, roles]);

  useEffect(() => {
    let alive = true;
    setData(null);
    setErr('');
    rolePermissionsApi.audit({ limit: PAGE_SIZE, offset, target_type: type || undefined })
      .then((d) => { if (alive) setData(d || { total: 0, rows: [] }); })
      .catch((e) => {
        if (!alive) return;
        setData({ total: 0, rows: [] });
        setErr(e?.response?.data?.error || '載入變更紀錄失敗');
      });
    return () => { alive = false; };
  }, [offset, type]);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-xs text-gray-500">只看：</span>
        {[['', '全部'], ['role', '角色'], ['user', '個人例外'], ['staff_roles', '員工身分']].map(([k, label]) => (
          <button key={k || 'all'} type="button"
            onClick={() => { setType(k); setOffset(0); }}
            className={`rounded-full border px-3 py-1 text-xs ${
              type === k ? 'border-brand-primary bg-brand-primary/10 font-bold text-brand-primary'
                         : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
            {label}
          </button>
        ))}
      </div>

      {err && <p className="mb-3 rounded-lg bg-red-50 px-4 py-3 text-xs text-red-700">{err}</p>}
      {!data && <LoadingSpinner />}

      {data && data.rows.length === 0 && !err && (
        <p className="rounded-xl border border-dashed border-gray-300 px-6 py-12 text-center text-sm text-gray-400">
          還沒有任何權限變更紀錄
        </p>
      )}

      {data && data.rows.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-bold text-gray-500">時間</th>
                <th className="px-4 py-3 text-left text-xs font-bold text-gray-500">操作者</th>
                <th className="px-4 py-3 text-left text-xs font-bold text-gray-500">對象</th>
                <th className="px-4 py-3 text-left text-xs font-bold text-gray-500">改了什麼</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.id} className="border-t border-gray-100 align-top">
                  <td className="whitespace-nowrap px-4 py-2 text-xs text-gray-600">{formatTWDateTime(row.created_at)}</td>
                  <td className="px-4 py-2 text-xs text-gray-800">{row.actor_name}</td>
                  <td className="px-4 py-2 text-xs">
                    <div className="text-gray-400">{TYPE_LABEL[row.target_type] || row.target_type}</div>
                    <div className="font-semibold text-gray-800">
                      {row.target_label || labelOf(row.target_id)}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-xs">
                    <ul className="space-y-0.5">
                      {(row.changes || []).map((c) => {
                        const opened = row.target_type === 'user' ? c.to === 'allow' : c.to !== null;
                        return (
                          <li key={c.key}>
                            <span className={opened ? 'font-bold text-brand-green' : 'font-bold text-red-700'}>
                              {opened ? '＋' : '－'}
                            </span>{' '}
                            {labelOf(c.key)}
                            <span className="ml-1 text-gray-400">
                              （{describe(row.target_type, c.from)} → {describe(row.target_type, c.to)}）
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.total > PAGE_SIZE && (
        <div className="mt-3 flex items-center gap-3 text-xs text-gray-600">
          <button type="button" disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
            className="rounded border px-3 py-1 disabled:opacity-40">上一頁</button>
          <span>{offset + 1}–{Math.min(offset + PAGE_SIZE, data.total)} / {data.total}</span>
          <button type="button" disabled={offset + PAGE_SIZE >= data.total}
            onClick={() => setOffset(offset + PAGE_SIZE)}
            className="rounded border px-3 py-1 disabled:opacity-40">下一頁</button>
        </div>
      )}
    </div>
  );
}
