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
// 三種輸入控制項（select / combo / input）原本都是 `px-2 py-1.5 text-sm`，實高約 34px。
// 375px 上這排欄位會 flex-wrap 折成好幾列、上下相黏，34px 的命中區用手指（池畔還是濕的）
// 點不準，很容易落到隔壁列的欄位。md 以下拉到 44px；桌機使用者一次要掃很多列，
// 拉高會讓每頁看到的資料變少，所以 md 以上用 min-h-0 退回原本的密度。
const CONTROL_CLS = 'w-full min-h-[44px] rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm focus:border-brand-teal focus:outline-none md:min-h-0';

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
                  className={CONTROL_CLS}
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
                  className={CONTROL_CLS}
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
                  className={CONTROL_CLS}
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
              /* py-1.5 text-xs 只有約 30px，是這一排裡最小的一顆，
                 手機上排在折行後的最末端更難按。與上面的欄位一起拉到 44px。 */
              className="inline-flex min-h-[44px] items-center justify-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:border-brand-teal hover:text-brand-teal disabled:opacity-40 md:min-h-0"
            >
              重設
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
