import React, { useEffect, useMemo, useState } from 'react';
import { promotionsApi } from '../../api/promotions';
import { courseTypesApi } from '../../api/courseTypes';
import { venuesApi } from '../../api/venues';
import { useToast } from '../../context/ToastContext';

function fieldClass(extra = '') {
  return `w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-brand-teal focus:outline-none ${extra}`;
}

function toISODate(v) {
  return v ? String(v).slice(0, 10) : '';
}
// 兩日期區間是否重疊：aStart <= bEnd && bStart <= aEnd
function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  if (!aStart || !aEnd || !bStart || !bEnd) return false;
  return aStart <= bEnd && bStart <= aEnd;
}
// 場館是否重疊：任一方為全館（空陣列）即視為重疊，否則看兩集合是否交集
function venuesOverlap(a = [], b = []) {
  if (!a.length || !b.length) return true;
  const setB = new Set(b.map(String));
  return a.some((x) => setB.has(String(x)));
}

export default function PromotionFormModal({ initial, onClose, onSaved, readOnly = false }) {
  const isEdit = !!initial?.id;
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  // 選項來源：課程需求管理（適用組別）/ F-A03 場館設定（適用場館）
  const [courseTypeOpts, setCourseTypeOpts] = useState(null); // null = 載入中
  const [venueOpts, setVenueOpts] = useState(null);
  // 重疊偵測：目前進行中（active）的優惠
  const [activePromos, setActivePromos] = useState([]);

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
    start_date: initial?.start_date ? toISODate(initial.start_date) : new Date().toISOString().slice(0, 10),
    end_date: initial?.end_date ? toISODate(initial.end_date) : '',
    max_uses: initial?.max_uses || '',
  });

  useEffect(() => {
    let alive = true;
    // (5) 適用組別 ← 課程需求管理；失敗時退回 initial.applicable_course_types 推導出的選項
    courseTypesApi.list()
      .then((rows) => {
        if (!alive) return;
        const opts = (Array.isArray(rows) ? rows : [])
          .filter((r) => r.is_active)
          .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
          .map((r) => ({ value: r.course_type, label: r.label || `1對${r.course_type}` }));
        // 保留「已選但現已停用 / 移除」的組別，使其仍可見並可取消勾選（不會被靜默保留）
        for (const ct of (initial?.applicable_course_types || [])) {
          if (!opts.some((o) => o.value === ct)) opts.push({ value: ct, label: `1對${ct}（已停用）` });
        }
        setCourseTypeOpts(opts);
      })
      .catch(() => {
        if (!alive) return;
        const fallback = (initial?.applicable_course_types || []).map((ct) => ({ value: ct, label: `1對${ct}` }));
        setCourseTypeOpts(fallback);
      });
    // (6) 適用場館 ← F-A03 場館設定；失敗時退回 initial.applicable_venue_ids
    venuesApi.list()
      .then((rows) => {
        if (!alive) return;
        const opts = (Array.isArray(rows) ? rows : []).map((v) => ({ value: v.id, label: v.name || `${v.id} 館` }));
        // 保留「已選但現已移除」的場館，使其仍可見並可取消勾選
        for (const id of (initial?.applicable_venue_ids || [])) {
          if (!opts.some((o) => o.value === id)) opts.push({ value: id, label: `${id} 館（已停用）` });
        }
        setVenueOpts(opts);
      })
      .catch(() => {
        if (!alive) return;
        const fallback = (initial?.applicable_venue_ids || []).map((id) => ({ value: id, label: `${id} 館` }));
        setVenueOpts(fallback);
      });
    // (9) 重疊偵測：抓目前進行中的優惠
    promotionsApi.active()
      .then((rows) => { if (alive) setActivePromos(Array.isArray(rows) ? rows : []); })
      .catch(() => { if (alive) setActivePromos([]); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggle(arr, v) {
    return arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];
  }

  // (9) 重疊警告：選定場館 + 日期後，檢查是否與既有 active 優惠的場館 / 期間重疊
  const overlapWarnings = useMemo(() => {
    if (!d.start_date || !d.end_date) return [];
    const venueLabel = (id) => {
      const o = (venueOpts || []).find((x) => String(x.value) === String(id));
      return o ? o.label : `${id} 館`;
    };
    const out = [];
    for (const p of activePromos) {
      if (isEdit && p.id === initial.id) continue; // 編輯自己不算重疊
      const pStart = toISODate(p.start_date);
      const pEnd = toISODate(p.end_date);
      if (!rangesOverlap(d.start_date, d.end_date, pStart, pEnd)) continue;
      const pVenues = Array.isArray(p.applicable_venue_ids) ? p.applicable_venue_ids : [];
      if (!venuesOverlap(d.applicable_venue_ids, pVenues)) continue;
      // 找出造成重疊的場館文字（任一方為全館 → 標示為「全館」）
      let scope;
      if (!d.applicable_venue_ids.length || !pVenues.length) {
        scope = '全館';
      } else {
        const setP = new Set(pVenues.map(String));
        scope = d.applicable_venue_ids.filter((x) => setP.has(String(x))).map(venueLabel).join('、');
      }
      out.push({ id: p.id, name: p.name, scope, start: pStart, end: pEnd });
    }
    return out;
  }, [activePromos, d.applicable_venue_ids, d.start_date, d.end_date, isEdit, initial, venueOpts]);

  async function save() {
    if (readOnly) { toast.error('當前狀態不可編輯'); return; }
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
      <div className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
        <h3 className="mb-1 text-lg font-bold text-brand-primary">
          {isEdit ? `${readOnly ? '檢視' : '檢視 / 編輯'}：${initial.name}` : '新增優惠活動'}
          {readOnly && <span className="ml-2 rounded-full bg-gray-200 px-2 py-0.5 text-xs text-gray-600">唯讀</span>}
        </h3>
        <p className="mb-5 text-xs text-gray-400">由上而下依序設定：基本資訊 → 折扣內容 → 適用條件 → 檔期與限量 → 領取方式。</p>

        {!readOnly && overlapWarnings.length > 0 && (
          <div className="mb-4 space-y-1 rounded-lg border border-brand-amber bg-amber-50 p-3 text-xs text-amber-800">
            {overlapWarnings.map((w) => (
              <div key={w.id}>
                ⚠️ {w.scope} 於 {w.start}~{w.end} 已有進行中優惠「{w.name}」，請避免重複放利。
              </div>
            ))}
          </div>
        )}

        <fieldset disabled={readOnly} className={`space-y-5 ${readOnly ? 'opacity-90' : ''}`}>

          {/* ① 基本資訊 */}
          <section>
            <h4 className="mb-2 flex items-center gap-2 text-[13px] font-bold text-brand-primary"><span>基本資訊</span><span className="h-px flex-1 bg-gray-100" /></h4>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="md:col-span-2">
                <label className="mb-1 block text-xs text-gray-500">名稱</label>
                <input className={fieldClass()} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
              </div>
              <div className="md:col-span-2">
                <label className="mb-1 block text-xs text-gray-500">說明（家長端會看到）</label>
                <textarea className={fieldClass()} rows={2} value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} />
              </div>
            </div>
          </section>

          {/* ② 折扣內容 */}
          <section>
            <h4 className="mb-2 flex items-center gap-2 text-[13px] font-bold text-brand-primary"><span>折扣內容</span><span className="h-px flex-1 bg-gray-100" /></h4>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
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
            </div>
          </section>

          {/* ③ 適用條件（由上而下逐步鎖定範圍） */}
          <section>
            <h4 className="mb-2 flex items-center gap-2 text-[13px] font-bold text-brand-primary"><span>適用條件</span><span className="text-[11px] font-normal text-gray-400">逐步鎖定範圍 · 不選 = 全部</span><span className="h-px flex-1 bg-gray-100" /></h4>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
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
                  {courseTypeOpts === null ? (
                    <span className="text-xs text-gray-400">載入中…</span>
                  ) : courseTypeOpts.length === 0 ? (
                    <span className="text-xs text-gray-400">（無可用組別）</span>
                  ) : courseTypeOpts.map((ct) => (
                    <button key={ct.value} type="button" onClick={() => setD({ ...d, applicable_course_types: toggle(d.applicable_course_types, ct.value) })}
                      className={`rounded-full px-3 py-1 text-xs ${d.applicable_course_types.includes(ct.value) ? 'bg-brand-teal text-white' : 'bg-gray-100 text-gray-600'}`}>{ct.label}</button>
                  ))}
                </div>
              </div>
              <div>
                <label className="mb-1 block text-xs text-gray-500">適用場館（不選 = 全部）</label>
                <div className="flex flex-wrap gap-2">
                  {venueOpts === null ? (
                    <span className="text-xs text-gray-400">載入中…</span>
                  ) : venueOpts.length === 0 ? (
                    <span className="text-xs text-gray-400">（無可用場館）</span>
                  ) : venueOpts.map((v) => (
                    <button key={v.value} type="button" onClick={() => setD({ ...d, applicable_venue_ids: toggle(d.applicable_venue_ids, v.value) })}
                      className={`rounded-full px-3 py-1 text-xs ${d.applicable_venue_ids.includes(v.value) ? 'bg-brand-teal text-white' : 'bg-gray-100 text-gray-600'}`}>{v.label}</button>
                  ))}
                </div>
              </div>
            </div>
          </section>

          {/* ④ 檔期與限量 */}
          <section>
            <h4 className="mb-2 flex items-center gap-2 text-[13px] font-bold text-brand-primary"><span>檔期與限量</span><span className="h-px flex-1 bg-gray-100" /></h4>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs text-gray-500">起始日 ＊</label>
                <input type="date" className={fieldClass()} value={d.start_date} onChange={(e) => setD({ ...d, start_date: e.target.value })} />
              </div>
              <div>
                <label className="mb-1 block text-xs text-gray-500">結束日 <span className="text-brand-error">＊</span></label>
                <input type="date" className={fieldClass()} value={d.end_date} onChange={(e) => setD({ ...d, end_date: e.target.value })} required />
              </div>
              <div className="md:col-span-2">
                <label className="mb-1 block text-xs text-gray-500">總使用次數上限（全部家長合計，空白 = 不限）</label>
                <input className={fieldClass()} value={d.max_uses} onChange={(e) => setD({ ...d, max_uses: e.target.value })} />
                <p className="mt-1 text-[11px] leading-snug text-gray-400">整個活動可被兌換的「總」次數（所有家長共用，每成立一筆報名 +1），非每人可用次數；達上限後即自動停止套用、不再顯示。</p>
              </div>
            </div>
          </section>

          {/* ⑤ 領取方式 */}
          <section>
            <h4 className="mb-2 flex items-center gap-2 text-[13px] font-bold text-brand-primary"><span>領取方式</span><span className="h-px flex-1 bg-gray-100" /></h4>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <div className="md:col-span-2">
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
          </section>

        </fieldset>
        <div className="mt-6 flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm">{readOnly ? '關閉' : '取消'}</button>
          {!readOnly && (
            <button onClick={save} disabled={busy} className="rounded-lg bg-brand-teal px-4 py-2 text-sm font-bold text-white hover:bg-brand-primary disabled:opacity-50">
              {busy ? '儲存中…' : isEdit ? '儲存' : '建立草稿'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
