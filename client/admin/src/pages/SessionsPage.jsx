import React, { useEffect, useMemo, useRef, useState } from 'react';
import DateTimePicker from '../../../shared/DateTimePicker.jsx';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import DataTable from '../components/DataTable';
import StatusBadge from '../components/StatusBadge';
import FilterBar from '../components/FilterBar';
import WeekGridView from '../components/WeekGridView';
import SessionDetailModal from '../components/SessionDetailModal';
import ExportMenu from '../components/ExportMenu';
import ConfirmDialog from '../components/ConfirmDialog';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { sessionsApi } from '../api/sessions';
import { venuesApi } from '../api/venues';
import { courseTypeLabel, checkinStatusLabel, formatTWDateTime, formatHM, sessionNoteSummary,
  taipeiInputToDate, todayISO } from '../utils/format';
import { exportSessionsCsv, exportSessionsXlsx } from '../utils/csvExport';
import { venueColor } from '../utils/venueColors.mjs';

const CHECKIN_TONE = { checked_in: 'green', not_yet: 'gray', absent: 'error' };
const QUICK_VENUES = { B: '新北', K: '三重', L: '三民', C: '松山' };

// 2026-09-01 需求：起訖日最長三個月。
// 用 92 天而不是「月份相減」：跨月份的天數不固定（2 月到 4 月只有 89 天，
// 7 月到 9 月有 92 天），用月份算會讓同樣「三個月」在不同季節得到不同上限。
const MAX_RANGE_DAYS = 92;

function daysBetween(from, to) {
  return Math.round((new Date(to + 'T00:00:00Z') - new Date(from + 'T00:00:00Z')) / 86400000) + 1;
}

// 2026-09-01 需求：預設就是當天到當天。
// 救生員開這頁最常見的意圖是「看今天」，要查前幾天再自己往回調。
function initialRange() {
  const d = todayISO();
  return { from: d, to: d, days: 1 };
}

