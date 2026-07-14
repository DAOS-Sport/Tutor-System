import React, { useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import DataTable from '../components/DataTable';
import StatusBadge from '../components/StatusBadge';
import ConfirmDialog from '../components/ConfirmDialog';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { periodsApi } from '../api/periods';
import { venuesApi } from '../api/venues';
import { courseTypeLabel } from '../utils/format';

/**
 * U13 雙軌簽到 — 簽到模式管理。
 * 每一列＝一個進行中的課程期：
 *   🔵 預約制（booking，預設）＝家長先預約劃課，上課時逐堂簽到（現行流程）。
 *   🟠 自助簽到（self）＝免預約，家長上課當下按「今日上課簽到」，每日限一次、
 *      堂數上限即購買堂數；誤點由櫃檯在「簽到驗證」頁撤銷。
 * 切換：admin / manager 逐期切換，或整館一鍵批次；每次切換都寫入報名審計紀錄。
 */
const MODE_META = {
  booking: { label: '預約制', tone: 'teal' },
  self: { label: '自助簽到', tone: 'amber' },
};

export default function CheckinModesPage() {
  const toast = useToast();
  const { user } = useAuth();
  const canManage = ['admin', 'manager'].includes(user?.role);
  const [list, setList] = useState(null);
  const [venues, setVenues] = useState([]);
  const [venueId, setVenueId] = useState('');
  const [modeFilter, setModeFilter] = useState('');
  const [search, setSearch] = useState('');
  const [switchingId, setSwitchingId] = useState(null);
  const [bulk, setBulk] = useState(null); // { venueId, mode }

  async function load() {
    try {
      const [rows, vs] = await Promise.all([
        periodsApi.checkinModes({ venueId, mode: modeFilter, search: search.trim() || undefined }),
        venues.length ? Promise.resolve(venues) : venuesApi.list(),
      ]);
      setList(rows);
      if (!venues.length) setVenues(vs);
    } catch (e) {
      toast.error(e?.response?.data?.error || '載入簽到模式清單失敗');
      setList([]);
    }
  }
  useEffect(() => { setList(null); load(); }, [venueId, modeFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  async function switchMode(row) {
    const next = row.checkin_mode === 'self' ? 'booking' : 'self';
    setSwitchingId(row.id);
    try {
      await periodsApi.setCheckinMode(row.id, next);
      toast.success(`已切換為「${MODE_META[next].label}」`);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.error || '切換失敗，請稍後再試');
    } finally {
      setSwitchingId(null);
    }
  }

  async function doBulk() {
    const target = bulk;
    setBulk(null);
    try {
      const res = await periodsApi.bulkCheckinMode(target.venueId, target.mode);
      toast.success(`整館切換完成：${res.changed} 期改為「${MODE_META[target.mode].label}」`);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.error || '整館切換失敗');
    }
  }

  const venueName = (id) => venues.find((v) => v.id === id)?.name || id;
  const counts = useMemo(() => {
    const rows = list || [];
    return {
      booking: rows.filter((r) => r.checkin_mode !== 'self').length,
      self: rows.filter((r) => r.checkin_mode === 'self').length,
    };
  }, [list]);

  const columns = [
    { key: 'venue', label: '場館', render: (r) => r.venue_name || venueName(r.venue_id) },
    { key: 'coach', label: '教練', render: (r) => r.coach_name || <span className="text-gray-300">未指派</span> },
    {
      key: 'students', label: '學員',
      render: (r) => (Array.isArray(r.students) && r.students.length
        ? r.students.join('、')
        : <span className="text-gray-300">—</span>),
    },
    { key: 'course_type', label: '組別', render: (r) => courseTypeLabel(r.course_type) },
    { key: 'period', label: '期別', render: (r) => `第 ${r.period_number || 1} 期` },
    {
      key: 'usage', label: '堂數', render: (r) => (
        <span className="font-mono text-sm">{r.used_sessions || 0} / {r.total_sessions}</span>
      ),
    },
    {
      key: 'mode', label: '簽到模式',
      render: (r) => {
        const meta = MODE_META[r.checkin_mode] || MODE_META.booking;
        return (
          <div className="flex items-center gap-1.5">
            <StatusBadge tone={meta.tone}>{meta.label}</StatusBadge>
            {r.checkin_mode === 'self' && r.self_checked_in_today && (
              <span className="text-[10px] text-emerald-600">今日已簽</span>
            )}
          </div>
        );
      },
    },
    ...(canManage ? [{
      key: 'actions', label: '操作', className: 'text-right',
      render: (r) => (
        <button
          type="button"
          disabled={switchingId === r.id}
          onClick={() => switchMode(r)}
          className={`rounded-md px-3 py-1.5 text-xs font-bold text-white disabled:opacity-50 ${
            r.checkin_mode === 'self' ? 'bg-gray-500 hover:bg-gray-600' : 'bg-amber-500 hover:bg-amber-600'
          }`}
        >
          {switchingId === r.id ? '切換中…' : (r.checkin_mode === 'self' ? '改回預約制' : '改為自助簽到')}
        </button>
      ),
    }] : []),
  ];

  return (
    <div>
      <PageHeader
        title="簽到模式管理"
        subtitle="🔵 預約制＝先預約劃課再簽到（現行流程）；🟠 自助簽到＝免預約，家長上課當下簽到（每日限一次、以購買堂數為上限，誤點由櫃檯於「簽到驗證」頁撤銷）"
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select value={venueId} onChange={(e) => setVenueId(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
          <option value="">全部場館</option>
          {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <select value={modeFilter} onChange={(e) => setModeFilter(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
          <option value="">全部模式</option>
          <option value="booking">預約制</option>
          <option value="self">自助簽到</option>
        </select>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { setList(null); load(); } }}
          placeholder="搜尋教練 / 學員（Enter）"
          className="w-56 rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
        {list && (
          <span className="text-xs text-gray-500">
            預約制 {counts.booking} 期・自助簽到 {counts.self} 期
          </span>
        )}
        {canManage && venueId && (
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={() => setBulk({ venueId, mode: 'self' })}
              className="rounded-lg bg-amber-500 px-3 py-2 text-xs font-bold text-white hover:bg-amber-600"
            >
              整館改為自助簽到
            </button>
            <button
              type="button"
              onClick={() => setBulk({ venueId, mode: 'booking' })}
              className="rounded-lg bg-gray-500 px-3 py-2 text-xs font-bold text-white hover:bg-gray-600"
            >
              整館改回預約制
            </button>
          </div>
        )}
      </div>

      {!list ? (
        <LoadingSpinner fullPage />
      ) : (
        <DataTable columns={columns} rows={list} rowKey={(r) => r.id} empty="沒有符合條件的進行中課程期" />
      )}

      <ConfirmDialog
        open={!!bulk}
        title="整館批次切換"
        confirmLabel="確認切換"
        tone="danger"
        onCancel={() => setBulk(null)}
        onConfirm={doBulk}
      >
        {bulk && (
          <div className="space-y-2 text-sm">
            <p>
              即將把 <b>{venueName(bulk.venueId)}</b> 全部「進行中」課程期切換為
              <b>「{MODE_META[bulk.mode].label}」</b>。
            </p>
            <p className="text-gray-500">
              {bulk.mode === 'self'
                ? '切換後這些課程的家長不需預約，上課當下在「我的課程」按「今日上課簽到」即可（每日限一次、堂數上限＝購買堂數）。'
                : '切換後這些課程回到「先預約劃課、上課逐堂簽到」的現行流程。'}
              每期切換都會寫入審計紀錄，之後可隨時切回。
            </p>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}
