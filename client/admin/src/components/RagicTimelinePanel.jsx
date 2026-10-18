import React, { useEffect, useRef, useState } from 'react';
import { http } from '../api/client';

export default function RagicTimelinePanel() {
  const [nodes, setNodes] = useState([]);
  const [selected, setSelected] = useState('');
  const [view, setView] = useState(null);
  const [syntheticOnly, setSyntheticOnly] = useState(false);
  const [state, setState] = useState('loading');
  const generation = useRef(0);
  useEffect(() => {
    let active = true;
    http.get('/ragic-timeline', { skipAuthRedirect: true }).then(({ data }) => {
      if (active) { setNodes(data.nodes); setSyntheticOnly(data.syntheticOnly === true); setState(data.nodes.length ? 'ready' : 'empty'); }
    }).catch((error) => { if (active) setState(error.response?.data?.code === 'TIMELINE_DISABLED' ? 'disabled' : 'error'); });
    return () => { active = false; generation.current += 1; };
  }, []);
  async function select(id) {
    const current = ++generation.current;
    setSelected(id); setView(null);
    if (!id) { setState('ready'); return; }
    setState('loading-node');
    try {
      const { data } = await http.get(`/ragic-timeline/${encodeURIComponent(id)}`, { skipAuthRedirect: true });
      if (current === generation.current) { setView(data); setState('ready'); }
    } catch { if (current === generation.current) setState('error'); }
  }
  const time = (value) => new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(value));
  return <section className="my-4 rounded-lg border bg-white p-4" aria-label="每日資料節點">
    <h2 className="font-bold">每日資料節點（唯讀）</h2>
    {syntheticOnly && <p className="text-amber-800" role="status">隔離合成資料示範；不是實際業務歷史或已啟用的 Ragic 同步。</p>}
    <p className="text-sm text-gray-600">查看已完成節點的歷史資料，不會恢復、覆寫目前資料或發送同步。時間以台北顯示。</p>
    {state === 'disabled' ? <p>時間線尚未啟用。</p> : <>
      <label className="block my-2">選擇每日節點
        <select className="block w-full max-w-xl rounded border p-2" value={selected} onChange={(event) => select(event.target.value)} disabled={!nodes.length}>
          <option value="">請選擇節點</option>
          {nodes.map((node) => <option key={node.id} value={node.id}>{node.businessDate} · 實際截止 {time(node.actualCutoff)}</option>)}
        </select>
      </label>
      {state.startsWith('loading') && <p role="status">讀取並驗證節點中…</p>}
      {state === 'empty' && <p>沒有可重建的每日節點；不以目前資料代替歷史。</p>}
      {state === 'error' && <p role="alert" className="text-red-700">節點目前無法驗證或重建，未顯示替代資料。請重新選擇或稍後重試。</p>}
      {view && <><p>唯讀截止：{time(view.node.actualCutoff)}（{view.node.actualCutoff}）</p>
        {!view.node.boundaryMet && <p role="status">此節點未準時取得；以上述實際截止時間為準。</p>}
        <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th>類型</th><th>姓名</th><th>學員生日</th></tr></thead>
          <tbody>{view.rows.map((row) => <tr key={row.key}><td>{row.key.startsWith('student:') ? '學員' : '家長'}</td><td>{row.name ?? '—'}</td><td>{row.birthDate ?? '—'}</td></tr>)}</tbody></table></div>
      </>}
    </>}
  </section>;
}
