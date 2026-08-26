import React from 'react';

/**
 * 通用 DataTable —— 桌機是表格，手機（md 以下）是卡片。
 *
 * columns: [{ key, label, render?(row, idx), className?, mobile? }]
 *   mobile: 'title' | 'status' | 'meta' | 'action' | 'hide'
 * rows:    [obj...]
 * rowKey:  (row, idx) => string
 *
 * ── 為什麼手機要換成卡片 ──
 * 12 個頁面用這個元件，欄數 4~14 欄。每格 px-4 就佔 32px，375px 螢幕扣掉
 * main 的 p-4 只剩 311px —— 光是內距，10 欄以上的頁面就已經超過整個可視寬。
 * 實測 StaffPage 表寬約 1,400px，要橫拖 4~5 個螢幕。而「操作」欄幾乎都在
 * 最右邊，等於每按一次都要先拖到底；拖到底時姓名/編號又捲出畫面了，
 * 根本不知道自己在按哪一筆。
 *
 * ── 為什麼是這個密度 ──
 * 參考蝦皮的商品列表：卡片但高密度，一屏仍看得到 5~6 筆，卡片之間用細灰縫
 * 分隔而不是各自加邊框。刻意不做成 Uber 那種一屏一件事 —— 櫃檯在對帳頁是
 * 掃描型任務（在一堆裡找末 5 碼），一屏只剩 3 筆會讓那件事變慢。
 *
 * ── 沒標註 mobile 的頁面也要能看 ──
 * 12 個呼叫端共 105 個欄位定義。若要求每個都先標註才有卡片，這件事就會
 * 卡在「先改 12 頁」而永遠不會發生。所以沒標註時自動推：
 *   第一欄 → 標題（識別欄幾乎都排在第一個）
 *   欄名含「狀態」→ 狀態 pill
 *   欄名含「操作」→ 動作列
 *   其餘 → 次要資訊，最多取 4 個（再多手機上讀不完）
 * 頁面之後再逐一標註來微調，不標也不會壞。
 */

const MOBILE_ROLES = ['title', 'status', 'meta', 'action', 'hide'];

function classify(columns) {
  const out = { title: null, status: null, meta: [], action: [] };
  columns.forEach((c, i) => {
    const explicit = MOBILE_ROLES.includes(c.mobile) ? c.mobile : null;
    const label = String(c.label || '');
    const role = explicit
      || (i === 0 ? 'title'
        : /狀態|狀況/.test(label) ? 'status'
          : /操作|動作/.test(label) ? 'action'
            : 'meta');
    if (role === 'hide') return;
    if (role === 'title' && !out.title) out.title = c;
    else if (role === 'status' && !out.status) out.status = c;
    else if (role === 'action') out.action.push(c);
    else if (out.meta.length < 4) out.meta.push(c);
  });
  // 完全沒有第一欄可當標題時退回第一個 meta，卡片不能沒有標頭
  if (!out.title && out.meta.length) out.title = out.meta.shift();
  return out;
}

const cell = (c, row, idx) => (c.render ? c.render(row, idx) : row[c.key]);

export default function DataTable({ columns, rows, rowKey, empty = '目前沒有資料', className = '', onRowClick }) {
  if (!rows || rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-gray-300 bg-white py-10 text-center text-sm text-gray-500 md:py-12">
        {empty}
      </div>
    );
  }

  const m = classify(columns);

  return (
    <>
      {/* ── 手機：卡片 ── */}
      <div className={`flex flex-col gap-1.5 md:hidden ${className}`}>
        {rows.map((row, idx) => {
          const key = rowKey ? rowKey(row, idx) : idx;
          const clickable = !!onRowClick;
          return (
            <div
              key={key}
              onClick={clickable ? () => onRowClick(row, idx) : undefined}
              className={`rounded-xl border border-gray-200 bg-white px-3 py-2.5 shadow-sm ${clickable ? 'active:bg-gray-50' : ''}`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1 text-sm font-bold text-gray-900">
                  {m.title ? cell(m.title, row, idx) : null}
                </div>
                {m.status && <div className="shrink-0">{cell(m.status, row, idx)}</div>}
              </div>

              {/* 次要資訊：不標欄名，用 · 串起來，最多兩行。
                  [&_div]:inline 是必要的：欄位的 render 是為表格格子寫的，
                  輸出本身就是多行（「家長」那欄輸出姓名 + 電話兩個 div，
                  「教練/場館」也是）。不把 div 壓成 inline 的話 truncate 完全沒用，
                  卡片實測 156px、一屏只有 3 張。只壓 div 與 p ——
                  徽章是 inline-flex 的 span，壓了會失去內距與圓角。
                  第一版做成「標籤 + 值」的兩欄格，卡片高度 166px，一屏只剩 3 張 ——
                  那是 Uber 的密度，不是蝦皮的。蝦皮的商品卡不標欄名，
                  因為值本身就看得懂（人名、場館、日期）。拿掉標籤之後
                  卡片降到 ~90px，一屏回到 6 張。 */}
              {m.meta.length > 0 && (
                <div className="mt-1 space-y-0.5">
                  <div className="truncate text-[13px] leading-5 text-gray-700 [&_div]:inline [&_p]:inline [&_br]:hidden [&_div+div]:ml-1.5 [&_p+p]:ml-1.5">
                    {m.meta.slice(0, 2).map((c, i) => (
                      <React.Fragment key={c.key}>
                        {i > 0 && <span className="mx-1.5 text-gray-300">·</span>}
                        {cell(c, row, idx)}
                      </React.Fragment>
                    ))}
                  </div>
                  {m.meta.length > 2 && (
                    <div className="truncate text-[12px] leading-4 text-gray-400 [&_div]:inline [&_p]:inline [&_br]:hidden [&_div+div]:ml-1.5 [&_p+p]:ml-1.5">
                      {m.meta.slice(2).map((c, i) => (
                        <React.Fragment key={c.key}>
                          {i > 0 && <span className="mx-1.5 text-gray-300">·</span>}
                          {cell(c, row, idx)}
                        </React.Fragment>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {m.action.length > 0 && (
                /* 動作列不要繼承整張卡的點擊：卡片本身可能已經綁了開詳情，
                   而動作多半是破壞性的（撤銷、退費、刪除）。 */
                <div
                  className="mt-2 flex flex-wrap items-center gap-2 border-t border-gray-100 pt-2"
                  onClick={(e) => e.stopPropagation()}
                >
                  {m.action.map((c) => (
                    <React.Fragment key={c.key}>{cell(c, row, idx)}</React.Fragment>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── 桌機：維持原本的表格，一行都沒動 ── */}
      <div className={`hidden overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm md:block ${className}`}>
        <table className="min-w-full divide-y divide-gray-200 text-sm">
          <thead className="bg-gray-50">
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={`px-4 py-3 text-left text-xs font-bold uppercase tracking-wider text-gray-600 ${c.className || ''}`}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((row, idx) => (
              <tr
                key={rowKey ? rowKey(row, idx) : idx}
                className={`hover:bg-gray-50 ${onRowClick ? 'cursor-pointer' : ''}`}
                onClick={onRowClick ? () => onRowClick(row, idx) : undefined}
              >
                {columns.map((c) => (
                  <td key={c.key} className={`px-4 py-3 align-middle text-gray-800 ${c.className || ''}`}>
                    {cell(c, row, idx)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