export default function SessionsPage() {
  const { isAdmin, role, venueIds: myVenueIds } = useAuth();
  const toast = useToast();
  const [view, setView] = useState('list'); // 'list' | 'week'

  // 2026-09-01 需求：改成靜態篩選。draft = 使用者正在調的條件，applied = 真正查出來的條件。
  // 分成兩份而不是加一個「要不要自動查」的旗標，是因為畫面上必須看得出
  // 「我改了條件但還沒查」——只有一份狀態的話，篩選列顯示的就是結果的條件，
  // 使用者不會知道自己漏按查詢。
  const [draft, setDraft] = useState(() => initialRange());
  const [applied, setApplied] = useState(() => initialRange());
  // Task #90 修正：staff 預設帶「所屬全部場館」而非單一主場館，並可在自己場館間縮小。
  // 2026-09-01 需求：場館改單選。null = 全部場館（後端 scope 仍會限制 staff 的範圍）。
  const [draftVenue, setDraftVenue] = useState(() => (!isAdmin && myVenueIds.length === 1 ? myVenueIds[0] : null));
  const [appliedVenue, setAppliedVenue] = useState(() => (!isAdmin && myVenueIds.length === 1 ? myVenueIds[0] : null));
  const [queryVersion, setQueryVersion] = useState(0);
  const dirty = draft.from !== applied.from || draft.to !== applied.to || draftVenue !== appliedVenue;
  const [list, setList] = useState(null);
  const [venues, setVenues] = useState([]);
  const [loadError, setLoadError] = useState(false);
  const requestId = useRef(0);
  const [detail, setDetail] = useState(null);
  // 補簽到：backfilling = 目前要補簽到的時段列；backfillAt = datetime-local 字串
  const [backfilling, setBackfilling] = useState(null);
  const [backfillAt, setBackfillAt] = useState('');
  const [backfillBusy, setBackfillBusy] = useState(false);

  async function load() {
    const request = ++requestId.current;
    setList(null);
    setLoadError(false);
    // 一律走 /sessions range API：依起訖日 + 場館過濾。未選場館＝全部（後端 scope 處理），
    // 選了一館則在自己場館範圍內縮小（後端會與 scope 取交集，越權 id 自動濾掉）。
    try {
      const [data, vs] = await Promise.all([
        sessionsApi.range({ from: applied.from, to: applied.to, venueIds: appliedVenue ? [appliedVenue] : [] }),
        venuesApi.list(),
      ]);
      if (request !== requestId.current) return;
      setList(data);
      setVenues(vs);
    } catch {
      if (request === requestId.current) setLoadError(true);
    }
  }
  // 只在「開頁」與「按下查詢（applied 變動）」時載入。
  // 條件本身（draft）改動不再觸發查詢 —— 那正是這次要拿掉的動態篩選。
  useEffect(() => {
    load();
    return () => { requestId.current += 1; };
  }, [applied.from, applied.to, appliedVenue, isAdmin, queryVersion]);

  const venueName = (id) => venues.find((v) => v.id === id)?.name || id;
  // 按本次指定列出新北／三重／三民／松山；只顯示啟用且有權限的館。
  const selectableVenues = Object.keys(QUICK_VENUES)
    .map((id) => venues.find((v) => v.id === id && v.is_active !== false))
    .filter((v) => v && (isAdmin || myVenueIds.includes(v.id)));

  function setRangeBound(which, value) {
    if (!value) return;
    const next = { ...draft, [which]: value };
    const days = daysBetween(next.from, next.to);
    // 編輯時允許暫時跨越上限，才能移到過去或未來的區間；只在查詢時驗證。
    setDraft({ ...next, days });
  }

  // 當日也是篩選條件，與其他條件一樣按「查詢」才套用。
  function jumpToday() {
    const r = initialRange();
    setDraft(r);
  }

  // 2026-09-01 需求：條件下完後手動查詢。
  function runQuery() {
    const days = daysBetween(draft.from, draft.to);
    if (!Number.isFinite(days) || days < 1) {
      toast.warning('請選擇有效起訖日，結束日不得早於開始日');
      return;
    }
    if (days > MAX_RANGE_DAYS) {
      toast.warning(`起訖日最長三個月（${MAX_RANGE_DAYS} 天）`);
      return;
    }
    if (view === 'week' && days > 31) {
      toast.warning('週課表上限 31 天，請改選較短範圍');
      return;
    }
    // 查詢完之後把展開中的下拉／面板收起來（需求：查詢完下拉要自動隱藏）。
    if (typeof document !== 'undefined' && document.activeElement?.blur) document.activeElement.blur();
    setApplied({ ...draft, days });
    setAppliedVenue(draftVenue);
    // 原生 React key 重建篩選區：收起手機篩選、日期面板，並讓相同條件也能重查。
    setQueryVersion((n) => n + 1);
  }

  function doExport(kind) {
    if (!list || list.length === 0) { toast.error('沒有可匯出的資料'); return; }
    // 檔名：家教上課紀錄{起訖日}_{匯出日期}（_匯出日期 由匯出工具自動接上）
    const opts = { filenamePrefix: `家教上課紀錄${applied.from}~${applied.to}`, sessions: list, venueName };
    if (kind === 'csv') exportSessionsCsv(opts);
    else exportSessionsXlsx(opts);
    toast.success(`已匯出 ${list.length} 筆上課紀錄 (${kind.toUpperCase()})`);
  }

  function openBackfill(row) {
    setBackfilling(row);
    // 預設帶入該時段的上課日期＋開始時間（datetime-local 格式 YYYY-MM-DDTHH:MM）
    setBackfillAt(`${row.date}T${(row.start || '00:00').slice(0, 5)}`);
  }
  async function doBackfill() {
    if (!backfilling) return;
    if (!backfillAt) { toast.warning('請選擇簽到時間'); return; }
    const d = taipeiInputToDate(backfillAt);
    if (!d) { toast.error('簽到時間格式有誤'); return; }
    setBackfillBusy(true);
    try {
      // 轉成帶時區的 ISO instant（瀏覽器在地時間 → UTC），後端與顯示一致
      await sessionsApi.backfillCheckin(backfilling.id, d.toISOString());
      toast.success('已補簽到');
      setBackfilling(null);
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.error || '補簽到失敗');
    } finally {
      setBackfillBusy(false);
    }
  }

  const columns = useMemo(() => [
    { key: 'date', label: '日期', render: (r) => <span className="font-mono">{r.date}</span> },
    {
      // 2026-09-01 需求：這一欄原本是「幾點到幾點」的排定時段，改成實際簽到時間。
      // 排定時段在課程詳情裡看得到；這一頁要回答的是「他到底簽了沒、幾點簽的」。
      key: 'checkin_at', label: '簽到時間',
      render: (r) => (r.checkin_at
        ? <span className="font-mono text-brand-primary" title={formatTWDateTime(r.checkin_at)}>{formatHM(r.checkin_at)} 簽到</span>
        : <span className="text-xs text-gray-300">尚未簽到</span>),
    },
    { key: 'coach', label: '教練' },
    { key: 'course_type', label: '組別', render: (r) => (
      <span className="inline-flex items-center gap-1">
        <StatusBadge tone="teal">{courseTypeLabel(r.course_type)}</StatusBadge>
        {r.is_experience_course && (
          <span className="rounded-full bg-teal-50 px-1.5 py-0.5 text-[11px] font-bold text-teal-700">試上</span>
        )}
      </span>
    ) },
    { key: 'students', label: '學員名單', render: (r) => r.students.join('、') },
    {
      key: 'checkin_status', label: '簽到', className: 'text-center',
      render: (r) => <StatusBadge tone={CHECKIN_TONE[r.checkin_status] || 'gray'}>{checkinStatusLabel(r.checkin_status)}</StatusBadge>,
    },
    {
      // 櫃檯反映：手動扣課與家長扣課的原因在畫面上完全看不到。這一格是摘要，
      // 完整明細（每位學員各自的簽到人與時間）在點開的課程詳情裡。
      key: 'note', label: '備註',
      render: (r) => {
        const n = sessionNoteSummary(r);
        if (!n) return <span className="text-xs text-gray-300">—</span>;
        return (
          <div className="max-w-[220px] text-[11px] leading-tight">
            <StatusBadge tone={n.tone}>{n.tag}</StatusBadge>
            {n.text && (
              // title 讓長原因滑過去看得到全文；表格內截斷避免把版面撐爛。
              <div className="mt-0.5 truncate text-gray-600" title={n.text}>{n.text}</div>
            )}
          </div>
        );
      },
    },
    {
      key: 'backfill', label: '補簽到', className: 'text-center',
      // 簽到時間已移到中間那一欄，這裡只留動作與補登痕跡，不再重複顯示時間。
      // 判斷以 checkin_at 為準，不可用 backfilled_at —— 真實課堂的 backfilled_at
      // 在 admin/sessions.js 是硬寫的 NULL，用它判斷會讓所有已簽到的列都掉進「—」。
      render: (r) => r.checkin_at
        ? (r.backfilled_at
          ? <div className="text-[11px] leading-tight text-gray-500" title="補簽到按下時間">
              補於 {formatTWDateTime(r.backfilled_at)}
            </div>
          : <span className="text-xs text-gray-300">—</span>)
        : r.checkin_status === 'checked_in'
          ? <span className="text-xs text-gray-300">—</span>
          : (
            // 救生員在這一頁唯一的動作鈕，原本只有 26px 高。
            <button type="button" onClick={(e) => { e.stopPropagation(); openBackfill(r); }}
              className="min-h-[44px] rounded-md bg-brand-amber px-3 py-2 text-sm font-bold text-white hover:opacity-90 md:min-h-0 md:px-2.5 md:py-1 md:text-xs">
              補簽到
            </button>
          ),
    },
    // 2026-09-01 需求：場館拉到最右邊。
    { key: 'venue', label: '場館', render: (r) => venueName(r.venue_id) },
  ], [venues]);

  const tooLong = view === 'week' && applied.days > 31;

  function switchView(v) {
    if (v === 'week' && applied.days > 31) {
      toast.warning('週課表上限 31 天，請改選較短範圍');
      return;
    }
    setView(v);
  }

  // 週課表依場館上色，圖例列出目前畫面上真的有課的場館。
  // 用結果反推而不是列出所有場館：沒有課的場館出現在圖例只會讓人找不到對應的色塊。
  const legendVenues = useMemo(() => {
    if (!list) return [];
    const ids = [...new Set(list.map((r) => r.venue_id))].filter(Boolean);
    return ids.map((id) => ({ id, name: venueName(id) }));
  }, [list, venues]);

  return (
    <div>
      <PageHeader
        title="上課紀錄查詢"
        subtitle="F-R01 · 依起訖日查詢上課紀錄"
        actions={
          <div className="flex items-center gap-2">
            <div className="inline-flex overflow-hidden rounded-md border border-gray-300 text-sm">
              {[['list', '條列'], ['week', '週課表']].map(([v, label]) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => switchView(v)}
                  className={`min-h-[44px] px-3 py-1.5 md:min-h-0 ${view === v ? 'bg-brand-primary text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                >{label}</button>
              ))}
            </div>
            <ExportMenu
              disabled={!list || list.length === 0}
              onExportCsv={() => doExport('csv')}
              onExportXlsx={() => doExport('xlsx')}
            />
          </div>
        }
      />

      {/* 收編進共用 FilterBar：這一列原本自己手搓，外框那串 class
          （mb-4 / rounded-lg / border-gray-200 / bg-white / p-3 / shadow-sm，
          md 以上 flex flex-wrap items-end gap-3）與 FilterBar 逐字相同，
          所以只要把內容原樣放進 children slot，桌機的盒模型完全沒動：
          FilterBar 是「外框 div + 內層 flex div」兩層，這裡原本是一層 div
          同時當外框與 flex 容器 —— 內層是塊級、寬度撐滿外框內容區，
          md 以上 md:mt-0 不帶邊界，兩種寫法算出來的版位一模一樣。

          原本在 375px 會發生什麼：三個欄位各自為政地折行，右緣分別停在
          304 / 189 / 346，看起來像被啃過一口。起訖日那組是 flex-1 撐滿、
          場館那顆是 min-w-[160px] 內容寬、右邊的統計文字又被 ml-auto 推到最右。
          收編後手機是收合的單欄滿版（左右各切齊一條線），桌機不變。 */}
      <FilterBar key={queryVersion} activeCount={appliedVenue ? 1 : 0}>
        <div className="w-full md:w-auto">
          <label className="mb-1 block text-xs font-medium text-gray-600">
            起訖日<span className="ml-1 font-normal text-gray-400">（最長三個月）</span>
          </label>
{/* 外層那一列有 flex-wrap，這一層原本沒有：
              152 + 152 + 「~」12 + 兩個 gap-1.5 共 12 = 328px，
              而外層 p-3 之後 375px 只剩 301px —— 溢出 27px，整頁橫向捲動。
              兩個 picker 改成 flex-1 min-w-0，窄螢幕自己縮，桌機由 md:w-[152px] 定住。
              斷點從 sm: 換成 md:：收合／單欄的切換點是 md，留在 sm 的話
              640–767px 之間會變成「已經是單欄格線、picker 卻還被釘在 152px」的半殘狀態。
              md 以上（桌機）兩種寫法算出來的寬度相同，sm: 的規則在 ≥768px 本來就也生效。 */}
          <div className="flex flex-wrap items-center gap-1.5">
            <DateTimePicker value={draft.from} max={draft.to || undefined}
              onChange={(v) => setRangeBound('from', v)} className="min-w-0 flex-1 md:w-[152px] md:flex-none" />
            <span className="shrink-0 text-gray-400">~</span>
            <DateTimePicker value={draft.to} min={draft.from || undefined}
              onChange={(v) => setRangeBound('to', v)} className="min-w-0 flex-1 md:w-[152px] md:flex-none" />
            {/* 2026-09-01 需求：結束日右邊一顆小長方形「當天」。
                shrink-0 是必要的：不加的話 375px 上它會被兩個 picker 擠成一條。 */}
            <button
              type="button" onClick={jumpToday} title="起訖日設為當日，按查詢套用"
              className="min-h-[44px] shrink-0 rounded-md border border-gray-300 bg-white px-3 text-sm font-medium text-gray-700 hover:border-brand-teal hover:text-brand-teal md:min-h-0 md:py-1.5"
            >{role === 'lifeguard' ? '當日' : '當'}</button>
          </div>
        </div>

        {/* 2026-09-01 需求：場館改成小方塊按鈕、單選。
            單選是刻意的 —— 多選時「新北＋三重」的結果混在一起，
            救生員要看的是自己場館那一份。全部場館仍然留著當退路。 */}
        <div className="w-full md:w-auto">
          <label className="mb-1 block text-xs font-medium text-gray-600">
            {!isAdmin ? '場館（限所屬）' : '場館'}
          </label>
          <div className="grid w-fit grid-cols-4 gap-1.5">
            {[{ id: null, name: '全部場館' }, ...selectableVenues].map((v) => {
              const on = draftVenue === v.id;
              return (
                <button
                  key={v.id || '__all__'} type="button"
                  onClick={() => setDraftVenue(v.id)}
                  aria-pressed={on} title={v.name}
                  className={`min-h-[44px] min-w-[44px] rounded-md border px-2 text-sm font-medium ${!v.id ? 'col-span-4 justify-self-start px-3 md:min-h-0 md:py-1.5' : ''} ${
                    on ? 'border-brand-primary bg-brand-primary text-white'
                       : 'border-gray-300 bg-white text-gray-700 hover:border-brand-teal hover:text-brand-teal'}`}
                >{QUICK_VENUES[v.id] || v.name}</button>
              );
            })}
          </div>
        </div>

        {/* 2026-09-01 需求：條件下完後手動查詢。 */}
        <div className="w-full md:w-auto">
          <label className="mb-1 hidden text-xs font-medium text-gray-600 md:block">&nbsp;</label>
          <button
            type="button" onClick={runQuery}
            className={`min-h-[44px] w-full rounded-md px-5 text-sm font-bold text-white md:min-h-0 md:w-auto md:py-1.5 ${
              dirty ? 'bg-brand-amber hover:opacity-90' : 'bg-brand-primary hover:opacity-90'}`}
          >查詢</button>
        </div>
        {/* ml-auto 只留給桌機。手機的單欄格線裡，ml-auto 會讓這格縮成
            fit-content 並被推到右緣 —— 正好破壞剛切齊的左右邊線。 */}
        <div className="w-full text-xs text-gray-500 md:ml-auto md:w-auto">
          {applied.from} ~ {applied.to}（{applied.days} 天）
          {list && <span className="ml-2 text-gray-400">共 {list.length} 筆</span>}
          {/* 靜態篩選最容易出的錯是「改了條件以為已經查了」。
              把「還沒套用」直接寫在結果旁邊，比只把按鈕變色更難忽略。 */}
          {dirty && <div className="mt-0.5 font-medium text-brand-amber">條件已修改，按「查詢」套用</div>}
        </div>
      </FilterBar>

      {tooLong && view === 'week' && (
        <div className="mb-3 rounded-md border border-brand-amber/40 bg-brand-amber/10 px-3 py-2 text-sm text-brand-amber">
          範圍超過 31 天，週課表已停用，請切回條列或縮短範圍。
        </div>
      )}

      {loadError ? (
        <div role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          上課紀錄載入失敗，請稍後按「查詢」重試。
        </div>
      ) : !list ? (
        <LoadingSpinner fullPage />
      ) : view === 'week' && !tooLong ? (
        <>
          {/* 2026-09-01 需求：篩選列下方、表格上方標註顏色代表哪個場館。 */}
          {legendVenues.length > 0 && (
            <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[11px] text-gray-500">
              <span className="font-medium text-gray-600">場館顏色：</span>
              {legendVenues.map((v) => (
                <span key={v.id} className="inline-flex items-center gap-1">
                  <span className="inline-block h-3 w-3 rounded-sm border border-black/15" style={{ backgroundColor: venueColor(v.id) }} />
                  {v.name}
                </span>
              ))}
            </div>
          )}
          <WeekGridView
            sessions={list}
            from={applied.from}
            to={applied.to}
            venues={venues}
            onSelect={(s) => setDetail(s)}
          />
        </>
      ) : (
        <DataTable
          columns={columns}
          rows={list}
          rowKey={(r) => r.id}
          empty="所選範圍 / 場館內沒有課程"
          onRowClick={(r) => setDetail(r)}
        />
      )}

      <SessionDetailModal session={detail} venueName={venueName} onClose={() => setDetail(null)} />

      <ConfirmDialog
        open={!!backfilling}
        title="櫃台補簽到"
        confirmLabel="確認補簽到"
        busy={backfillBusy}
        confirmDisabled={!backfillAt}
        onCancel={() => !backfillBusy && setBackfilling(null)}
        onConfirm={doBackfill}
      >
        {backfilling && (
          <div className="space-y-3">
            <div className="text-xs text-gray-500">
              {backfilling.date}・{backfilling.start}–{backfilling.end}・{venueName(backfilling.venue_id)}・{backfilling.coach}
              <div>學員：{(backfilling.students || []).join('、')}</div>
            </div>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-600">簽到時間</span>
              <DateTimePicker mode="datetime" value={backfillAt} onChange={setBackfillAt}
                placeholder="選擇簽到時間" />
            </label>
            <p className="text-[11px] text-gray-400">確認後系統會記錄此簽到時間，並記下你按下補簽到的當下時間。</p>
          </div>
        )}
      </ConfirmDialog>
    </div>
  );
}
