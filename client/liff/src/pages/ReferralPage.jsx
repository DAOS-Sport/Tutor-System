import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { coachesApi } from '../api/coaches';
import { referralsApi } from '../api/referrals';
import LoadingSpinner from '../components/LoadingSpinner';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

const STATUS_LABEL = {
  pending: '已產生連結（尚未註冊）',
  registered: '新客戶已註冊',
  trial_paid: '已下訂體驗課',
  checked_in: '體驗課已簽到',
  reward_issued: '獎勵已發放 🎁',
};

export default function ReferralPage() {
  const navigate = useNavigate();
  const { parent } = useAuth();
  const toast = useToast();
  const [coaches, setCoaches] = useState(null);
  const [mine, setMine] = useState([]);
  const [busy, setBusy] = useState(null); // coachId during creation
  const [generated, setGenerated] = useState(null); // { coachName, url }

  useEffect(() => {
    let alive = true;
    Promise.all([
      coachesApi.list(parent?.primary_venue_id ? { venueId: parent.primary_venue_id } : {}),
      referralsApi.mine(),
    ]).then(([cs, m]) => {
      if (!alive) return;
      setCoaches(cs || []);
      setMine(m || []);
    }).catch(() => alive && toast.error('資料載入失敗'));
    return () => { alive = false; };
  }, [parent, toast]);

  async function handleCreate(c) {
    setBusy(c.id);
    try {
      const r = await referralsApi.create(c.id);
      setGenerated({ coachName: c.name, url: r.url });
      const m = await referralsApi.mine();
      setMine(m || []);
    } catch {
      toast.error('產生連結失敗');
    } finally {
      setBusy(null);
    }
  }

  async function handleCopy(url) {
    try { await navigator.clipboard.writeText(url); toast.success('已複製連結'); }
    catch { toast.error('複製失敗，請長按連結手動複製'); }
  }

  function shareToLine(url, coachName) {
    const text = encodeURIComponent(`我推薦 ${coachName} 教練！新學員體驗課直接 5 折 → ${url}`);
    window.open(`https://line.me/R/msg/text/?${text}`, '_blank');
  }

  if (coaches === null) return <LoadingSpinner fullPage label="載入推薦資料…" />;

  return (
    <div className="px-4 py-4 pb-10">
      <div className="mb-4 rounded-2xl bg-gradient-to-br from-brand-green to-brand-teal p-4 text-white">
        <h2 className="text-base font-bold">🎁 邀請好友拿獎勵</h2>
        <p className="mt-1 text-xs opacity-90">朋友透過你的連結報名體驗課，朋友享 5 折體驗，你得 9 折正期券！</p>
      </div>

      {generated && (
        <div className="mb-4 rounded-xl border border-brand-green/40 bg-green-50 p-3">
          <div className="text-xs font-bold text-brand-green">{generated.coachName} 推薦連結已產生</div>
          <div className="mt-1 break-all rounded-md bg-white px-2 py-1.5 font-mono text-[11px] text-gray-700">
            {generated.url}
          </div>
          <div className="mt-2 flex gap-2">
            <button onClick={() => handleCopy(generated.url)} className="flex-1 rounded-lg bg-brand-teal px-3 py-2 text-xs font-bold text-white">複製連結</button>
            <button onClick={() => shareToLine(generated.url, generated.coachName)} className="flex-1 rounded-lg bg-brand-green px-3 py-2 text-xs font-bold text-white">LINE 分享</button>
          </div>
        </div>
      )}

      <h3 className="mb-2 text-sm font-bold text-brand-primary">選擇要推薦的教練</h3>
      <div className="mb-5 space-y-2">
        {coaches.map((c) => (
          <div key={c.id} className="flex items-center justify-between rounded-xl border border-gray-200 bg-white p-3">
            <div>
              <div className="text-sm font-bold text-gray-800">{c.name}{c.is_senior && <span className="ml-1 rounded-md bg-brand-gold px-1.5 py-0.5 text-[10px] text-white">資深</span>}</div>
              <div className="text-[11px] text-gray-500">倍率 {Number(c.pricing_multiplier || 1).toFixed(2)}x</div>
            </div>
            <button onClick={() => handleCreate(c)} disabled={busy === c.id}
              className="rounded-lg bg-brand-primary px-3 py-2 text-xs font-bold text-white disabled:opacity-50">
              {busy === c.id ? '產生中…' : '產生連結'}
            </button>
          </div>
        ))}
        {coaches.length === 0 && <div className="text-xs text-gray-500">目前場館沒有可推薦的教練。</div>}
      </div>

      <h3 className="mb-2 text-sm font-bold text-brand-primary">我的推薦記錄</h3>
      <div className="space-y-2">
        {mine.map((r) => (
          <div key={r.id} className="rounded-xl border border-gray-200 bg-white p-3">
            <div className="flex items-center justify-between">
              <div className="text-sm font-bold text-gray-800">{r.coach.name}</div>
              <span className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${r.status === 'reward_issued' ? 'bg-brand-green/15 text-brand-green' : 'bg-gray-100 text-gray-600'}`}>
                {STATUS_LABEL[r.status] || r.status}
              </span>
            </div>
            <div className="mt-1 break-all font-mono text-[11px] text-gray-500">{r.url}</div>
            <div className="mt-2 flex gap-2">
              <button onClick={() => handleCopy(r.url)} className="flex-1 rounded-md bg-gray-100 px-2 py-1.5 text-[11px] text-gray-700">複製</button>
              <button onClick={() => shareToLine(r.url, r.coach.name)} className="flex-1 rounded-md bg-brand-green/10 px-2 py-1.5 text-[11px] text-brand-green">LINE 分享</button>
            </div>
          </div>
        ))}
        {mine.length === 0 && <div className="text-xs text-gray-500">尚未產生過推薦連結。</div>}
      </div>

      <button onClick={() => navigate('/')} className="mt-6 w-full rounded-lg border border-gray-300 py-2 text-sm text-gray-600">回首頁</button>
    </div>
  );
}
