import React from 'react';
import { courseTypeLabel, formatTWTime } from '../../utils/format';

const STATUS_STYLES = {
  available: { bg: 'bg-emerald-50', border: 'border-emerald-200', text: 'text-emerald-800', label: '可預約' },
  booked:    { bg: 'bg-brand-primary/5', border: 'border-brand-primary/30', text: 'text-brand-primary', label: '已預約' },
  pending_group_confirm: { bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-800', label: '待確認' },
  blocked:   { bg: 'bg-gray-100', border: 'border-gray-300', text: 'text-gray-500', label: '已封鎖' },
};

/**
 * 單一槽位 chip。點擊觸發 onClick(slot) 由父層決定彈 menu。
 */
export default function SlotChip({ slot, onClick }) {
  const s = STATUS_STYLES[slot.status] || STATUS_STYLES.available;
  const end = new Date(new Date(slot.start_at).getTime() + (slot.duration_minutes || 60) * 60_000);
  return (
    <button
      type="button"
      onClick={() => onClick && onClick(slot)}
      className={`w-full rounded-lg border ${s.border} ${s.bg} px-3 py-2 text-left transition active:scale-[0.99]`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <div className={`text-sm font-bold ${s.text}`}>
          {formatTWTime(slot.start_at)} – {formatTWTime(end)}
        </div>
        <span className={`rounded-full border ${s.border} px-2 py-0.5 text-[10px] font-medium ${s.text}`}>
          {s.label}
        </span>
      </div>
      <div className="mt-1 flex items-center gap-2 text-[11px] text-gray-600">
        <span>{slot.venue_name || slot.venue_id}</span>
        {slot.course_type && (
          <>
            <span className="text-gray-300">·</span>
            <span>{courseTypeLabel(slot.course_type)}</span>
          </>
        )}
      </div>
      {slot.status === 'booked' && slot.student_names?.length > 0 && (
        <div className="mt-1 truncate text-xs text-gray-700">
          學員：{slot.student_names.join('、')}
        </div>
      )}
      {slot.notes && (
        <div className="mt-1 truncate text-[11px] text-gray-400">{slot.notes}</div>
      )}
    </button>
  );
}
