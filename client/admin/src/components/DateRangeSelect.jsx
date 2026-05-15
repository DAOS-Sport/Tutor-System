import React from 'react';

/**
 * 日期範圍預設選項：本週 / 下週 / 上週 / 整月（週日為第一天）
 * value: 'this_week' | 'next_week' | 'last_week' | 'this_month'
 * onChange: (preset, { from, to, days }) => void
 */
const PRESETS = [
  { value: 'this_week', label: '本週' },
  { value: 'next_week', label: '下週' },
  { value: 'last_week', label: '上週' },
  { value: 'this_month', label: '整月' },
];

function fmt(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// 週日 = 0；回傳 [週日, 週六] 兩端
function weekRange(base, weekOffset = 0) {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  const dow = d.getDay(); // 0..6 (Sun..Sat)
  const sun = new Date(d);
  sun.setDate(d.getDate() - dow + weekOffset * 7);
  const sat = new Date(sun);
  sat.setDate(sun.getDate() + 6);
  return [sun, sat];
}

function monthRange(base) {
  const first = new Date(base.getFullYear(), base.getMonth(), 1);
  const last = new Date(base.getFullYear(), base.getMonth() + 1, 0);
  return [first, last];
}

export function rangeForPreset(preset, base = new Date()) {
  let from; let to;
  switch (preset) {
    case 'next_week': [from, to] = weekRange(base, 1); break;
    case 'last_week': [from, to] = weekRange(base, -1); break;
    case 'this_month': [from, to] = monthRange(base); break;
    case 'this_week':
    default: [from, to] = weekRange(base, 0);
  }
  const days = Math.round((to - from) / 86400000) + 1;
  return { from: fmt(from), to: fmt(to), days };
}

export default function DateRangeSelect({ value, onChange, label = '日期範圍' }) {
  return (
    <div>
      <label className="mb-1 block text-xs font-medium text-gray-600">{label}</label>
      <select
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          onChange(next, rangeForPreset(next));
        }}
        className="rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm focus:border-brand-teal focus:outline-none"
      >
        {PRESETS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
      </select>
    </div>
  );
}
