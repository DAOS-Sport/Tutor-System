import React, { useState } from 'react';
import { formatTWDateTime } from '../utils/format';

// 仿 Ragic Z01 表單格線的家長編輯器（橘色家長資訊 + 藍色學員子表）。
// 欄位只綁定 Replit 實際鏡像欄位；line_uid（登入鍵）唯讀，不在此更動。

const BLOOD_OPTS = ['不清楚', 'O', 'A', 'B', 'AB'];

function rocAge(birth) {
  if (!birth) return '';
  const m = String(birth).replace(/-/g, '/').match(/^(\d{2,4})\//);
  if (!m) return '';
  let y = parseInt(m[1], 10);
  if (y < 1911) y += 1911;
  const age = 2026 - y;
  return age > 0 && age < 120 ? age : '';
}

function Cell({ label, required, children }) {
  return (
    <div className="flex items-stretch border-b border-gray-300">
      <div className="flex w-1/3 items-center gap-0.5 bg-gray-100 p-2 text-xs font-bold text-gray-700">
        {required && <span className="text-brand-error">*</span>}{label}
      </div>
      <div className="w-2/3 p-2 text-xs">{children}</div>
    </div>
  );
}

const inputCls = 'w-full rounded border border-gray-300 px-2 py-1 text-xs focus:border-brand-teal focus:outline-none';

export default function RagicZ01Modal({ isNew, parent: initParent, students: initStudents, venues, busy, onClose, onSave }) {
  const [parent, setParent] = useState({ ...initParent });
  const [kids, setKids] = useState((initStudents || []).map((s) => ({ ...s })));
  const [tab, setTab] = useState('other');

  const setP = (patch) => setParent((p) => ({ ...p, ...patch }));
  const setKid = (i, patch) => setKids((arr) => arr.map((k, idx) => (idx === i ? { ...k, ...patch } : k)));
  const addKid = () => setKids((arr) => [...arr, {
    id: null, name: '', gender: '生理男', birth_date: '', id_number: '', blood_type: '不清楚',
    student_code: '', is_active: true,
  }]);

  return (
    <div className="fixed inset-0 z-50 flex justify-center overflow-y-auto bg-black/50 p-3 md:p-8">
      <div className="h-fit w-full max-w-6xl overflow-hidden rounded-lg border border-gray-400 bg-white shadow-2xl">
        {/* 工具列 */}
        <div className="flex items-center justify-between border-b border-gray-300 bg-gray-100 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose}
              className="rounded border border-gray-300 bg-white px-3 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-50">← 返回</button>
            <button type="button" disabled={busy} onClick={() => onSave(parent, kids)}
              className="rounded bg-brand-primary px-4 py-1 text-xs font-semibold text-white hover:bg-brand-teal disabled:opacity-50">
              {busy ? '儲存中…' : '保存變更'}</button>
            <span className="ml-2 font-mono text-[11px] text-gray-500">Ragic 連結：{parent.ragic_record_id || 'LOCAL-NEW'}</span>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600">✕</button>
        </div>

        <div className="border-b border-gray-200 px-6 py-3">
          <h2 className="flex items-center gap-2 text-xl font-bold text-brand-primary">
            Z01 家長 &amp; 學員關係管理
            {isNew
              ? <span className="rounded-full bg-brand-green px-2 py-0.5 text-xs text-white">新增</span>
              : <span className="rounded-full bg-brand-teal px-2 py-0.5 text-xs text-white">編輯本地鏡像</span>}
          </h2>
        </div>

        <div className="space-y-6 p-6">
          {/* 家長資訊 — 橘色 */}
          <div className="overflow-hidden rounded border border-gray-300">
            <div className="bg-orange-500 py-1.5 text-center text-xs font-bold tracking-wider text-white">家長資訊</div>
            <div className="grid grid-cols-1 bg-gray-50 md:grid-cols-2">
              <div className="border-gray-300 md:border-r">
                <Cell label="家長姓名" required>
                  <input className={inputCls} value={parent.name || ''} onChange={(e) => setP({ name: e.target.value })} />
                </Cell>
                <Cell label="(報)行動電話" required>
                  <input className={`${inputCls} font-mono`} value={parent.phone || ''} onChange={(e) => setP({ phone: e.target.value })} />
                </Cell>
                <Cell label="(報)性別" required>
                  <select className={inputCls} value={parent.gender || ''} onChange={(e) => setP({ gender: e.target.value })}>
                    <option value="生理女">生理女</option><option value="生理男">生理男</option>
                  </select>
                </Cell>
              </div>
              <div>
                <Cell label="(報)Email" required>
                  <input className={inputCls} value={parent.email || ''} onChange={(e) => setP({ email: e.target.value })} />
                </Cell>
                <Cell label="館別" required>
                  <select className={inputCls} value={parent.primary_venue_id || ''} onChange={(e) => setP({ primary_venue_id: e.target.value })}>
                    <option value="">未設場館</option>
                    {venues.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                </Cell>
                <Cell label="(報)身分" required>
                  <select className={inputCls} value={parent.identity || ''} onChange={(e) => setP({ identity: e.target.value })}>
                    <option value="一般身份">一般身份</option>
                    <option value="教練/員工">教練 / 員工</option>
                    <option value="行政櫃檯">行政櫃檯</option>
                  </select>
                </Cell>
              </div>
            </div>
          </div>

          {/* 分頁卡：其他資料 / 系統資訊 */}
          <div className="overflow-hidden rounded border border-gray-300">
            <div className="flex border-b border-gray-300 bg-gray-100 text-xs">
              {[['other', '其他資料'], ['system', '系統資訊（唯讀）']].map(([k, t]) => (
                <button key={k} type="button" onClick={() => setTab(k)}
                  className={`border-r border-gray-300 px-4 py-2 font-bold ${tab === k ? 'bg-white text-brand-primary' : 'text-gray-500 hover:bg-white/60'}`}>{t}</button>
              ))}
            </div>
            {tab === 'other' ? (
              <div className="grid grid-cols-1 gap-3 bg-white p-4 text-xs md:grid-cols-2">
                <label className="flex items-center gap-2"><span className="w-20 font-bold text-gray-600">住家電話</span>
                  <input className={inputCls} value={parent.home_phone || ''} onChange={(e) => setP({ home_phone: e.target.value })} /></label>
                <label className="flex items-center gap-2"><span className="w-20 font-bold text-gray-600">LINE ID</span>
                  <input className={inputCls} value={parent.line_id || ''} onChange={(e) => setP({ line_id: e.target.value })} /></label>
                <label className="flex items-center gap-2 md:col-span-2"><span className="w-20 font-bold text-gray-600">住家地址</span>
                  <input className={inputCls} value={parent.home_address || ''} onChange={(e) => setP({ home_address: e.target.value })} /></label>
              </div>
            ) : (
              <div className="space-y-1.5 bg-white p-4 text-xs text-gray-600">
                <p><b>LINE 登入識別碼 (line_uid)：</b><span className="font-mono text-brand-primary">{parent.line_uid || '尚未綁定'}</span>
                  <span className="ml-2 text-[10px] text-gray-400">登入鍵 · 唯讀，不在此更動</span></p>
                <p><b>Ragic Node：</b><span className="font-mono">{parent.ragic_record_id || '—'}</span></p>
                <p><b>系統 UUID：</b><span className="font-mono">{parent.id || '（建立後產生）'}</span></p>
                <p><b>Family ID（家庭組 · 背景預留）：</b><span className="font-mono">{parent.family_id || '—'}</span></p>
                <p><b>最後同步：</b><span className="font-mono">{parent.last_synced_at ? formatTWDateTime(parent.last_synced_at) : '未同步'}</span></p>
              </div>
            )}
          </div>

          {/* 學員子表 — 藍色 */}
          <div className="overflow-hidden rounded border border-gray-300">
            <div className="flex items-center justify-between bg-blue-700 px-4 py-2 text-xs font-bold text-white">
              <span>學員資料（子表）</span>
              <button type="button" onClick={addKid} className="rounded bg-white px-3 py-1 text-[11px] font-black text-blue-800 hover:bg-gray-100">＋ 增加學員</button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-gray-300 bg-gray-100 font-bold text-gray-600">
                    {['項次', '學員姓名 *', '出生年月日 *', '(學)性別 *', '身分證字號 *', '血型 *', '歲數', '學員編號', '狀態', '動作'].map((h) => (
                      <th key={h} className="border-r border-gray-200 p-2">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {kids.length === 0 ? (
                    <tr><td colSpan={10} className="p-6 text-center text-gray-400">點右上「增加學員」即可在此家長底下建立並綁定學員</td></tr>
                  ) : kids.map((kid, i) => (
                    <tr key={kid.id || `new-${i}`} className={kid.is_active ? '' : 'bg-brand-error-soft/60 opacity-70'}>
                      <td className="border-r border-gray-200 p-2 text-center font-bold text-gray-500">{i + 1}</td>
                      <td className="border-r border-gray-200 p-2"><input className={`${inputCls} font-bold`} value={kid.name || ''} onChange={(e) => setKid(i, { name: e.target.value })} placeholder="學員姓名" /></td>
                      <td className="border-r border-gray-200 p-2"><input className={`${inputCls} font-mono`} value={kid.birth_date || ''} onChange={(e) => setKid(i, { birth_date: e.target.value })} placeholder="2019-04-04 或 108/04/04" /></td>
                      <td className="border-r border-gray-200 p-2">
                        <select className={inputCls} value={kid.gender || '生理男'} onChange={(e) => setKid(i, { gender: e.target.value })}>
                          <option value="生理男">生理男</option><option value="生理女">生理女</option>
                        </select>
                      </td>
                      <td className="border-r border-gray-200 p-2">
                        <input className={`${inputCls} font-mono`} value={kid.id_number || ''} onChange={(e) => setKid(i, { id_number: e.target.value.toUpperCase() })} placeholder="A123456789" />
                      </td>
                      <td className="border-r border-gray-200 p-2">
                        <select className={inputCls} value={kid.blood_type || '不清楚'} onChange={(e) => setKid(i, { blood_type: e.target.value })}>
                          {BLOOD_OPTS.map((b) => <option key={b} value={b}>{b}</option>)}
                        </select>
                      </td>
                      <td className="border-r border-gray-200 p-2 text-center font-mono text-gray-700">{rocAge(kid.birth_date) || '—'}</td>
                      <td className="border-r border-gray-200 p-2"><input className={`${inputCls} font-mono`} value={kid.student_code || ''} onChange={(e) => setKid(i, { student_code: e.target.value })} /></td>
                      <td className="border-r border-gray-200 p-2 text-center">
                        <span className={`rounded px-2 py-0.5 text-[10px] font-bold ${kid.is_active ? 'bg-brand-green/10 text-brand-green' : 'bg-brand-error-soft text-brand-error-strong'}`}>
                          {kid.is_active ? '在籍' : '停用'}</span>
                      </td>
                      <td className="p-2 text-center">
                        <button type="button" onClick={() => setKid(i, { is_active: !kid.is_active })}
                          className={`rounded px-2 py-1 text-[11px] font-bold ${kid.is_active ? 'text-brand-amber' : 'text-brand-green'} hover:underline`}>
                          {kid.is_active ? '停用' : '啟用'}</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-gray-200 bg-gray-50 px-6 py-4 text-xs">
          <button type="button" onClick={onClose} className="rounded border border-gray-300 px-5 py-2 font-semibold text-gray-700 hover:bg-gray-100">放棄並關閉</button>
          <button type="button" disabled={busy} onClick={() => onSave(parent, kids)}
            className="rounded bg-brand-primary px-5 py-2 font-semibold text-white hover:bg-brand-teal disabled:opacity-50">
            {busy ? '儲存中…' : '確定保存'}</button>
        </div>
      </div>
    </div>
  );
}
