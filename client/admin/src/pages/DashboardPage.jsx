import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import { useAuth } from '../context/AuthContext';
import { enrollmentsApi } from '../api/enrollments';
import { sessionsApi } from '../api/sessions';
import { roleLabel } from '../utils/format';

function StatCard({ label, value, hint, to }) {
  const card = (
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm transition hover:shadow-md">
      <div className="text-xs font-medium text-gray-500">{label}</div>
      <div className="mt-2 text-3xl font-bold text-brand-primary">{value}</div>
      {hint && <div className="mt-1 text-xs text-gray-400">{hint}</div>}
    </div>
  );
  return to ? <Link to={to}>{card}</Link> : card;
}

export default function DashboardPage() {
  const { user, isStaff } = useAuth();
  const [stats, setStats] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const venueId = isStaff ? user?.venue_id : undefined;
      const [pending, all, sessions] = await Promise.all([
        enrollmentsApi.list({ status: 'pending_payment', venueId }),
        enrollmentsApi.list({ venueId }),
        sessionsApi.today(venueId),
      ]);
      if (!alive) return;
      setStats({
        pending: pending.length,
        active: all.filter((e) => e.status === 'active' || e.status === 'confirmed').length,
        sessionsToday: sessions.length,
        sessionsCheckedIn: sessions.filter((s) => s.checkin_status === 'checked_in').length,
      });
    })();
    return () => { alive = false; };
  }, [user, isStaff]);

  return (
    <div>
      <PageHeader
        title={`您好，${user?.name || ''}`}
        subtitle={`目前角色：${roleLabel(user?.role)}${isStaff ? '（限本場館資料）' : ''}`}
      />
      {!stats ? (
        <LoadingSpinner />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="待對帳報名" value={stats.pending} hint="點擊前往對帳" to="/reconcile" />
          <StatCard label="進行中課程" value={stats.active} hint="confirmed + active" to="/enrollments" />
          <StatCard label="今日課程" value={stats.sessionsToday} hint="所有時段" to="/sessions" />
          <StatCard label="已簽到" value={stats.sessionsCheckedIn} hint="於今日課程中" to="/sessions" />
        </div>
      )}

      <div className="mt-8 rounded-xl border border-dashed border-gray-300 bg-white p-5 text-sm text-gray-600">
        <div className="mb-2 font-bold text-gray-700">小提醒</div>
        <ul className="list-disc space-y-1 pl-5">
          <li>不同角色於左側 Sidebar 看到的功能項目不同，<b>RequireAuth</b> 也會擋 URL 直接拜訪。</li>
          <li>櫃檯（staff）僅能看到本場館範圍的報名 / 課程資料；主管 / 管理員可跨場館。</li>
        </ul>
      </div>
    </div>
  );
}
