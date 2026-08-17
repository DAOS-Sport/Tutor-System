import React, { useId } from 'react';
import DateTimePicker from '../../../shared/DateTimePicker.jsx';

/**
 * 通用 FilterBar — 桌機優先，欄位橫向排列；窄螢幕自動換行
 *
 * fields: [{ key, label, type, options?, placeholder?, datalist? }]
 *   - type='select'    → 純下拉
 *   - type='combo'     → 下拉 + 輸入（datalist；可自由輸入或選清單值）
 *   - type='input'     → 純文字輸入
 *   - type='radio'     → 多選一 radio group（options 必填）
 *   - type='dateRange' → 起訖日期選擇器；值存在 `${key}From` / `${key}To`
 * values:   { [key]: string }
 * onChange: (next) => void
 */
export default function FilterBar({ fields, values, onChange, onReset }) {
  const baseId = useId();
  function set(key, v) {
    onChange({ ...values, [key]: v });
  }
  const empty = Object.values(values || {}).every((v) => v === '' || v == null);

  return (
    <div className="mb-4 rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
      <div className="flex flex-wrap items-end gap-3">
        {fields.map((f) => {
          const id = `${baseId}-${f.key}`;
          const v = values?.[f.key] ?? '';

          if (f.type === 'select') {
            return (
              <div key={f.key} className="min-w-[140px]">
                <label htmlFor={id} className="mb-1 block text-xs font-medium text-gray-600">{f.label}</label>
                <select
                  id={id}
                  value={v}
                  onChange={(e) => set(f.key, e.target.value)}
                  className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm focus:border-brand-teal focus:outline-none"
                >
                  {f.options.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>
            );
          }

          if (f.type === 'combo') {
            const listId = `${id}-list`;
            return (
              <div key={f.key} className="min-w-[160px]">
                <label htmlFor={id} className="mb-1 block text-xs font-medium text-gray-600">{f.label}</label>
                <input
                  id={id}
                  list={listId}
                  value={v}
                  onChange={(e) => set(f.key, e.target.value)}
                  placeholder={f.placeholder || '可輸入或選擇'}
                  className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm focus:border-brand-teal focus:outline-none"
                />
                <datalist id={listId}>
                  {(f.options || []).map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </datalist>
              </div>
            );
          }

          if (f.type === 'input') {
            return (
              <div key={f.key} className="min-w-[140px]">
                <label htmlFor={id} className="mb-1 block text-xs font-medium text-gray-600">{f.label}</label>
                <input
                  id={id}
                  value={v}
                  onChange={(e) => set(f.key, e.target.value)}
                  placeholder={f.placeholder || ''}
                  className="w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm focus:border-brand-teal focus:outline-none"
                />
              </div>
            );
          }

          if (f.type === 'dateRange') {
            const fromKey = `${f.key}From`;
            const toKey = `${f.key}To`;
            return (
              <div key={f.key} className="min-w-[220px]">
                <label className="mb-1 block text-xs font-medium text-gray-600">{f.label}</label>
                <div className="flex items-center gap-1.5">
                  <DateTimePicker
                    id={id}
                    value={values?.[fromKey] ?? ''}
                    max={values?.[toKey] || undefined}
                    onChange={(v) => set(fromKey, v)}
                    clearable placeholder="起日"
                    className="w-full"
                  />
                  <span className="shrink-0 text-gray-400">–</span>
                  <DateTimePicker
                    value={values?.[toKey] ?? ''}
                    min={values?.[fromKey] || undefined}
                    onChange={(v) => set(toKey, v)}
                    clearable placeholder="迄日"
                    className="w-full"
                  />
                </div>
              </div>
            );
          }

          if (f.type === 'radio') {
            return (
              <div key={f.key}>
                <div className="mb-1 text-xs font-medium text-gray-600">{f.label}</div>
                <div className="flex items-center gap-3 py-1.5">
                  {f.options.map((o) => (
                    <label key={o.value} className="inline-flex items-center gap-1 text-sm">
                      <input
                        type="radio"
                        name={`${baseId}-${f.key}`}
                        value={o.value}
                        checked={v === o.value}
                        onChange={(e) => set(f.key, e.target.value)}
                        className="h-3.5 w-3.5"
                      />
                      <span>{o.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            );
          }
          return null;
        })}

        {onReset && (
          <div>
            <button
              type="button"
              onClick={onReset}
              disabled={empty}
              className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:border-brand-teal hover:text-brand-teal disabled:opacity-40"
            >
              重設
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
