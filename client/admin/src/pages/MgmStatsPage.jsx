import React, { useEffect, useState } from 'react';
import DateTimePicker from '../../../shared/DateTimePicker.jsx';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import ExportMenu from '../components/ExportMenu';
import { useToast } from '../context/ToastContext';
import { mgmStatsApi } from '../api/mgmStats';
import { rowsToCsv, downloadCsv, downloadXlsx } from '../utils/csvExport';
import { todayISO } from '../utils/format';

const RANK_HEADERS = ['排名', '教練', '推薦總數', '已發獎勵', '轉換率'];
function rankRow(r, idx) {
  const rate = r.total ? Math.round((r.rewarded / r.total) * 1000) / 10 : 0;
  return [idx + 1, r.coach_name, r.total, r.rewarded, `${rate}%`];
}
function todayStamp() { return todayISO(); }

const STATUS_LABEL = {
  pending: '已產生連結',
  registered: '已註冊',
  trial_paid: '已下訂體驗課',
  checked_in: '已簽到',
  reward_issued: '獎勵已發放',
};

const STATUS_COLOR = {
  pending: 'bg-gray-100 text-gray-700',
  registered: 'bg-blue-50 text-blue-700',
  trial_paid: 'bg-amber-50 text-amber-700',
  checked_in: 'bg-emerald-50 text-emerald-700',
  reward_issued: 'bg-green-100 text-green-700',
};

export default function MgmStatsPage() {
  const toast = useToast();
  const [filters, setFilters] = useState({ from: '', to: '', venueId: '', coachId: '' });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  function doExport(kind) {
    if (!data || !data.coachRanking || data.coachRanking.length === 0) {
      toast.error('沒有可匯出的資料');
      return;
    }
    const rows = data.coachRanking.map((r, i) => rankRow(r, i));
    const suffix = [filters.venueId && `v${filters.venueId}`, filters.coachId && `c${filters.coachId.slice(0, 6)}`]
      .filter(Boolean).join('_');
    const base = `mgm_ranking_${filters.from || 'all'}_${filters.to || todayStamp()}${suffix ? '_' + suffix : ''}`;
    if (kind === 'csv') {
      downloadCsv(`${base}.csv`, rowsToCsv(RANK_HEADERS, rows));
    } else {
      downloadXlsx(`${base}.xlsx`, RANK_HEADERS, rows, '教練推薦排行');
    }
    toast.success(`已匯出 ${rows.length} 筆推薦排行 (${kind.toUpperCase()})`);
  }

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const params = {};
    if (filters.from) params.from = filters.from;
    if (filters.to) params.to = filters.to;
    if (filters.venueId) params.venueId = filters.venueId;
    if (filters.coachId) params.coachId = filters.coachId;
    mgmStatsApi.query(params)
      .then((d) => alive && setData(d))
      .catch(() => alive && setData(null))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [filters]);

  return (
    <div>
      <PageHeader
        title="MGM 推薦統計"
        subtitle="F-M10 · 推薦連結轉換漏斗 + 各教練被推薦次數排行"
        actions={
          <ExportMenu
            disabled={!data || !data.coachRanking || data.coachRanking.length === 0}
            onExportCsv={() => doExport('csv')}
            onExportXlsx={() => doExport('xlsx')}
          />
        }
      />

      <section className="mb-5 rounded-xl border border-gray-200 bg-white p-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Filter label="開始日期" type="date" max={filters.to || undefined} value={filters.from} onChange={(v) => setFilters((s) => ({ ...s, from: v }))} />
          <Filter label="結束日期" type="date" min={filters.from || undefined} value={filters.to} onChange={(v) => setFilters((s) => ({ ...s, to: v }))} />
          <Filter label="場館 ID（B / C / X）" value={filters.venueId} onChange={(v) => setFilters((s) => ({ ...s, venueId: v.toUpperCase() }))} />
          <Filter label="教練 UUID（選填）" value={filters.coachId} onChange={(v) => setFilters((s) => ({ ...s, coachId: v }))} />
        </div>
      </section>

      {loading ? (
        <LoadingSpinner label="載入統計…" />
      ) : !data ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">統計載入失敗，請稍後再試。</div>
      ) : (
        <>
          <section className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="推薦總數" value={data.total} accent="text-brand-primary" />
            <Stat label="已下訂體驗" value={data.byStatus.trial_paid + data.byStatus.checked_in + data.byStatus.reward_issued} accent="text-brand-teal" />
            <Stat label="獎勵已發放" value={data.byStatus.reward_issued} accent="text-brand-green" />
            <Stat label="轉換率（獎勵 / 總數）" value={`${data.conversionRate}%`} accent="text-brand-amber" />
          </section>

          <section className="mb-5 rounded-xl border border-gray-200 bg-white p-4">
            <h3 className="mb-3 text-sm font-bold text-gray-800">各狀態分布</h3>
            <div className="flex flex-wrap gap-2">
              {Object.entries(data.byStatus).map(([k, v]) => (
                <span key={k} className={`rounded-md px-2.5 py-1 text-xs font-medium ${STATUS_COLOR[k] || 'bg-gray-100 text-gray-700'}`}>
                  {STATUS_LABEL[k] || k}：{v}
                </span>
              ))}
            </div>
          </section>

          <section className="rounded-xl border border-gray-200 bg-white">
            <h3 className="border-b border-gray-100 p-4 text-sm font-bold text-gray-800">教練被推薦次數排行</h3>
            {data.coachRanking.length === 0 ? (
              <div className="p-4 text-sm text-gray-500">此期間內沒有推薦紀錄。</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="border-b border-gray-100 bg-gray-50 text-xs text-gray-500">
                  <tr>
                    <th className="px-4 py-2 text-left">#</th>
                    <th className="px-4 py-2 text-left">教練</th>
                    <th className="px-4 py-2 text-right">推薦總數</th>
                    <th className="px-4 py-2 text-right">已發獎勵</th>
                    <th className="px-4 py-2 text-right">轉換率</th>
                  </tr>
                </thead>
                <tbody>
                  {data.coachRanking.map((r, idx) => {
                    const rate = r.total ? Math.round((r.rewarded / r.total) * 1000) / 10 : 0;
                    return (
                      <tr key={r.coach_id} className="border-b border-gray-50 last:border-b-0">
                        <td className="px-4 py-2 text-gray-500">{idx + 1}</td>
                        <td className="px-4 py-2 font-medium text-gray-800">{r.coach_name}</td>
                        <td className="px-4 py-2 text-right">{r.total}</td>
                        <td className="px-4 py-2 text-right text-brand-green">{r.rewarded}</td>
                        <td className="px-4 py-2 text-right">{rate}%</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Filter({ label, value, onChange, type = 'text', min, max }) {
  // 日期走共用選擇器；其餘維持原生 input。包裝器分流比在每個呼叫端各改一次安全。
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-gray-600">{label}</span>
      {type === 'date' ? (
        <DateTimePicker value={value} min={min} max={max} onChange={onChange} clearable placeholder="不限" />
      ) : (
        <input type={type} value={value} onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-teal focus:outline-none" />
      )}
    </label>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="text-xs text-gray-500">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${accent || 'text-gray-800'}`}>{value}</div>
    </div>
  );
}
