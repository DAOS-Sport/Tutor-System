import React from 'react';
import StatusBadge from './StatusBadge';
import { courseTypeLabel, checkinStatusLabel } from '../utils/format';

const CHECKIN_TONE = { checked_in: 'green', not_yet: 'gray', absent: 'error' };

export default function SessionDetailModal({ session, venueName, onClose }) {
  if (!session) return null;
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg bg-white shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
          <h3 className="text-base font-semibold text-brand-primary">課程詳情</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">✕</button>
        </div>
        <dl className="space-y-3 px-4 py-4 text-sm">
          <Row k="日期" v={<span className="font-mono">{session.date}</span>} />
          <Row k="時段" v={<span className="font-mono">{session.start} – {session.end}</span>} />
          <Row k="場館" v={venueName ? venueName(session.venue_id) : session.venue_id} />
          <Row k="教練" v={session.coach} />
          <Row k="組別" v={<StatusBadge tone="teal">{courseTypeLabel(session.course_type)}</StatusBadge>} />
          <Row k="學員" v={(session.students || []).join('、')} />
          <Row k="簽到" v={
            <StatusBadge tone={CHECKIN_TONE[session.checkin_status] || 'gray'}>
              {checkinStatusLabel(session.checkin_status)}
            </StatusBadge>
          } />
        </dl>
        <div className="flex justify-end border-t border-gray-100 px-4 py-3">
          <button
            onClick={onClose}
            className="rounded-md border border-gray-300 bg-white px-4 py-1.5 text-sm hover:bg-gray-50"
          >關閉</button>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }) {
  return (
    <div className="flex items-start gap-3">
      <dt className="w-14 shrink-0 text-xs text-gray-500">{k}</dt>
      <dd className="flex-1 text-gray-800">{v}</dd>
    </div>
  );
}
