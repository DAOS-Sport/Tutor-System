import React from 'react';

export function Section({ title, children }) {
  return (
    <div className="mb-4 rounded-xl border border-gray-200 bg-white p-3">
      <h3 className="mb-3 text-sm font-bold text-brand-primary">{title}</h3>
      {children}
    </div>
  );
}

export function Row({ label, value, valueCls = 'text-gray-900' }) {
  return (
    <div className="flex items-center justify-between py-1 text-sm">
      <span className="text-gray-600">{label}</span>
      <span className={`font-medium ${valueCls}`}>{value}</span>
    </div>
  );
}

export function StudentRow({ student, checked, onToggle }) {
  return (
    <label
      className={`flex cursor-pointer items-center justify-between rounded-lg border-2 p-3 transition ${
        checked ? 'border-brand-teal bg-brand-teal/5' : 'border-gray-200 bg-white'
      }`}
    >
      <div>
        <div className="text-sm font-bold text-gray-900">{student.name}</div>
        <div className="text-[11px] text-gray-500">{student.id_number}</div>
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="h-5 w-5 accent-brand-teal"
      />
    </label>
  );
}
