import React from 'react';
import { Section, StudentRow } from './EnrollmentParts';

export default function SelfStudentSelector({
  parent,
  totalSelected,
  requiredStudentCount,
  selectedSelfStudents,
  onToggle,
}) {
  return (
    <Section title={`選擇學員（已選 ${totalSelected}/${requiredStudentCount}）`}>
      <p className="mb-2 text-xs text-gray-500">{parent.name}（您）名下：</p>
      <div className="space-y-2">
        {parent.students.map((s) => (
          <StudentRow
            key={s.id}
            student={s}
            checked={selectedSelfStudents.includes(s.id)}
            onToggle={() => onToggle(s.id)}
          />
        ))}
      </div>
    </Section>
  );
}
