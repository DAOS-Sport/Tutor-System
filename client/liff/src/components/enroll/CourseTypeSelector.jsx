import React, { useEffect } from 'react';
import { Section } from './EnrollmentParts';
import { courseTypeLabel } from '../../utils/format';

/**
 * 選擇組別 —— 下拉選單（presentational）。
 * 課程組別清單由報名頁載入並下傳（頁面同時需要 max/min 學員數），這裡只負責顯示與選取。
 */
export default function CourseTypeSelector({ types, courseType, onChange }) {
  // 若目前選的組別不在清單中（例如 type 4 停用），自動切到第一個。
  useEffect(() => {
    if (Array.isArray(types) && types.length && !types.some((t) => t.course_type === courseType)) {
      onChange(types[0].course_type);
    }
  }, [types, courseType, onChange]);

  if (!types) {
    return (
      <Section title="選擇組別">
        <div className="h-12 animate-pulse rounded-lg bg-gray-100" />
      </Section>
    );
  }

  return (
    <Section title="選擇組別">
      <select
        value={courseType}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm font-bold text-gray-800 focus:border-brand-teal focus:outline-none"
      >
        {types.map((t) => (
          <option key={t.course_type} value={t.course_type}>
            {courseTypeLabel(t.course_type)}
          </option>
        ))}
      </select>
    </Section>
  );
}
