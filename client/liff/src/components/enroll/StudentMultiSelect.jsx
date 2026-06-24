import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Section, StudentRow } from './EnrollmentParts';

/**
 * 報名「選擇學員」——可展開的下拉勾選清單（複選）。
 * 收合時顯示已選人數/姓名摘要；展開後沿用既有 StudentRow 勾選卡片。
 * 人數規則由 min/max 控制：1對N 須剛好填滿 N 位（min=max=courseType）。
 */
export default function StudentMultiSelect({
  parent,
  selectedSelfStudents,
  minStudents,
  maxStudents,
  onToggle,
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const activeStudents = (parent.students || []).filter((s) => s?.is_active !== false);
  const selectedNames = activeStudents
    .filter((s) => selectedSelfStudents.includes(s.id))
    .map((s) => s.name);
  const rangeLabel = minStudents === maxStudents ? `${maxStudents} 位` : `${minStudents}~${maxStudents} 位`;
  const summary = selectedNames.length
    ? `已選 ${selectedNames.length} 位：${selectedNames.join('、')}`
    : '點此選擇學員';

  return (
    <Section title={`選擇學員（需 ${rangeLabel}）`}>
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
        <div>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex w-full items-center justify-between rounded-lg border border-gray-300 px-3 py-2.5 text-left text-sm"
          >
            <span className={selectedNames.length ? 'font-medium text-gray-900' : 'text-gray-400'}>{summary}</span>
            <span className={`ml-2 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
          </button>
          {open && (
            <div className="mt-2 space-y-2">
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
        </div>
      )}
    </Section>
  );
}
