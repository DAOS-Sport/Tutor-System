import React, { useMemo, useState } from 'react';
import { maskIdNumber, maskBloodType } from '../utils/pii';

// 仿 Ragic Z02 表單格線的學員編輯器：左藍學員資料、右黃家長資訊(唯讀)、紫消費分析、灰購買紀錄。
const BLOOD_OPTS = ['不清楚', 'O', 'A', 'B', 'AB'];
const inputCls = 'w-full rounded border border-gray-300 px-2 py-1 text-xs focus:border-brand-teal focus:outline-none';

function Row({ label, required, children }) {
  return (
    <div className="flex items-stretch border-b border-gray-300">
      <div className="flex w-1/3 items-center gap-0.5 bg-gray-100 p-2 text-xs font-bold text-gray-700">
        {required && <span className="text-brand-error">*</span>}{label}
      </div>
      <div className="w-2/3 p-2 text-xs">{children}</div>
    </div>
  );
}

function ReadRow({ label, children }) {
  return (
    <div className="flex items-stretch border-b border-gray-300">
      <div className="w-1/3 bg-gray-100 p-2 text-xs text-gray-600">{label}</div>
      <div className="w-2/3 p-2 text-xs text-gray-800">{children}</div>
    </div>
  );
}

export default function RagicZ02Modal({ student: initStudent, reveal, busy, onClose, onSave }) {
  const [student, setStudent] = useState({ ...initStudent });
  const setS = (patch) => setStudent((s) => ({ ...s, ...patch }));
  const purchases = Array.isArray(initStudent.purchases) ? initStudent.purchases : [];

  // 依分類分組（常態團體班 / 課後班 / …），保留 Ragic 雙表外觀
  const groups = useMemo(() => {
    const by = {};
    for (const p of purchases) { (by[p.category || '其他課程'] ||= []).push(p); }
    return Object.entries(by);
  }, [purchases]);

  return (
    <div className="fixed inset-0 z-50 flex justify-center overflow-y-auto bg-black/50 p-3 md:p-8">
      <div className="h-fit w-full max-w-7xl overflow-hidden rounded-lg border border-gray-400 bg-gray-50 shadow-2xl">
        {/* 工具列 */}
        <div className="flex items-center justify-between border-b border-gray-300 bg-gray-100 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="rounded border border-gray-300 bg-white px-3 py-1 text-xs font-semibold text-gray-700 hover:bg-gray-50">← 返回</button>
            <button type="button" disabled={busy} onClick={() => onSave(student)}
              className="rounded bg-brand-primary px-4 py-1 text-xs font-semibold text-white hover:bg-brand-teal disabled:opacity-50">{busy ? '儲存中…' : '保存變更'}</button>
            <span className="ml-2 text-[11px] text-gray-500">僅修改學員資料；新增請走 Z01 家長子表。</span>
          </div>
          <button type="button" onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600">✕</button>
        </div>

        <div className="border-b border-gray-200 bg-white px-6 py-3">
          <h2 className="text-xl font-bold text-brand-primary">Z02 學員資料管理（含購買紀錄查詢）</h2>
        </div>

        <div className="grid grid-cols-1 gap-6 p-6 lg:grid-cols-12">
          {/* 左：學員資料（藍） */}
          <div className="space-y-4 lg:col-span-4">
            <div className="overflow-hidden rounded border border-gray-300 shadow-sm">
              <div className="bg-blue-700 py-1.5 text-center text-xs font-bold text-white">學員資料</div>
              <div className="bg-gray-50">
                <ReadRow label="學員編號"><span className="font-mono font-bold text-blue-700">{student.student_code || '—'}</span></ReadRow>
                <Row label="學員姓名" required><input className={`${inputCls} font-bold`} value={student.name || ''} onChange={(e) => setS({ name: e.target.value })} /></Row>
                <Row label="(學)性別" required>
                  <select className={inputCls} value={student.gender || '生理男'} onChange={(e) => setS({ gender: e.target.value })}>
                    <option value="生理男">生理男</option><option value="生理女">生理女</option>
                  </select>
                </Row>
                <Row label="出生年月日" required><input className={`${inputCls} font-mono`} value={student.birth_date || ''} onChange={(e) => setS({ birth_date: e.target.value })} placeholder="2019-04-04" /></Row>
                <Row label="身分證字號" required>
                  {reveal
                    ? <input className={`${inputCls} font-mono`} value={student.id_number || ''} onChange={(e) => setS({ id_number: e.target.value.toUpperCase() })} />
                    : <span className="font-mono text-gray-500">{maskIdNumber(student.id_number, false)} <span className="text-[10px] text-gray-400">（按「顯示個資」可編輯）</span></span>}
                </Row>
                <Row label="血型" required>
                  {reveal
                    ? <select className={inputCls} value={student.blood_type || '不清楚'} onChange={(e) => setS({ blood_type: e.target.value })}>{BLOOD_OPTS.map((b) => <option key={b} value={b}>{b}</option>)}</select>
                    : <span className="text-gray-500">{maskBloodType(student.blood_type, false)}</span>}
                </Row>
              </div>
            </div>
            <div className="space-y-1 rounded border border-gray-300 bg-white p-3 text-[11px] font-mono text-gray-500">
              <div>Ragic Node：{student.ragic_record_id || '—'}</div>
              <div>系統 UUID：{student.id}</div>
              <div>最後同步：{student.last_synced_at || '未同步'}</div>
            </div>
          </div>

          {/* 右：家長資訊(黃) + 消費 + 緊急聯絡人 */}
          <div className="space-y-6 lg:col-span-8">
            <div className="overflow-hidden rounded border border-gray-300 shadow-sm">
              <div className="bg-amber-500 py-1.5 text-center text-xs font-bold text-white">家長資訊（唯讀 · 由 Z01 維護）</div>
              <div className="grid grid-cols-1 bg-gray-50 md:grid-cols-2">
                <div className="border-gray-300 md:border-r">
                  <ReadRow label="家長姓名"><b>{student.parent_name || '無家長綁定'}</b></ReadRow>
                  <ReadRow label="(報)行動電話"><span className="font-mono">{student.parent_phone || '—'}</span></ReadRow>
                  <ReadRow label="(報)性別">{student.parent_gender || '—'}</ReadRow>
                </div>
                <div>
                  <ReadRow label="(報)身分">{student.parent_identity || '—'}</ReadRow>
                  <ReadRow label="(報)Email"><span className="text-blue-600">{student.parent_email || '—'}</span></ReadRow>
                  <ReadRow label="所屬館別">{student.parent_venue_id || '—'}</ReadRow>
                </div>
              </div>
            </div>

            {/* 消費分析（紫） */}
            <div className="overflow-hidden rounded border border-gray-300 shadow-sm">
              <div className="bg-violet-500 py-1 text-center text-xs font-bold text-white">消費分析</div>
              <div className="grid grid-cols-3 gap-3 bg-gray-50 p-3 text-xs">
                <div className="rounded border border-gray-200 bg-white p-2 text-center"><div className="text-gray-500">總購買期數</div><div className="text-lg font-extrabold text-brand-primary">{purchases.length}</div></div>
                <div className="rounded border border-gray-200 bg-white p-2 text-center"><div className="text-gray-500">課程分類數</div><div className="text-lg font-extrabold text-brand-teal">{groups.length}</div></div>
                <div className="rounded border border-gray-200 bg-white p-2 text-center"><div className="text-gray-500">進行中</div><div className="text-lg font-extrabold text-brand-green">{purchases.filter((p) => /進行|active|報名/.test(p.status || '')).length}</div></div>
              </div>
            </div>

            {/* 購買紀錄（灰，依分類分組） */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              {groups.length === 0 ? (
                <div className="rounded border border-dashed border-gray-300 bg-white p-6 text-center text-xs text-gray-400 md:col-span-2">
                  目前無購買紀錄（舊系統消費紀錄尚未清洗匯入）。
                </div>
              ) : groups.map(([cat, rows]) => (
                <div key={cat} className="overflow-hidden rounded border border-gray-300 shadow-sm">
                  <div className="bg-gray-500 px-3 py-1 text-xs font-bold text-white">購買紀錄（{cat}）</div>
                  <table className="w-full border-collapse bg-white text-left text-[11px]">
                    <thead>
                      <tr className="border-b border-gray-200 bg-gray-50 font-bold text-gray-500">
                        <th className="p-1.5">狀態</th><th className="p-1.5">報名日</th><th className="p-1.5">堂數</th><th className="p-1.5">金額</th><th className="p-1.5">期別</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((p) => (
                        <tr key={p.id} className="border-b border-gray-100">
                          <td className="p-1.5 font-bold text-emerald-700">{p.status}</td>
                          <td className="p-1.5 font-mono">{p.date || '—'}</td>
                          <td className="p-1.5 font-mono">{p.sessions || '—'}</td>
                          <td className="p-1.5 font-mono text-gray-600">{p.price != null ? `$${p.price}` : '—'}</td>
                          <td className="p-1.5 font-mono text-gray-400">{p.period_number ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ))}
            </div>

            {/* 緊急聯絡人（粉，Ragic 端維護，暫不鏡像） */}
            <div className="overflow-hidden rounded border border-gray-300 shadow-sm">
              <div className="bg-rose-500 px-4 py-1.5 text-xs font-bold text-white">緊急聯絡人</div>
              <div className="bg-white p-4 text-center text-xs text-gray-400">此資料於 Ragic 端維護，本系統暫不鏡像。</div>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t border-gray-200 bg-gray-100 px-6 py-4 text-xs">
          <button type="button" onClick={onClose} className="rounded border border-gray-300 px-5 py-2 font-semibold text-gray-700 hover:bg-gray-200">取消關閉</button>
          <button type="button" disabled={busy} onClick={() => onSave(student)}
            className="rounded bg-brand-primary px-5 py-2 font-semibold text-white hover:bg-brand-teal disabled:opacity-50">{busy ? '儲存中…' : '確定保存學籍'}</button>
        </div>
      </div>
    </div>
  );
}
