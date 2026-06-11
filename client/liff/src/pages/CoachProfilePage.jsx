import React, { useEffect, useState } from 'react';
import { coachesApi } from '../api/coaches';
import { venuesApi } from '../api/venues';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import LoadingSpinner from '../components/LoadingSpinner';

export default function CoachProfilePage() {
  const { coach } = useAuth();
  const toast = useToast();
  const [bio, setBio] = useState('');
  const [savingBio, setSavingBio] = useState(false);
  const [media, setMedia] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [venueMap, setVenueMap] = useState({}); // venue id → 名稱
  const [freshVenueIds, setFreshVenueIds] = useState(null); // 掛載時重抓，避免 localStorage 舊快取把多場館收斂成單一值

  useEffect(() => {
    if (!coach?.id) return;
    setBio(coach.bio_rich_text || coach.bio || '');
    let alive = true;
    coachesApi.listMedia(coach.id)
      .then((d) => alive && setMedia(d || []))
      .catch(() => alive && setMedia([]));
    // 重新抓取教練完整 profile（含最新 venue_ids），不只信 AuthContext 的 localStorage 快取
    coachesApi.detail(coach.id)
      .then((c) => { if (alive && c && Array.isArray(c.venue_ids)) setFreshVenueIds(c.venue_ids); })
      .catch(() => { /* 失敗則退回快取的 coach.venue_ids */ });
    // 載入場館 id→名稱對照，讓「可教場館」顯示名稱而非代碼（B → 新北高中）
    venuesApi.list()
      .then((vs) => { if (alive && Array.isArray(vs)) setVenueMap(Object.fromEntries(vs.map((v) => [v.id, v.name]))); })
      .catch(() => { /* 失敗則退回顯示代碼 */ });
    return () => { alive = false; };
  }, [coach?.id]);

  // [可教場館診斷] 對照快取 vs 重抓的 venue_ids（與 server log 對照，定位陣列在哪層被收斂成單一值）
  console.log('[CoachProfile] venue_ids cached =', coach?.venue_ids, ' fresh =', freshVenueIds);
  // 優先用重抓到的最新陣列；失敗才退回快取，避免舊登入快取顯示不全。
  const venueIds = freshVenueIds || coach?.venue_ids || [];
  const venueNames = venueIds.map((id) => venueMap[id] || id);

  async function handleSaveBio() {
    if (savingBio) return;
    setSavingBio(true);
    try {
      await coachesApi.updateBio(coach.id, bio);
      toast.success('個人介紹已送出（待主管審核）');
    } catch (err) {
      toast.error(err?.response?.data?.error || '儲存失敗');
    } finally { setSavingBio(false); }
  }

  async function handleAddMedia(payload) {
    try {
      const created = await coachesApi.addMedia(coach.id, payload);
      setMedia((prev) => [...(prev || []), created]);
      toast.success('已新增圖片');
      setShowAdd(false);
    } catch (err) {
      toast.error(err?.response?.data?.error || '新增失敗');
    }
  }

  async function handleMove(idx, dir) {
    const list = [...(media || [])];
    const target = idx + dir;
    if (target < 0 || target >= list.length) return;
    [list[idx], list[target]] = [list[target], list[idx]];
    setMedia(list);
    try {
      await coachesApi.reorderMedia(coach.id, list.map((m) => m.id));
    } catch { toast.error('排序失敗'); }
  }

  async function handleDelete(id) {
    if (!confirm('確認刪除此圖片？')) return;
    try {
      await coachesApi.deleteMedia(coach.id, id);
      setMedia((prev) => (prev || []).filter((m) => m.id !== id));
      toast.success('已刪除');
    } catch (err) { toast.error(err?.response?.data?.error || '刪除失敗'); }
  }

  if (!coach) return null;

  return (
    <div className="px-4 py-4">
      <div className="relative mb-4 w-full select-none overflow-hidden rounded-[2.5rem] bg-[#165B7C] p-6 text-white shadow-xl">
        {/* 液態玻璃高光：左上柔光 + 整面斜向漸層，讓單色卡片更有層次 */}
        <div className="pointer-events-none absolute -left-10 -top-12 h-44 w-44 rounded-full bg-white/10 blur-2xl" />
        <div className="pointer-events-none absolute inset-0 rounded-[2.5rem] bg-gradient-to-br from-white/10 via-transparent to-black/15" />

        <div className="relative">
          <div className="mb-6 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="truncate py-1 text-3xl font-bold tracking-wide">{coach.name}</h2>
              {coach.phone && <p className="mt-0.5 text-xs tracking-wider text-white/60">{coach.phone}</p>}
            </div>
            <div className="flex shrink-0 items-center rounded-xl border border-[#0d435c] bg-[#165B7C] px-3 py-1.5 shadow-inner">
              {coach.is_senior && <span className="mr-1 text-lg">🏅</span>}
              <span className="text-sm font-medium tracking-wider">
                {coach.is_senior ? '資深' : '一般'} ×{coach.pricing_multiplier || coach.multiplier || 1}
              </span>
            </div>
          </div>

          <div className="rounded-xl border border-[#0d435c] bg-[#145371] p-4">
            <p className="mb-2 text-xs tracking-wider text-gray-300">授權場館</p>
            {venueNames.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {venueNames.map((name, i) => (
                  <span
                    key={`${name}-${i}`}
                    className="break-all rounded-xl border border-white/15 bg-white/10 px-3 py-1.5 text-base font-semibold tracking-wide shadow-inner"
                  >
                    {name}
                  </span>
                ))}
              </div>
            ) : (
              <div className="text-lg text-gray-300">—</div>
            )}
          </div>

          {coach.intro_review_status && (
            <p className="mt-3 text-[11px] tracking-wider text-white/70">
              介紹狀態：{
                { draft: '草稿', pending_review: '審核中', published: '已發布', rejected: '未通過' }[coach.intro_review_status]
                || coach.intro_review_status
              }
            </p>
          )}
        </div>
      </div>

      <Section title="個人介紹（家長端可看）">
        <textarea
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          rows={5}
          maxLength={500}
          placeholder="撰寫教學經歷、專長、教學風格…"
          className="w-full rounded-lg border border-gray-300 p-2 text-sm focus:border-brand-teal focus:outline-none focus:ring-2 focus:ring-brand-teal/30"
        />
        <div className="mt-1 flex items-center justify-between">
          <span className="text-[11px] text-gray-400">{bio.length} / 500</span>
          <button onClick={handleSaveBio} disabled={savingBio}
            className="rounded-lg bg-brand-primary px-4 py-1.5 text-sm font-bold text-white active:bg-brand-teal disabled:opacity-50">
            {savingBio ? '送出中…' : '送出（待審核）'}
          </button>
        </div>
      </Section>

      <Section title={`介紹圖片（${media?.length ?? '…'}）`}>
        {media === null && <LoadingSpinner label="載入中…" />}
        {media && media.length === 0 && (
          <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-4 text-center text-xs text-gray-500">
            尚未上傳圖片
          </div>
        )}
        {media && media.map((m, i) => (
          <div key={m.id} className="mb-2 flex items-center gap-2 rounded-lg border border-gray-200 p-2">
            <img src={m.storage_url} alt={m.alt_text || ''} className="h-14 w-14 flex-shrink-0 rounded-md object-cover" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-xs font-medium text-gray-800">{m.alt_text || '（無說明）'}</div>
              <div className="truncate text-[10px] text-gray-400">{m.storage_url}</div>
            </div>
            <div className="flex flex-col gap-0.5">
              <button onClick={() => handleMove(i, -1)} disabled={i === 0}
                className="rounded px-1.5 text-xs text-gray-500 disabled:opacity-30">↑</button>
              <button onClick={() => handleMove(i, 1)} disabled={i === media.length - 1}
                className="rounded px-1.5 text-xs text-gray-500 disabled:opacity-30">↓</button>
            </div>
            <button onClick={() => handleDelete(m.id)}
              className="rounded px-1.5 text-xs text-brand-error">刪</button>
          </div>
        ))}
        <button onClick={() => setShowAdd(true)}
          className="mt-2 w-full rounded-lg border border-dashed border-brand-primary/40 py-2 text-sm font-medium text-brand-primary">
          ＋ 新增圖片
        </button>
      </Section>

      {showAdd && <AddMediaModal onClose={() => setShowAdd(false)} onSubmit={handleAddMedia} />}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div className="mb-4 rounded-xl border border-gray-200 bg-white p-3">
      <h3 className="mb-2 text-xs font-bold text-brand-primary">{title}</h3>
      {children}
    </div>
  );
}

