import React from 'react';
import { formatTWD, courseTypeLabel } from '../../utils/format';

export default function EnrollmentSummary({
  venue,
  coach,
  courseType,
  allSelectedStudents,
  pricing,
  last5,
}) {
  return (
    <ul className="space-y-1.5 text-sm">
      <li><b>場館：</b>{venue.name}</li>
      <li><b>教練：</b>{coach.name}{coach.is_senior ? '（資深）' : ''}</li>
      <li><b>組別：</b>{courseTypeLabel(courseType)}</li>
      <li>
        <b>學員：</b>
        {allSelectedStudents.map((s) => `${s.name}（${s._ownerName}）`).join('、')}
      </li>
      <li>
        <b>應繳：</b>
        <span className="font-bold text-brand-primary">{formatTWD(pricing.final)}</span>
      </li>
      <li><b>轉帳末 5 碼：</b>{last5}</li>
    </ul>
  );
}
