import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import { useAuth } from '../context/AuthContext';
import { usePermissions } from '../context/PermissionContext';
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
  const { allowed, can } = usePermissions();
  const [stats, setStats] = useState(null);

  // 與 /enrollments/stats 的後端 guard 對齊：
  //   requireAnyResource('enrollments', 'refund', 'reconcile', 'manual-enroll')
  // 救生員一項都沒有 —— 不對齊的話他每天打開後台第一眼就是「部分統計暫時無法載入，
  // 請稍後再重新整理」，而那不是暫時的，是永久的：他永遠不會有那個權限。
  // 一個每天都出現、而且永遠不會好的錯誤提示，會讓人學會忽略所有錯誤提示。
  const canEnrollStats = can('enrollments') || can('refund') || can('reconcile') || can('manual-enroll');

  useEffect(() => {
    if (allowed === null) return;   // 權限還沒載到就打，會先吃一次必然的 403
    let alive = true;
    (async () => {
      // Task #90 修正：多場館櫃檯不再鎖單一主場館。不帶 venueId → 後端依 venue_ids scope
      // 統計「所屬全部場館」（原本 isStaff 帶 user.venue_id 只會統計到主場館＝新北）。
      // Task #68：改 allSettled，單支 API 失敗（如 Neon DB 連線暫斷）不會讓整頁白屏；
      // 失敗的格子改顯示 '—'。
      //
      // 這裡原本打三支：pending 清單、全部清單、今日課堂。中間那支是
      // enrollmentsApi.list({})，把正式庫 1,140 筆（含 4 個 LEFT JOIN 與 students
      // 陣列）整包拉進瀏覽器，只為了在前端 .filter() 數出 768 這個數字。
      // 改走 /enrollments/stats：同樣兩個數字在資料庫裡數完，回來的是兩個整數。
      // 順帶把三支併成兩支 —— pending 本來也是拉整份清單只取 .length。
      const [countsR, sessionsR] = await Promise.allSettled([
        // 沒權限就不要打 —— 打了一定 403，只是換來一行永遠不會好的錯誤提示。
        canEnrollStats ? enrollmentsApi.stats() : Promise.resolve(null),
        sessionsApi.today(),   // guard 是 requireResource('dashboard')，進得來就一定有
      ]);
      if (!alive) return;
      const counts = countsR.status === 'fulfilled' ? countsR.value : null;
      const sessions = sessionsR.status === 'fulfilled' ? sessionsR.value : null;
      setStats({
        // 用 counts ? 而不是 counts.pending ?：計數是 0 的時候要顯示 0，不是 '—'。
        // 「今天沒有待付款」與「這格算不出來」是兩件事，混在一起會讓櫃檯以為系統壞了。
        pending: counts ? counts.pending : '—',
        active: counts ? counts.active : '—',
        sessionsToday: sessions ? sessions.length : '—',
        sessionsCheckedIn: sessions
          ? sessions.filter((s) => s.checkin_status === 'checked_in').length
          : '—',
        // 沒權限而沒去打的，不算「載入失敗」。
        hasError: (canEnrollStats && !counts) || !sessions,
      });
    })();
    return () => { alive = false; };
  }, [user, isStaff, allowed, canEnrollStats]);

  return (
    <div>
      <PageHeader
        title={`您好，${user?.name || ''}`}
        subtitle={`目前角色：${roleLabel(user?.role)}${isStaff ? '（限您管轄的場館資料）' : ''}`}
      />
      {!stats ? (
        <LoadingSpinner />
      ) : (
        <>
          {stats.hasError && (
            <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-800">
              部分統計暫時無法載入（顯示為「—」），請稍後再重新整理。
            </div>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {/* 算不出來的格子不要顯示；連不過去的地方不要給連結 ——
                救生員原本會看到「待對帳報名 —，點擊前往對帳」，點下去被 RequireAuth 擋。
                有權限的角色（admin / 主管 / 櫃檯）四格全在，行為與先前完全相同。 */}
            {canEnrollStats && (
              <>
                <StatCard label="待對帳報名" value={stats.pending}
                  hint={can('reconcile') ? '點擊前往對帳' : undefined}
                  to={can('reconcile') ? '/reconcile' : undefined} />
                <StatCard label="進行中課程" value={stats.active} hint="confirmed + active"
                  to={can('enrollments') ? '/enrollments' : undefined} />
              </>
            )}
            <StatCard label="今日課程" value={stats.sessionsToday} hint="所有時段"
              to={can('sessions') ? '/sessions' : undefined} />
            <StatCard label="已簽到" value={stats.sessionsCheckedIn} hint="於今日課程中"
              to={can('sessions') ? '/sessions' : undefined} />
          </div>
        </>
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
