import React from 'react';
import { formatTWD, courseTypeLabel } from '../../utils/format';

export default function EnrollmentSummary({
  venue,
  coach,
  courseType,
  periodCount = 1,
  allSelectedStudents,
  pricing,
}) {
  return (
    <ul className="space-y-1.5 text-sm">
      <li><b>場館：</b>{venue.name}</li>
      <li><b>教練：</b>{coach.name}{coach.is_senior ? '（資深）' : ''}</li>
      <li><b>組別：</b>{courseTypeLabel(courseType)}{periodCount > 1 ? ` · ${periodCount} 期` : ''}</li>
      <li>
        <b>學員：</b>
        {allSelectedStudents.map((s) => `${s.name}（${s._ownerName}）`).join('、')}
      </li>
      <li>
        <b>應繳：</b>
        <span className="font-bold text-brand-primary">{formatTWD(pricing.final)}</span>
      </li>
      <li className="text-xs text-gray-500">送出後於報名狀態頁完成轉帳並上傳證明，待櫃台確認。</li>
    </ul>
  );
}
