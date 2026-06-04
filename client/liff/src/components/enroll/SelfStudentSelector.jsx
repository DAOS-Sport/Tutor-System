import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Section, StudentRow } from './EnrollmentParts';

export default function SelfStudentSelector({
  parent,
  totalSelected,
  requiredStudentCount,
  selectedSelfStudents,
  onToggle,
}) {
  const navigate = useNavigate();
  const activeStudents = (parent.students || []).filter((s) => s?.is_active !== false);

  return (
    <Section title={`選擇學員（已選 ${totalSelected}/${requiredStudentCount}）`}>
      <p className="mb-2 text-xs text-gray-500">{parent.name}（您）名下：</p>
      {activeStudents.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-4 text-center">
          <p className="text-sm text-gray-600">您名下尚無學員，請先新增學員後再報名。</p>
          <button
            type="button"
            onClick={() => navigate('/profile')}
            className="mt-3 rounded-lg bg-brand-primary px-4 py-2 text-sm font-bold text-white active:bg-brand-teal"
          >
            前往新增學員
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {activeStudents.map((s) => (
            <StudentRow
              key={s.id}
              student={s}
              checked={selectedSelfStudents.includes(s.id)}
              onToggle={() => onToggle(s.id)}
            />
          ))}
        </div>
      )}
    </Section>
  );
}
