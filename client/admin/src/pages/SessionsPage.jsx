import React, { useEffect, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import DataTable from '../components/DataTable';
import StatusBadge from '../components/StatusBadge';
import { useAuth } from '../context/AuthContext';
import { sessionsApi } from '../api/sessions';
import { venuesApi } from '../api/venues';
import { courseTypeLabel, formatTWDate, checkinStatusLabel } from '../utils/format';

const CHECKIN_TONE = { checked_in: 'green', not_yet: 'gray', absent: 'error' };

export default function SessionsPage() {
  const { user, isStaff } = useAuth();
  const [list, setList] = useState(null);
  const [venues, setVenues] = useState([]);
  const [filterVenue, setFilterVenue] = useState(isStaff ? user?.venue_id || '' : '');

  async function load() {
    const venueId = isStaff ? user?.venue_id : (filterVenue || undefined);
    const [data, vs] = await Promise.all([
      sessionsApi.today(venueId),
      venuesApi.list(),
    ]);
    setList(data); setVenues(vs);
  }
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filterVenue, user, isStaff]);

  if (!list) return <LoadingSpinner fullPage />;

  const venueName = (id) => venues.find((v) => v.id === id)?.name || id;

  const columns = [
    { key: 'time', label: '時間', render: (r) => <span className="font-mono">{r.start} – {r.end}</span> },
    { key: 'venue', label: '場館', render: (r) => venueName(r.venue_id) },
    { key: 'coach', label: '教練' },
    { key: 'course_type', label: '組別', render: (r) => <StatusBadge tone="teal">{courseTypeLabel(r.course_type)}</StatusBadge> },
    { key: 'students', label: '學員', render: (r) => r.students.join('、') },
    {
      key: 'checkin_status', label: '簽到', className: 'text-center',
      render: (r) => <StatusBadge tone={CHECKIN_TONE[r.checkin_status] || 'gray'}>{checkinStatusLabel(r.checkin_status)}</StatusBadge>,
    },
  ];

  return (
    <div>
      <PageHeader
        title="今日課程"
        subtitle={`F-R01 · ${formatTWDate(new Date())}`}
        actions={
          !isStaff && (
            <select
              value={filterVenue}
              onChange={(e) => setFilterVenue(e.target.value)}
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="">全部場館</option>
              {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          )
        }
      />
      <DataTable columns={columns} rows={list} rowKey={(r) => r.id} empty="今天沒有課程" />
    </div>
  );
}
