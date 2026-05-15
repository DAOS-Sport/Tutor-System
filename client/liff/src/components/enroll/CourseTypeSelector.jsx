import React, { useEffect, useState } from 'react';
import { Section } from './EnrollmentParts';
import { courseTypesApi } from '../../api/courseTypes';

export default function CourseTypeSelector({ courseType, onChange }) {
  const [types, setTypes] = useState(null);

  useEffect(() => {
    let alive = true;
    courseTypesApi.listActive().then((rows) => {
      if (!alive) return;
      const list = Array.isArray(rows) && rows.length ? rows : [
        { course_type: 1, label: '一對一' },
        { course_type: 2, label: '一對二' },
        { course_type: 3, label: '一對三' },
      ];
      setTypes(list);
      if (!list.some((t) => t.course_type === courseType) && list[0]) {
        onChange(list[0].course_type);
      }
    }).catch(() => setTypes([
      { course_type: 1, label: '一對一' },
      { course_type: 2, label: '一對二' },
      { course_type: 3, label: '一對三' },
    ]));
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!types) {
    return (
      <Section title="選擇組別">
        <div className="h-12 animate-pulse rounded-lg bg-gray-100" />
      </Section>
    );
  }

  const cols = types.length <= 3 ? 'grid-cols-3' : 'grid-cols-4';

  return (
    <Section title="選擇組別">
      <div className={`grid ${cols} gap-2`}>
        {types.map((t) => (
          <button
            key={t.course_type}
            type="button"
            onClick={() => onChange(t.course_type)}
            className={`rounded-lg border-2 py-2.5 text-sm font-bold transition ${
              courseType === t.course_type
                ? 'border-brand-teal bg-brand-teal text-white'
                : 'border-gray-200 bg-white text-gray-600'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
    </Section>
  );
}
