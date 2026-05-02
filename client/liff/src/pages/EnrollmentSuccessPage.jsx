import React from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { formatTWD, courseTypeLabel } from '../utils/format';

export default function EnrollmentSuccessPage() {
  const location = useLocation();
  const period = location.state?.period;

  if (!period) {
    return <Navigate to="/" replace />;
  }

  return (
    <div className="flex min-h-[80vh] flex-col items-center justify-center px-6 py-8 text-center">
      <div className="mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-brand-amber/15">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-brand-amber">
          <path d="M12 8v5M12 16.5v.5" strokeLinecap="round" />
          <circle cx="12" cy="12" r="9" />
        </svg>
      </div>

      <h1 className="text-xl font-bold text-brand-primary">報名成功，等待對帳</h1>
      <p className="mt-2 text-sm text-gray-600">
        我們已收到您的報名與末 5 碼，櫃檯主管確認入帳後將立即開通課程。
      </p>

      <div className="mt-5 w-full rounded-xl bg-gray-50 p-4 text-left text-sm">
        <Row label="教練" value={`${period.coach.name}${period.coach.is_senior ? '（資深）' : ''}`} />
        <Row label="場館" value={period.venue.name} />
        <Row label="組別" value={courseTypeLabel(period.course_type)} />
        <Row label="學員" value={period.students.map((s) => s.name).join('、')} />
        <Row label="應繳" value={<b className="text-brand-primary">{formatTWD(period.final_price)}</b>} />
        <Row label="末 5 碼" value={period.transfer_last_5} />
      </div>

      <Link
        to="/my-courses"
        replace
        className="mt-6 w-full rounded-lg bg-brand-primary py-3 text-base font-bold text-white active:bg-brand-teal"
      >
        前往「我的課程」
      </Link>
      <Link to="/" replace className="mt-2 text-xs text-gray-500 underline">
        返回首頁
      </Link>
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-gray-500">{label}</span>
      <span className="text-gray-900">{value}</span>
    </div>
  );
}
