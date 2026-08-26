import React, { useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import DataTable from '../components/DataTable';
import ListFooter from '../components/ListFooter';
import StatusBadge from '../components/StatusBadge';
import FilterBar from '../components/FilterBar';
import useInfiniteList from '../hooks/useInfiniteList';
import { useAuth } from '../context/AuthContext';
import { enrollmentsApi } from '../api/enrollments';
import { venuesApi } from '../api/venues';
import { formatTWD, formatTWDateTime, courseTypeLabel, paymentStatusLabel, paymentStatusTone, formatTWDateTimeSeconds } from '../utils/format';
import { exportEnrollmentsCsv, exportEnrollmentsXlsx } from '../utils/csvExport';
import { useToast } from '../context/ToastContext';
import ExportMenu from '../components/ExportMenu';
import EditEnrollmentModal from './enrollments/EditEnrollmentModal';
import ImageLightbox from '../components/ImageLightbox';

const STATUS_OPTIONS = [
  { value: '',                 label: '全部狀態' },
  { value: 'pending_payment',  label: '待對帳' },
  { value: 'confirmed',        label: '已對帳' },
  { value: 'active',           label: '進行中' },
  { value: 'cancelled',        label: '已取消' },
  { value: 'refunded',         label: '已退費' },
];

const EDITABLE_STATUSES = ['pending_payment', 'confirmed', 'active'];

export default function EnrollmentsPage() {
  const { isStaff, isAdmin, isManager } = useAuth();
  const toast = useToast();
  const [filters, setFilters] = useState({ status: '', search: '' });
  const [venues, setVenues] = useState([]);
  const [detail, setDetail] = useState(null);
  const [editing, setEditing] = useState(null);
  const [exporting, setExporting] = useState(false);

  const canEdit = isAdmin || isManager || isStaff;

  useEffect(() => { venuesApi.list().then(setVenues); }, []);

  // Task #90 修正：多場館櫃檯不再鎖單一主場館。不帶 venueId → 後端依 venue_ids scope
  // 列出「所屬全部場館」的報名（原本 isStaff 帶 user.venue_id 只會看到主場館＝新北）。
  //
  // 改成分批載入：正式庫這張表已破千，整包回應在手機網路上會撞到 axios 的 10 秒逾時，
  // 而逾時的結果是整頁載不出來，不是「慢一點」。
  const {
    items: list, setItems: setList, loading, done, error, loadMore, sentinelRef,
  } = useInfiniteList(
    ({ limit, offset }) => enrollmentsApi.list({ ...filters, limit, offset }),
    [filters],
  );

  /**
   * 匯出一定要拿「整份」，不能拿畫面上已經捲到的那幾批。
   * 分批之後直接匯出 list 會少資料，而匯出的檔案打開來完全正常 ——
   * 沒有任何跡象顯示它是殘缺的，這種錯不會有人回報。
   * 這裡照樣分批抓（而不是一次不帶 limit），每次請求都很小，不會撞逾時。
   */
  async function fetchAllForExport() {
    const PAGE = 200;   // 後端上限 1000；抓小一點換每次請求都穩
    const all = [];
    for (let offset = 0; ; offset += PAGE) {
      // eslint-disable-next-line no-await-in-loop
      const batch = await enrollmentsApi.list({ ...filters, limit: PAGE, offset });
      const rows = Array.isArray(batch) ? batch : [];
      all.push(...rows);
      // 保險絲：後端若因故永遠回滿頁，這裡不能變成無限迴圈
      if (rows.length < PAGE || all.length >= 20000) return all;
    }
  }

  async function runExport(kind) {
    if (exporting) return;
    setExporting(true);
    try {
      const all = await fetchAllForExport();
      if (all.length === 0) { toast.error('沒有可匯出的資料'); return; }
      const args = { filenamePrefix: 'enrollments', enrollments: all, venueName: (id) => venueMap[id] || id };
      if (kind === 'csv') exportEnrollmentsCsv(args); else exportEnrollmentsXlsx(args);
      toast.success(`已匯出 ${all.length} 筆報名資料 (${kind === 'csv' ? 'CSV' : 'XLSX'})`);
    } catch (e) {
      toast.error(e?.response?.data?.error || '匯出失敗，請稍後再試');
    } finally {
      setExporting(false);
    }
  }

  const venueMap = useMemo(() => Object.fromEntries(venues.map((v) => [v.id, v.name])), [venues]);

  async function openDetail(row) {
    setDetail(row);
    try {
      const latest = await enrollmentsApi.detail(row.id);
      if (latest) setDetail(latest);
    } catch {
      toast.warning('LINE 名稱暫時無法更新，其他報名資料不受影響。');
    }
  }

  const columns = [
    { key: 'id', label: '編號', render: (r) => <button className="font-mono text-xs text-brand-teal hover:underline" onClick={() => openDetail(r)}>{r.id}</button> },
    { key: 'submitted_at', label: '送出', render: (r) => <span className="text-xs text-gray-600">{formatTWDateTime(r.submitted_at)}</span> },
    { key: 'parent', label: '家長', render: (r) => <div className="text-sm"><div className="font-medium">{r.parent_name}</div><div className="text-xs text-gray-500">{r.parent_phone}</div></div> },
    { key: 'students', label: '學員', render: (r) => r.students.join('、') },
    { key: 'coach', label: '教練 / 場館', render: (r) => <div><div>{r.coach}</div><div className="text-xs text-gray-500">{venueMap[r.venue_id] || r.venue_id}</div></div> },
    { key: 'course_type', label: '組別', render: (r) => <StatusBadge tone="teal">{courseTypeLabel(r.course_type)}</StatusBadge> },
    { key: 'final_price', label: '金額', className: 'text-right', render: (r) => <span className="font-mono">{formatTWD(r.final_price)}</span> },
    { key: 'status', label: '狀態', render: (r) => <StatusBadge tone={paymentStatusTone(r.status)}>{paymentStatusLabel(r.status)}</StatusBadge> },
  ];

  function handleSaved(updated) {
    setEditing(null);
    setDetail(updated);
    setList((prev) => prev ? prev.map((e) => (e.id === updated.id ? updated : e)) : prev);
  }

  return (
    <div>
      <PageHeader
        title="所有報名"
        /* 分批載入之後不能再一律寫「共」：還沒捲到底時那個數字只是「目前載到幾筆」，
           寫成「共」會讓人以為總數就這麼多，而少掉的部分沒有任何跡象。 */
        subtitle={`F-R02 · ${list == null ? '共 — 筆' : `${done ? '共' : '已載入'} ${list.length} 筆`}${isStaff ? '（限您管轄的場館）' : ''}`}
        actions={
          <ExportMenu
            disabled={!list || list.length === 0 || exporting}
            onExportCsv={() => runExport('csv')}
            onExportXlsx={() => runExport('xlsx')}
          />
        }
      />

      {/* 收編進共用 FilterBar。兩個控制項本身一個字都沒改（rounded-lg / px-3 py-2 /
          text-sm 與 FilterBar 內建的 rounded-md / px-2 py-1.5 不同，硬換過去桌機的
          圓角與列高就變了），所以走 children slot，只借手機收合與單欄滿版。
          className 換掉是因為這張卡是 p-4 不是 FilterBar 預設的 p-3；
          rowClassName 換掉是因為原本是 items-center —— select 與 input 的實高
          未必逐像素相同，改成 items-end 有機會差一兩個像素。

          原本在 375px 會發生什麼：卡片 p-4 後只剩 311px，搜尋框自己帶
          min-w-[240px] + flex-1，狀態下拉是內容寬（約 96px），兩者塞不進同一列
          就折行，於是上排一顆短下拉、下排一條長輸入框，右緣差了一百多像素。 */}
      <FilterBar
        className="mb-4 rounded-lg border border-gray-200 bg-white p-4 shadow-sm"
        rowClassName="md:flex md:flex-wrap md:items-center"
        activeCount={[filters.status, filters.search].filter(Boolean).length}
      >
        <select
          value={filters.status}
          onChange={(e) => setFilters({ ...filters, status: e.target.value })}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm md:w-auto"
        >
          {STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        {/* flex-1 與 min-w-[240px] 都要押在 md: —— flex-1 會把 flex-basis 設成 0%，
            在手機那一格會蓋掉 w-full；min-w-[240px] 則是 375px 上折行的元兇之一。 */}
        <input
          type="text"
          placeholder="搜尋家長 / 手機 / 教練 / 學員 / 編號"
          value={filters.search}
          onChange={(e) => setFilters({ ...filters, search: e.target.value })}
          className="w-full min-w-0 rounded-lg border border-gray-300 px-3 py-2 text-sm md:w-auto md:min-w-[240px] md:flex-1"
        />
      </FilterBar>

      {!list ? <LoadingSpinner /> : <DataTable columns={columns} rows={list} rowKey={(r) => r.id} empty="沒有符合條件的資料" />}

      {/* 清單空的時候 DataTable 已經有空狀態，頁尾再說一次「沒有資料」是重複；
          還在載、載失敗、或還有下一批時才需要它。 */}
      {list && !(done && !error && list.length === 0) && (
        <ListFooter
          loading={loading}
          done={done}
          error={error}
          count={list.length}
          onRetry={loadMore}
          sentinelRef={sentinelRef}
        />
      )}

      {detail && !editing && (
        <div
          className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 md:items-center md:px-4"
          onClick={(e) => e.target === e.currentTarget && setDetail(null)}
          role="dialog"
          aria-modal="true"
          aria-label="報名明細"
        >
          {/* 原本在 375px 會發生什麼：面板置中、被 px-4 夾成 343 寬，而報名明細本身很長
              （雙欄 dl + 匯款證明縮圖 + 操作紀錄），面板整個吃滿 90vh；底部的
              「✏️ 編輯資料 / 關閉」被推到接近視窗上下緣的位置，而且必須先捲到最底才看得到。
              vh 又比 iOS Safari 的實際可見區高一截（含收合中的網址列），那一列還會再往下沉。
              改成 md 以下貼底升起的面板：滿版、上緣圓角、85dvh。
              面板本身原本就是捲軸（p-6 + overflow-y-auto），改成 flex-col 之後把 p-6 與
              overflow-y-auto 一起搬進中段那層，grabber 才不會跟著內容捲走；桌機上兩種寫法
              的內距、捲軸位置與可捲範圍完全一致。
              md 以上原封不動回到 items-center + max-w-xl + rounded-2xl + 90dvh（桌機同 90vh）。 */}
          <div className="flex max-h-[85dvh] w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-xl pb-[env(safe-area-inset-bottom)] md:max-h-[90dvh] md:max-w-xl md:rounded-2xl">
            {/* grabber：行動裝置上「這個可以往下拉」的通用暗示，桌機沒有這個手勢所以 md:hidden。 */}
            <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-gray-300 md:hidden" aria-hidden="true" />
            <div className="flex-1 overflow-y-auto p-6">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-lg font-bold text-brand-primary">報名明細 {detail.id}</h3>
                <StatusBadge tone={paymentStatusTone(detail.status)}>{paymentStatusLabel(detail.status)}</StatusBadge>
              </div>
              <dl className="grid grid-cols-2 gap-3 text-sm">
                <div><dt className="text-gray-500">家長</dt><dd>{detail.parent_name} ({detail.parent_phone})</dd></div>
                <div>
                  <dt className="text-gray-500">LINE 名稱</dt>
                  <dd className="font-medium text-[#06C755]">
                    {detail.line_display_name || (detail.line_bound ? '已綁定（待下次 LINE 登入取得名稱）' : '未綁定')}
                  </dd>
                </div>
                <div><dt className="text-gray-500">學員</dt><dd>{detail.students.join('、')}</dd></div>
                <div><dt className="text-gray-500">教練</dt><dd>{detail.coach}</dd></div>
                <div><dt className="text-gray-500">場館</dt><dd>{venueMap[detail.venue_id] || detail.venue_id}</dd></div>
                <div><dt className="text-gray-500">組別</dt><dd>{courseTypeLabel(detail.course_type)}</dd></div>
                <div><dt className="text-gray-500">轉帳末 5</dt><dd className="font-mono">{detail.transfer_last_5}</dd></div>
                <div><dt className="text-gray-500">原價 / 應收</dt><dd>{formatTWD(detail.original_price)} → <b>{formatTWD(detail.final_price)}</b></dd></div>
                {detail.total_sessions != null && (
                  <div><dt className="text-gray-500">堂數</dt><dd>{detail.used_sessions || 0} / {detail.total_sessions}</dd></div>
                )}
              </dl>

              {detail.extra_parent_phones && detail.extra_parent_phones.length > 0 && (
                <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50 p-3">
                  <div className="mb-1 text-xs font-bold text-blue-700">📱 附加家長手機（多組家庭）</div>
                  <div className="flex flex-wrap gap-2">
                    {(detail.extra_parent_phones || []).map((p) => (
                      <span key={p} className="rounded-full bg-blue-100 px-2 py-0.5 font-mono text-xs text-blue-800">{p}</span>
                    ))}
                  </div>
                </div>
              )}

              {detail.notes && (
                <div className="mt-3 rounded-xl border border-gray-200 bg-gray-50 p-3 text-sm text-gray-700">
                  <span className="font-bold text-gray-500">備注：</span>{detail.notes}
                </div>
              )}

              {detail.payment_proof_url && (
                <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <div className="mb-3 text-sm font-bold text-slate-700">匯款／轉帳證明</div>
                  <ImageLightbox
                    src={detail.payment_proof_url}
                    alt="匯款證明"
                    label="匯款／轉帳證明"
                  />
                </div>
              )}

              {detail.invoice_number && (
                <div className="mt-4 rounded-xl border border-teal-200 bg-teal-50 p-4">
                  <div className="mb-3 text-sm font-bold text-teal-700">🧾 發票資訊</div>
                  <dl className="grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <dt className="text-gray-500">發票號碼</dt>
                      <dd className="font-mono font-bold text-teal-800">{detail.invoice_number}</dd>
                    </div>
                    {detail.invoice_issued_at && (
                      <div>
                        <dt className="text-gray-500">開立時間</dt>
                        <dd>{formatTWDateTime(detail.invoice_issued_at)}</dd>
                      </div>
                    )}
                    {detail.invoice_url && (
                      <div className="col-span-2">
                        <dt className="text-gray-500">電子發票查詢</dt>
                        <dd><a href={detail.invoice_url} target="_blank" rel="noreferrer" className="text-brand-teal underline hover:opacity-75">{detail.invoice_url}</a></dd>
                      </div>
                    )}
                    {detail.invoice_image_url && (
                      <div className="col-span-2">
                        <dt className="mb-1 text-gray-500">發票照片</dt>
                        <dd>
                          <ImageLightbox
                            src={detail.invoice_image_url}
                            alt="發票"
                            label="發票照片"
                          />
                        </dd>
                      </div>
                    )}
                  </dl>
                </div>
              )}

              {/* audit_logs 只有詳情 API 才有，清單 API 刻意不回
                  （server/routes/admin/enrollments.js:918 的註解說明了原因）。
                  openDetail 先 setDetail(row) 讓彈窗立刻出現，等詳情回來才補上 ——
                  那個空窗期裡 detail.audit_logs 是 undefined，直接 .map() 會丟
                  TypeError，被 ErrorBoundary 接住之後整頁變成「頁面發生錯誤」。
                  mock 模式的假資料每一筆都自帶 audit_logs，所以開發時看不到。 */}
              <div className="mt-5">
                <div className="mb-2 text-sm font-bold text-gray-700">操作紀錄</div>
                <ul className="space-y-1 text-xs text-gray-600">
                  {!detail.audit_logs && (
                    <li className="text-gray-400">載入中…</li>
                  )}
                  {detail.audit_logs && detail.audit_logs.length === 0 && (
                    <li className="text-gray-400">尚無操作紀錄</li>
                  )}
                  {(detail.audit_logs || []).map((a, i) => (
                    <li key={i} className="flex gap-3">
                      <span className="w-36 shrink-0 font-mono text-gray-400">{formatTWDateTimeSeconds(a.at)}</span>
                      <span className="flex-1">{a.action}</span>
                      <span className="text-gray-500">— {a.by}</span>
                    </li>
                  ))}
                </ul>
              </div>

              {/* 原本在 375px 會發生什麼：這排「編輯資料 / 關閉」在整段明細的最後面，
                  要一路捲到最底才看得到，中途想關掉只能去點遮罩。
                  sticky bottom-0 讓它在捲動時就釘在面板下緣（＝拇指區）；
                  md:static 把它原樣放回文件流，桌機仍是捲到底才出現的那一列。 */}
              <div className="sticky bottom-0 mt-5 flex items-center justify-between bg-white py-3 md:static md:bg-transparent md:py-0">
                {canEdit && EDITABLE_STATUSES.includes(detail.status) ? (
                  <button
                    onClick={() => setEditing(detail)}
                    className="rounded-lg bg-brand-primary px-4 py-2 text-sm font-bold text-white hover:bg-brand-teal"
                  >
                    ✏️ 編輯資料
                  </button>
                ) : (
                  <span />
                )}
                <button
                  onClick={() => setDetail(null)}
                  className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-100"
                >
                  關閉
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {editing && (
        <EditEnrollmentModal
          enrollment={editing}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
