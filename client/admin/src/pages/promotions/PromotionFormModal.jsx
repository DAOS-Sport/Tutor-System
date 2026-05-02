import React, { useState } from 'react';
import { promotionsApi } from '../../api/promotions';
import { useToast } from '../../context/ToastContext';

const COURSE_TYPES = [1, 2, 3];
const VENUES = ['B', 'C', 'X']; // 與 coreSchema seed 對齊

function fieldClass(extra = '') {
  return `w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-teal focus:outline-none ${extra}`;
}

export default function PromotionFormModal({ initial, onClose, onSaved }) {
  const isEdit = !!initial?.id;
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [d, setD] = useState({
    name: initial?.name || '',
    description: initial?.description || '',
    type: initial?.type || 'PERCENTAGE',
    discount_value: initial?.discount_value != null ? String(initial.discount_value) : '0.95',
    min_threshold_type: initial?.min_threshold_type || '',
    min_threshold_value: initial?.min_threshold_value || '',
    applicable_course_types: initial?.applicable_course_types || [],
    applicable_venue_ids: initial?.applicable_venue_ids || [],
    coupon_code: initial?.coupon_code || '',
    generate_coupon_code: false,
    start_date: initial?.start_date ? String(initial.start_date).slice(0, 10) : new Date().toISOString().slice(0, 10),
    end_date: initial?.end_date ? String(initial.end_date).slice(0, 10) : '',
    max_uses: initial?.max_uses || '',
  });

  function toggle(arr, v) {
    return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
  }

  async function save() {
    if (!d.name.trim()) { toast.error('名稱必填'); return; }
    if (!d.end_date) { toast.error('結束日期必填'); return; }
    if (d.end_date < d.start_date) { toast.error('結束日期不可早於開始日期'); return; }
    const v = parseFloat(d.discount_value);
    if (!Number.isFinite(v) || v <= 0) { toast.error('折扣值必須 > 0'); return; }
    if (d.type === 'PERCENTAGE' && (v <= 0 || v >= 1)) { toast.error('折數必須介於 0~1（如 0.9 = 9折）'); return; }

    const payload = {
      name: d.name.trim(),
      description: d.description.trim(),
      type: d.type,
      discount_value: v,
      min_threshold_type: d.min_threshold_type || null,
      min_threshold_value: d.min_threshold_value ? Number(d.min_threshold_value) : null,
      applicable_course_types: d.applicable_course_types,
      applicable_venue_ids: d.applicable_venue_ids,
      coupon_code: d.coupon_code.trim() || null,
      generate_coupon_code: !isEdit && d.generate_coupon_code,
      start_date: d.start_date,
      end_date: d.end_date,
      max_uses: d.max_uses ? Number(d.max_uses) : null,
    };

    setBusy(true);
    try {
      if (isEdit) await promotionsApi.update(initial.id, payload);
      else await promotionsApi.create(payload);
      toast.success(isEdit ? '已更新' : '已建立草稿');
      onSaved();
    } catch (e) {
      toast.error(e?.response?.data?.error || '儲存失敗');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 px-4" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
        <h3 className="mb-4 text-lg font-bold text-brand-primary">{isEdit ? `檢視 / 編輯：${initial.name}` : '新增優惠活動'}</h3>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="md:col-span-2">
            <label className="mb-1 block text-xs text-gray-500">名稱</label>
            <input className={fieldClass()} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
          </div>
          <div className="md:col-span-2">
            <label className="mb-1 block text-xs text-gray-500">說明（家長端會看到）</label>
            <textarea className={fieldClass()} rows={2} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} />
          </div>

          <div>
            <label className="mb-1 block text-xs text-gray-500">類型</label>
            <select className={fieldClass()} value={d.type} onChange={(e) => setD({ ...d, type: e.target.value })}>
              <option value="PERCENTAGE">折數 (PERCENTAGE)</option>
              <option value="FIXED_AMOUNT">固定折抵 (FIXED_AMOUNT)</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-gray-500">折扣值 {d.type === 'PERCENTAGE' ? '(0~1，如 0.9 = 9折)' : '(整數，元)'}</label>
            <input className={fieldClass()} value={d.discount_value} onChange={(e) => setD({ ...d, discount_value: e.target.value })} />
          </div>

          <div>
            <label className="mb-1 block text-xs text-gray-500">門檻類型</label>
            <select className={fieldClass()} value={d.min_threshold_type} onChange={(e) => setD({ ...d, min_threshold_type: e.target.value })}>
              <option value="">無門檻</option>
              <option value="PERIOD_COUNT">一次購買期數 ≥</option>
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-gray-500">門檻數值</label>
            <input className={fieldClass()} value={d.min_threshold_value} onChange={(e) => setD({ ...d, min_threshold_value: e.target.value })} disabled={!d.min_threshold_type} />
          </div>

          <div>
            <label className="mb-1 block text-xs text-gray-500">適用組別（不選 = 全部）</label>
            <div className="flex flex-wrap gap-2">
              {COURSE_TYPES.map((ct) => (
                <button key={ct} type="button" onClick={() => setD({ ...d, applicable_course_types: toggle(d.applicable_course_types, ct) })}
                  className={`rounded-full px-3 py-1 text-xs ${d.applicable_course_types.includes(ct) ? 'bg-brand-teal text-white' : 'bg-gray-100 text-gray-600'}`}>1對{ct}</button>
              ))}
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs text-gray-500">適用場館（不選 = 全部）</label>
            <div className="flex flex-wrap gap-2">
              {VENUES.map((v) => (
                <button key={v} type="button" onClick={() => setD({ ...d, applicable_venue_ids: toggle(d.applicable_venue_ids, v) })}
                  className={`rounded-full px-3 py-1 text-xs ${d.applicable_venue_ids.includes(v) ? 'bg-brand-teal text-white' : 'bg-gray-100 text-gray-600'}`}>{v} 館</button>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs text-gray-500">起始日</label>
            <input type="date" className={fieldClass()} value={d.start_date} onChange={(e) => setD({ ...d, start_date: e.target.value })} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-gray-500">結束日</label>
            <input type="date" className={fieldClass()} value={d.end_date} onChange={(e) => setD({ ...d, end_date: e.target.value })} />
          </div>

          <div>
            <label className="mb-1 block text-xs text-gray-500">使用次數上限（空白 = 不限）</label>
            <input className={fieldClass()} value={d.max_uses} onChange={(e) => setD({ ...d, max_uses: e.target.value })} />
          </div>
          <div>
            <label className="mb-1 block text-xs text-gray-500">折價券代碼（空白 = 自動套用，不需代碼）</label>
            <div className="flex gap-2">
              <input className={fieldClass()} value={d.coupon_code} onChange={(e) => setD({ ...d, coupon_code: e.target.value.toUpperCase() })} disabled={d.generate_coupon_code} placeholder="自訂代碼或勾選下方自動產生" />
            </div>
            {!isEdit && (
              <label className="mt-1 inline-flex items-center gap-1 text-xs text-gray-500">
                <input type="checkbox" checked={d.generate_coupon_code} onChange={(e) => setD({ ...d, generate_coupon_code: e.target.checked, coupon_code: '' })} />
                建立時自動產生隨機代碼
              </label>
            )}
          </div>
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm">取消</button>
          <button onClick={save} disabled={busy} className="rounded-lg bg-brand-teal px-4 py-2 text-sm font-bold text-white hover:bg-brand-primary disabled:opacity-50">
            {busy ? '儲存中…' : isEdit ? '儲存' : '建立草稿'}
          </button>
        </div>
      </div>
    </div>
  );
}
