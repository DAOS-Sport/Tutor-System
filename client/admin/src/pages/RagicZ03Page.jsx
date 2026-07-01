import React, { useEffect, useMemo, useState } from 'react';
import PageHeader from '../components/PageHeader';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { useAuth } from '../context/AuthContext';
import { ragicZ03Api } from '../api/ragicZ03';

// Task #70 邊緣案例處理準則（同 RagicStagingPage）：
// skipAuthRedirect=true，401 由頁面自己判斷是否登出，其餘錯誤顯示 toast + 重試。

const STATUS_LABEL = {
  pending:   { text: '待處理', cls: 'bg-amber-100 text-amber-800' },
  resolved:  { text: '已修正', cls: 'bg-brand-green/15 text-brand-green' },
  dismissed: { text: '已忽略', cls: 'bg-gray-200 text-gray-600' },
};

function fmtDate(ts) {
  if (!ts) return '—';
  try { return new Date(ts).toLocaleString('zh-TW', { hour12: false }); } catch { return ts; }
}

// 家長欄位 + 學員子表格的原始值檢視——沿用 RagicZ01Modal 的視覺結構（橘色家長資訊 /
// 藍色學員資料），但這裡全部唯讀，只有「正確姓名」是可編輯輸入。
function Z03Card({ row, busy, onResolve, onDismiss }) {
  const st = STATUS_LABEL[row.status] || STATUS_LABEL.pending;
  const [fixedName, setFixedName] = useState('');
  const isPending = row.status === 'pending';

  return (
    <div className="rounded-lg border border-gray-200 bg-white shadow-sm">
      <div className="flex items-start justify-between gap-2 border-b border-gray-100 bg-orange-50 px-3 py-2">
        <div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`rounded px-1.5 py-0.5 text-[11px] font-bold ${st.cls}`}>{st.text}</span>
            <span className="text-[11px] text-gray-500">z01_ragic_record_id: <span className="font-mono">{row.z01_ragic_record_id}</span></span>
          </div>
          <div className="mt-1 text-sm font-bold text-red-600">「{row.raw_name || '（空白）'}」</div>
          <div className="text-[11px] text-gray-500">抓取於 {fmtDate(row.fetched_at)}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1 px-3 py-2 text-xs">
        <div><span className="text-gray-500">電話：</span>{row.phone || '—'}</div>
        <div><span className="text-gray-500">館別：</span>{row.venue_raw || '—'}</div>
        <div><span className="text-gray-500">身分：</span>{row.identity_raw || '—'}</div>
        <div><span className="text-gray-500">性別：</span>{row.gender_raw || '—'}</div>
        <div><span className="text-gray-500">Email：</span>{row.email_raw || '—'}</div>
        <div><span className="text-gray-500">住家電話：</span>{row.home_phone_raw || '—'}</div>
        <div className="col-span-2"><span className="text-gray-500">住家地址：</span>{row.home_address_raw || '—'}</div>
        <div><span className="text-gray-500">LINE ID：</span>{row.line_id_raw || '—'}</div>
        <div><span className="text-gray-500">家教系統uid：</span>{row.line_uid_raw || '（尚未登入）'}</div>
      </div>

      {row.students && row.students.length > 0 ? (
        <div className="border-t border-gray-100 bg-blue-50 px-3 py-2">
          <div className="mb-1 text-[11px] font-bold text-blue-800">學員資料（{row.students.length} 位，原始值）</div>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-left text-gray-500">
                  <th className="pr-2">姓名</th><th className="pr-2">學員身分</th><th className="pr-2">出生年月日</th>
                  <th className="pr-2">性別</th><th className="pr-2">身分證字號</th><th className="pr-2">血型</th><th>學員編號</th>
                </tr>
              </thead>
              <tbody>
                {row.students.map((s) => (
                  <tr key={s.id}>
                    <td className="pr-2">{s.name_raw || '—'}</td>
                    <td className="pr-2">{s.student_status_raw || '—'}</td>
                    <td className="pr-2">{s.birth_date_raw || '—'}</td>
                    <td className="pr-2">{s.gender_raw || '—'}</td>
                    <td className="pr-2">{s.id_number_raw || '—'}</td>
                    <td className="pr-2">{s.blood_type_raw || '—'}</td>
                    <td>{s.student_code_raw || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {isPending ? (
        <div className="flex items-center gap-2 border-t border-gray-100 px-3 py-2">
          <input
            value={fixedName}
            onChange={(e) => setFixedName(e.target.value)}
            placeholder="輸入正確姓名"
            className="flex-1 rounded border border-gray-300 px-2 py-1 text-xs"
          />
          <button
            disabled={busy || !fixedName.trim()}
            onClick={() => onResolve(row.id, fixedName.trim())}
            className="whitespace-nowrap rounded bg-brand-primary px-3 py-1 text-xs font-bold text-white hover:bg-brand-teal disabled:opacity-50"
          >確認修正並寫回 Ragic</button>
          <button
            disabled={busy}
            onClick={() => onDismiss(row.id)}
            className="whitespace-nowrap rounded border border-gray-300 px-3 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >忽略（誤判）</button>
        </div>
      ) : (
        <div className="border-t border-gray-100 px-3 py-2 text-[11px] text-gray-500">
          {row.status === 'resolved' ? `已改為「${row.fixed_name}」` : '已標記為誤判，不會寫回 Ragic'}
          {row.resolved_at ? ` ・ ${fmtDate(row.resolved_at)}` : ''}
        </div>
      )}
    </div>
  );
}

function LoadError({ onRetry }) {
  return (
    <div className="rounded-lg border border-dashed border-red-200 bg-red-50 p-8 text-center">
      <div className="text-sm font-bold text-red-700">無法取得 Z03 列表</div>
      <div className="mt-1 text-xs text-red-500">後端暫時無法回應，請稍後重試。</div>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 rounded bg-brand-primary px-4 py-1.5 text-xs font-bold text-white hover:bg-brand-teal"
      >重新載入</button>
    </div>
  );
}

export default function RagicZ03Page() {
  const toast = useToast();
  const { logout } = useAuth();
  const [items, setItems] = useState(null);
  const [loadError, setLoadError] = useState(false);
  const [status, setStatus] = useState('pending');
  const [busy, setBusy] = useState(false);

  async function load() {
    setItems(null);
    setLoadError(false);
    try {
      const r = await ragicZ03Api.list(status);
      setItems(r.items || []);
    } catch (e) {
      if (e?.response?.status === 401) {
        toast.error('登入逾期，請重新登入');
        logout();
        return;
      }
      const msg = e?.response?.data?.error || e?.message || '載入失敗';
      toast.error(`Z03 人工整理表：${msg}`);
      setLoadError(true);
    }
  }
  useEffect(() => { load(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function resolve(id, fixedName) {
    setBusy(true);
    try {
      await ragicZ03Api.resolve(id, fixedName);
      toast.success('已寫回 Ragic，下次凌晨 01:00 同步後會自動出現在客戶資料裡');
      load();
    } catch (e) { toast.error(e?.response?.data?.error || '修正失敗'); }
    finally { setBusy(false); }
  }
  async function dismiss(id) {
    if (!window.confirm('確定要忽略這筆嗎？（判定為誤判，不會寫回 Ragic）')) return;
    setBusy(true);
    try {
      await ragicZ03Api.dismiss(id);
      toast.success('已忽略');
      load();
    } catch (e) { toast.error(e?.response?.data?.error || '忽略失敗'); }
    finally { setBusy(false); }
  }

  const counts = useMemo(() => {
    const c = { pending: 0, resolved: 0, dismissed: 0 };
    if (Array.isArray(items)) for (const r of items) c[r.status] = (c[r.status] || 0) + 1;
    return c;
  }, [items]);

  return (
    <div>
      <PageHeader
        title="Z03 舊系統資料整理"
        description="舊系統匯入批次裡「家長姓名」欄位其實是電話號碼（純數字）的記錄，會停在這裡（不會進入正式客戶資料 / 登入來源），確認正確姓名後寫回 Ragic 即可歸戶。"
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {['pending', 'resolved', 'dismissed', 'all'].map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={`rounded px-3 py-1 text-xs font-bold ${status === s ? 'bg-brand-primary text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
          >{s === 'all' ? '全部' : STATUS_LABEL[s]?.text}</button>
        ))}
      </div>

      {items === null && !loadError ? (
        <LoadingSpinner />
      ) : loadError ? (
        <LoadError onRetry={load} />
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-8 text-center text-sm text-gray-500">
          目前沒有資料。
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {items.map((row) => (
            <Z03Card key={row.id} row={row} busy={busy} onResolve={resolve} onDismiss={dismiss} />
          ))}
        </div>
      )}

      <div className="mt-6 rounded-lg bg-gray-50 p-4 text-xs text-gray-600">
        <div className="font-bold text-gray-700">說明</div>
        <ul className="mt-1 list-disc space-y-1 pl-4">
          <li>這裡列出的家長都<span className="font-bold">尚未有人用 LINE 登入過</span>，不會出現在「客戶資料管理」裡，也不影響任何現有使用者。</li>
          <li>「確認修正並寫回 Ragic」只會更動 Ragic 該筆的姓名欄位，不動其他欄位。</li>
          <li>寫回成功後這筆會標記「已修正」；下一次凌晨 01:00 全量同步時會自動歸戶進正式的客戶資料。</li>
          <li>若姓名之後在 Ragic 端又被改回電話號碼，下次同步會重新回到「待處理」。</li>
        </ul>
      </div>
    </div>
  );
}
