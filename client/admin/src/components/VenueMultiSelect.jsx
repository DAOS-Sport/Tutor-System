import React, { useEffect, useRef, useState } from 'react';

/**
 * 場館多選下拉（checkbox 形式）
 *
 * Props:
 *   venues:      [{ id, name }]
 *   value:       string[]  選中的 venue id 陣列；空陣列 = 全部場館
 *   onChange:    (next: string[]) => void
 *   maxSelected: number?  上限（超過時不接受新增，由外層 toast 提示並回滾）
 *   onLimit:     () => void  超過上限時的 callback
 *   disabled:    boolean
 *   label:       string
 */
export default function VenueMultiSelect({
  venues, value, onChange, maxSelected, onLimit, disabled, label = '場館',
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const summary = !value || value.length === 0
    ? '全部場館'
    : value.length === 1
      ? (venues.find((v) => v.id === value[0])?.name || value[0])
      : `${value.length} 個場館`;

  function toggle(id) {
    const has = value.includes(id);
    if (has) {
      onChange(value.filter((x) => x !== id));
      return;
    }
    if (maxSelected && value.length >= maxSelected) {
      onLimit && onLimit();
      return;
    }
    onChange([...value, id]);
  }

  return (
    <div className="relative" ref={ref}>
      <label className="mb-1 block text-xs font-medium text-gray-600">{label}</label>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        /* 原本在 375px：這顆是 <button>（inline-block、內容寬），只有 min-w-[160px]
           當下限，所以寬度隨場館名長短浮動，右緣跟隔壁的日期欄對不齊。
           手機改成撐滿整格；md 以上 w-auto 就是原本的 width:auto，桌機沒動。 */
        className="min-h-[44px] w-full min-w-[160px] rounded-md border border-gray-300 bg-white px-3 py-1.5 text-left text-sm md:min-h-0 md:w-auto hover:border-brand-teal disabled:bg-gray-50 disabled:text-gray-400"
      >
        {summary}
        <span className="ml-2 text-gray-400">▾</span>
      </button>
      {open && !disabled && (
        /* 觸發鈕在手機上已經撐滿整格，面板留在 w-64（256px）會比觸發鈕窄一截、
           左靠著浮在半空中。手機跟著撐滿，md 以上 w-64 原封不動。 */
        <div className="absolute left-0 top-full z-20 mt-1 max-h-72 w-full overflow-auto rounded-md border border-gray-200 bg-white shadow-lg md:w-64">
          <button
            type="button"
            onClick={() => onChange([])}
            className="block w-full border-b border-gray-100 px-3 py-2 text-left text-xs text-gray-500 hover:bg-gray-50"
          >
            清除（= 全部場館）
          </button>
          {venues.map((v) => {
            const checked = value.includes(v.id);
            return (
              <label
                key={v.id}
                className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm hover:bg-gray-50"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(v.id)}
                  className="h-4 w-4"
                />
                <span>{v.name}</span>
                <span className="ml-auto text-xs text-gray-400">{v.id}</span>
              </label>
            );
          })}
          {maxSelected && (
            <div className="border-t border-gray-100 px-3 py-1.5 text-[11px] text-gray-400">
              最多選 {maxSelected} 個
            </div>
          )}
        </div>
      )}
    </div>
  );
}
