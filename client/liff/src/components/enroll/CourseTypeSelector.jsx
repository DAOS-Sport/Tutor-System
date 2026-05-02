import React from 'react';
import { Section } from './EnrollmentParts';
import { courseTypeLabel } from '../../utils/format';

export default function CourseTypeSelector({ courseType, onChange }) {
  return (
    <Section title="選擇組別">
      <div className="grid grid-cols-3 gap-2">
        {[1, 2, 3].map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => onChange(t)}
            className={`rounded-lg border-2 py-2.5 text-sm font-bold transition ${
              courseType === t
                ? 'border-brand-teal bg-brand-teal text-white'
                : 'border-gray-200 bg-white text-gray-600'
            }`}
          >
            {courseTypeLabel(t)}
          </button>
        ))}
      </div>
    </Section>
  );
}
