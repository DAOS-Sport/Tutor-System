import React, { useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import DataTable from '../components/DataTable';
import StatusBadge from '../components/StatusBadge';
import VenueMultiSelect from '../components/VenueMultiSelect';
import DateRangeSelect, { rangeForPreset } from '../components/DateRangeSelect';
import WeekGridView from '../components/WeekGridView';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { sessionsApi } from '../api/sessions';
import { venuesApi } from '../api/venues';
import { courseTypeLabel, formatTWDate, checkinStatusLabel } from '../utils/format';

const CHECKIN_TONE = { checked_in: 'green', not_yet: 'gray', absent: 'error' };
const MAX_VENUES_GRID = 3;

export default function SessionsPage() {
  const { user, isStaff } = useAuth();
  const toast = useToast();
  const [view, setView] = useState('list'); // 'list' | 'week'
  const [preset, setPreset] = useState('this_week');
  const [range, setRange] = useState(() => rangeForPreset('this_week'));
  const [venueIds, setVenueIds] = useState(() => (isStaff && user?.venue_id ? [user.venue_id] : []));
  const [list, setList] = useState(null);
  const [venues, setVenues] = useState([]);

  // staff 強制鎖場館
  useEffect(() => {
    if (isStaff && user?.venue_id) setVenueIds([user.venue_id]);
  }, [isStaff, user]);

  async function load() {
    setList(null);
    const effectiveVenues = isStaff && user?.venue_id ? [user.venue_id] : venueIds;
    const [data, vs] = await Promise.all([
      sessionsApi.range({ from: range.from, to: range.to, venueIds: effectiveVenues }),
      venuesApi.list(),
    ]);
    setList(data);
    setVenues(vs);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [range.from, range.to, venueIds.join(','), user, isStaff]);

  const venueName = (id) => venues.find((v) => v.id === id)?.name || id;

  const columns = useMemo(() => [
    { key: 'date', label: '日期', render: (r) => <span className="font-mono">{r.date}</span> },
    { key: 'time', label: '時間', render: (r) => <span className="font-mono">{r.start} – {r.end}</span> },
    { key: 'venue', label: '場館', render: (r) => venueName(r.venue_id) },
    { key: 'coach', label: '教練' },
    { key: 'course_type', label: '組別', render: (r) => <StatusBadge tone="teal">{courseTypeLabel(r.course_type)}</StatusBadge> },
    { key: 'students', label: '學員', render: (r) => r.students.join('、') },
    {
      key: 'checkin_status', label: '簽到', className: 'text-center',
      render: (r) => <StatusBadge tone={CHECKIN_TONE[r.checkin_status] || 'gray'}>{checkinStatusLabel(r.checkin_status)}</StatusBadge>,
    },
  ], [venues]);

  const tooLong = view === 'week' && range.days > 31;
  const lockGridByCount = view === 'week';

  function handleVenueChange(next) {
    setVenueIds(next);
  }
  function handleVenueLimit() {
    toast.warning(`週課表最多選 ${MAX_VENUES_GRID} 館`);
  }
  function switchView(v) {
    if (v === 'week' && range.days > 31) {
      toast.warning('週課表上限 31 天，請改選較短範圍');
      return;
    }
    if (v === 'week' && venueIds.length > MAX_VENUES_GRID) {
      toast.warning(`週課表最多選 ${MAX_VENUES_GRID} 館，請先縮減場館選擇`);
      return;
    }
    setView(v);
  }

  return (
    <div>
      <PageHeader
        title="今日課程"
        subtitle={`F-R01 · ${formatTWDate(new Date())}`}
        actions={
          <div className="inline-flex overflow-hidden rounded-md border border-gray-300 text-sm">
            {[['list', '條列'], ['week', '週課表']].map(([v, label]) => (
              <button
                key={v}
                type="button"
                onClick={() => switchView(v)}
                className={`px-3 py-1.5 ${view === v ? 'bg-brand-primary text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
              >{label}</button>
            ))}
          </div>
        }
      />

      <div className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
        <DateRangeSelect
          value={preset}
          onChange={(next, r) => { setPreset(next); setRange(r); }}
        />
        <VenueMultiSelect
          venues={venues}
          value={venueIds}
          onChange={handleVenueChange}
          maxSelected={lockGridByCount ? MAX_VENUES_GRID : undefined}
          onLimit={handleVenueLimit}
          disabled={isStaff}
          label={isStaff ? '場館（鎖定本館）' : '場館'}
        />
        <div className="ml-auto text-xs text-gray-500">
          {range.from} ~ {range.to}（{range.days} 天）
          {list && <span className="ml-2 text-gray-400">共 {list.length} 筆</span>}
        </div>
      </div>

      {tooLong && view === 'week' && (
        <div className="mb-3 rounded-md border border-brand-amber/40 bg-brand-amber/10 px-3 py-2 text-sm text-brand-amber">
          範圍超過 31 天，週課表已停用，請切回條列或縮短範圍。
        </div>
      )}

      {!list ? (
        <LoadingSpinner fullPage />
      ) : view === 'week' && !tooLong ? (
        <WeekGridView
          sessions={list}
          from={range.from}
          to={range.to}
          venues={venues}
          onSelect={(s) => toast.info(`${s.date} ${s.start}-${s.end}・${venueName(s.venue_id)}・${s.coach}`)}
        />
      ) : (
        <DataTable columns={columns} rows={list} rowKey={(r) => r.id} empty="所選範圍 / 場館內沒有課程" />
      )}
    </div>
  );
}
