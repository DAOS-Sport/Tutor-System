import React, { useId, useState } from 'react';
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
  // 手機上預設收起來。展開狀態只影響 md 以下 —— md 以上這個 class 被
  // md:grid 蓋過去，桌機永遠是展開的橫排。
  const [open, setOpen] = useState(false);
  function set(key, v) {
    onChange({ ...values, [key]: v });
  }
  const empty = Object.values(values || {}).every((v) => v === '' || v == null);
  const activeCount = Object.values(values || {}).filter((v) => v !== '' && v != null).length;

  return (
    <div className="mb-4 rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
      {/* 手機才有的收合列。
          原本這一排在 375px 上是 flex-wrap 橫排：每個欄位保留自己的
          min-w-[140~220px] 再換行，排出來左右參差不齊，看起來像壞掉。
          而且對帳頁有 9 個欄位，展開約 700px —— 整整吃掉一個螢幕，
          資料要捲過它才看得到。
          參考蝦皮：篩選收在一個控制項後面，只在需要時展開；
          旁邊標生效中的條件數，收起來也知道現在有沒有在篩。 */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex min-h-[44px] w-full items-center justify-between gap-2 text-left md:hidden"
      >
        <span className="flex items-center gap-2 text-sm font-bold text-gray-700">
          篩選
          {activeCount > 0 && (
            <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-brand-teal px-1.5 text-[11px] font-bold text-white">
              {activeCount}
            </span>
          )}
        </span>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
             className={`shrink-0 text-gray-400 transition-transform ${open ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* 手機展開時是單欄滿版（左右各切齊一條線，不再有鋸齒）；
          md 以上回到原本的 flex 橫排，桌機一個像素都沒動。 */}
      <div className={`${open ? 'mt-3 grid' : 'hidden'} grid-cols-1 gap-3 md:mt-0 md:flex md:flex-wrap md:items-end`}>
        {fields.map((f) => {
          const id = `${baseId}-${f.key}`;
          const v = values?.[f.key] ?? '';

          if (f.type === 'select') {
            return (
              <div key={f.key} className="w-full md:w-auto md:min-w-[140px]">
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
              <div key={f.key} className="w-full md:w-auto md:min-w-[160px]">
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
              <div key={f.key} className="w-full md:w-auto md:min-w-[140px]">
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
              <div key={f.key} className="w-full md:w-auto md:min-w-[220px]">
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
          <div className="w-full md:w-auto">
            <button
              type="button"
              onClick={onReset}
              disabled={empty}
              /* py-1.5 text-xs 只有約 30px，是這一排裡最小的一顆，
                 手機上排在折行後的最末端更難按。與上面的欄位一起拉到 44px。 */
              className="inline-flex min-h-[44px] w-full items-center justify-center rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:border-brand-teal hover:text-brand-teal disabled:opacity-40 md:min-h-0 md:w-auto"
            >
              重設
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
