import React, { useEffect, useMemo, useState } from 'react';
import { sessionsApi } from '../api/sessions';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import LoadingSpinner from '../components/LoadingSpinner';
import { EnrollmentRow, EnrollmentStats, ENROLL_STAGES } from '../components/coach/EnrollmentRow';

/**
 * 教練端「報名記錄」—— 底部導覽第二個分頁。
 *
 * ── 為什麼獨立成分頁 ──
 * 原本是首頁「學生報名狀態」的前 5 筆預覽 + 一個小入口。教練實際要判斷的是
 * 「哪些還在上、哪些卡在對帳、哪些已經結束」，5 筆看不出全貌，所以拆出來。
 *
 * ── 刻意不顯示金額與發票號碼 ──
 * 教練端目前所有頁面都沒有暴露過金流資訊。教練需要判斷的是「這單卡在哪」，
 * 不是「收了多少」。要加回來只是多兩個欄位，但那是擴大可見範圍，需 Owner 決定。
 * 後端 GET /sessions/coach/:id/enrollments 本來就不 SELECT 金額（見該處註解）。
 *
 * ── 標題自己放 ──
 * 改成分頁後路由掛在 <AppLayout />（無 showBackButton、無 title），
 * 頂欄不再給標題，所以這裡要自己有 h1。
 */
function FilterChip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 rounded-full border px-3 py-1 text-xs transition ${
        active
          ? 'border-brand-primary bg-brand-primary text-white'
          : 'border-brand-primary/30 bg-white text-brand-primary hover:bg-brand-primary/5'
      }`}
    >
      {children}
    </button>
  );
}

export default function CoachOrdersPage() {
  const { coach } = useAuth();
  const toast = useToast();
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    if (!coach?.id) return undefined;
    let alive = true;
    sessionsApi.enrollmentsByCoach(coach.id)
      .then((d) => alive && setData(d || { counts: {}, items: [] }))
      .catch(() => {
        if (!alive) return;
        setData({ counts: {}, items: [] });
        toast.error('訂單紀錄載入失敗');
      });
    return () => { alive = false; };
  }, [coach?.id, toast]);

  // 只列真的有資料的狀態。全給的話會出現永遠點不出東西的死 chip ——
  // 'active' 在整個 codebase 沒有任何寫入點（只有舊匯入資料才有），
  // 掛在那裡等於騙教練說「有這一類」。
  const filters = useMemo(() => {
    const c = data?.counts || {};
    return [{ key: 'all', label: '全部', n: null }].concat(
      ENROLL_STAGES
        .filter((s) => (c[s.key] || 0) > 0)
        .map((s) => ({ key: s.key, label: s.label, n: c[s.key] }))
    );
  }, [data]);

  const items = useMemo(() => {
    const all = data?.items || [];
    return filter === 'all' ? all : all.filter((it) => it.status === filter);
  }, [data, filter]);

  if (!coach) return null;

  return (
    <div className="pb-4">
      <header className="sticky top-0 z-10 border-b border-gray-100 bg-white px-4 py-2.5">
        <div className="mb-2 flex items-baseline justify-between">
          <h1 className="text-base font-bold text-brand-primary">報名記錄</h1>
          <span className="shrink-0 text-xs text-gray-500">
            {data === null ? '載入中…' : `共 ${data.total ?? (data.items || []).length} 筆`}
          </span>
        </div>
        {/* 數字一律顯示，0 也顯示 —— 見下方 filters 的註解。
            判斷用 f.n != null 而不是 f.n，否則 0 會被當成 falsy 而整個消失。 */}
        <div className="flex flex-wrap items-center gap-1.5">
          {filters.map((f) => (
            <FilterChip key={f.key} active={filter === f.key} onClick={() => setFilter(f.key)}>
              {f.label}{f.n != null ? ` ${f.n}` : ''}
            </FilterChip>
          ))}
        </div>
      </header>

      <div className="px-4 pt-3">
        {data === null && <LoadingSpinner label="載入中…" />}
        {data !== null && items.length === 0 && (
          <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50 p-6 text-center text-sm text-gray-500">
            {(data.items || []).length === 0
              ? '目前沒有你名下的報名紀錄。'
              : '沒有符合這個狀態的訂單。'}
          </div>
        )}
        {items.length > 0 && (
          <>
            <EnrollmentStats counts={data.counts} />
            <div className="space-y-2">
              {items.map((it) => <EnrollmentRow key={it.id} item={it} detailed />)}
            </div>
            {/* 教練看得到「卡住」，但處理是櫃檯的事 —— 講清楚下一步該找誰，
                否則他只會看著待對帳乾等，或跑去催已經轉完帳的家長。 */}
            <p className="pt-3 text-center text-[11px] leading-5 text-gray-400">
              待對帳＝家長已送出報名、櫃檯尚未完成對帳。<br />
              需要催辦或修改請洽櫃檯。
            </p>
          </>
        )}
      </div>
    </div>
  );
}