function AddMediaModal({ onClose, onSubmit }) {
  const [url, setUrl] = useState('');
  const [alt, setAlt] = useState('');
  return (
    <div className="fixed inset-0 z-40 flex items-end bg-black/40" onClick={onClose}>
      <div className="w-full max-w-[390px] mx-auto rounded-t-2xl bg-white p-4" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-bold text-brand-primary">新增介紹圖片</h3>
          <button onClick={onClose} className="text-sm text-gray-500">關閉</button>
        </div>
        <div className="space-y-3 text-sm">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-700">圖片網址</span>
            <input type="url" value={url} onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…" className="w-full rounded-lg border border-gray-300 px-3 py-2" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-700">圖片說明（選填）</span>
            <input type="text" value={alt} onChange={(e) => setAlt(e.target.value)} maxLength={50}
              className="w-full rounded-lg border border-gray-300 px-3 py-2" />
          </label>
          <p className="text-[11px] text-gray-400">
            正式版將支援直接上傳到 LINE storage / 雲端，目前以 URL 引用為主。
          </p>
          <button type="button" disabled={!url}
            onClick={() => onSubmit({ storage_url: url, alt_text: alt })}
            className="w-full rounded-lg bg-brand-primary py-3 font-bold text-white active:bg-brand-teal disabled:opacity-50">
            送出
          </button>
        </div>
      </div>
    </div>
  );
}
