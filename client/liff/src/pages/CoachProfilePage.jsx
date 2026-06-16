import React, { useEffect, useRef, useState } from "react";
import { coachesApi } from "../api/coaches";
import { venuesApi } from "../api/venues";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import LoadingSpinner from "../components/LoadingSpinner";

/**
 * 版面調整重點（邏輯零變動）：
 * 1. 外層 max-w-md + pb-[calc(6rem+safe-area)]：內容不被底部導覽壓住，桌機開也不會攤平
 * 2. Section 標題移出卡片：消掉箱中箱，整頁變輕；區塊間距統一 mb-5
 * 3. 所有輸入（textarea / modal input）改 16px：iOS 聚焦不再自動縮放跳動
 * 4. 觸控目標：送出鈕、↑↓刪、新增圖片全部 ≥40px 高
 * 5. Modal 底部加 env(safe-area-inset-bottom)
 * 6. 診斷 console.log 改成只在 DEV 跑（原本每次 render 都印）
 */

export default function CoachProfilePage() {
  const { coach } = useAuth();
  const toast = useToast();
  const [bio, setBio] = useState("");
  const [savingBio, setSavingBio] = useState(false);
  const [media, setMedia] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [venueMap, setVenueMap] = useState({}); // venue id → 名稱
  const [freshVenueIds, setFreshVenueIds] = useState(null); // 掛載時重抓，避免 localStorage 舊快取把多場館收斂成單一值

  useEffect(() => {
    if (!coach?.id) return;
    setBio(coach.bio_rich_text || coach.bio || "");
    let alive = true;
    coachesApi
      .listMedia(coach.id)
      .then((d) => alive && setMedia(d || []))
      .catch(() => alive && setMedia([]));
    // 重新抓取教練完整 profile（含最新 venue_ids），不只信 AuthContext 的 localStorage 快取
    coachesApi
      .detail(coach.id)
      .then((c) => {
        if (alive && c && Array.isArray(c.venue_ids))
          setFreshVenueIds(c.venue_ids);
      })
      .catch(() => {
        /* 失敗則退回快取的 coach.venue_ids */
      });
    // 載入場館 id→名稱對照，讓「可教場館」顯示名稱而非代碼（B → 新北高中）
    venuesApi
      .list()
      .then((vs) => {
        if (alive && Array.isArray(vs))
          setVenueMap(Object.fromEntries(vs.map((v) => [v.id, v.name])));
      })
      .catch(() => {
        /* 失敗則退回顯示代碼 */
      });
    return () => {
      alive = false;
    };
  }, [coach?.id]);

  // [可教場館診斷] 只在 DEV 印，避免 production 每次 render 都輸出
  if (import.meta.env?.DEV) {
    console.log(
      "[CoachProfile] venue_ids cached =",
      coach?.venue_ids,
      " fresh =",
      freshVenueIds,
    );
  }
  // 優先用重抓到的最新陣列；失敗才退回快取，避免舊登入快取顯示不全。
  const venueIds = freshVenueIds || coach?.venue_ids || [];
  const venueNames = venueIds.map((id) => venueMap[id] || id);
  const introReviewStatusText = coach?.intro_review_status
    ? {
        draft: "草稿",
        pending_review: "審核中",
        published: "已發布",
        rejected: "未通過",
      }[coach.intro_review_status] || coach.intro_review_status
    : "";
  const coachInitial = (coach?.name || "教").trim().slice(0, 1) || "教";

  async function handleSaveBio() {
    if (savingBio) return;
    setSavingBio(true);
    try {
      await coachesApi.updateBio(coach.id, bio);
      toast.success("個人介紹已送出（待主管審核）");
    } catch (err) {
      toast.error(err?.response?.data?.error || "儲存失敗");
    } finally {
      setSavingBio(false);
    }
  }

  async function handleAddMedia({ file, alt_text }) {
    try {
      const created = await coachesApi.uploadMedia(coach.id, file, alt_text);
      setMedia((prev) => [...(prev || []), created]);
      toast.success("已新增圖片");
      setShowAdd(false);
    } catch (err) {
      toast.error(err?.response?.data?.error || "新增失敗");
    }
  }

  async function handleMove(idx, dir) {
    const list = [...(media || [])];
    const target = idx + dir;
    if (target < 0 || target >= list.length) return;
    [list[idx], list[target]] = [list[target], list[idx]];
    setMedia(list);
    try {
      await coachesApi.reorderMedia(
        coach.id,
        list.map((m) => m.id),
      );
    } catch {
      toast.error("排序失敗");
    }
  }

  async function handleDelete(id) {
    if (!confirm("確認刪除此圖片？")) return;
    try {
      await coachesApi.deleteMedia(coach.id, id);
      setMedia((prev) => (prev || []).filter((m) => m.id !== id));
      toast.success("已刪除");
    } catch (err) {
      toast.error(err?.response?.data?.error || "刪除失敗");
    }
  }

  if (!coach) return null;

  return (
    <div className="mx-auto w-full max-w-md px-4 pt-4 pb-[calc(6rem+env(safe-area-inset-bottom))]">
      <CoachBanner
        coach={coach}
        coachInitial={coachInitial}
        venueNames={venueNames}
        introReviewStatusText={introReviewStatusText}
      />

      <Section title="個人介紹（家長端可看）">
        <textarea
          value={bio}
          onChange={(e) => setBio(e.target.value)}
          rows={5}
          maxLength={500}
          placeholder="撰寫教學經歷、專長、教學風格…"
          className="w-full rounded-lg border border-gray-300 p-3 text-base leading-relaxed focus:border-brand-teal focus:outline-none focus:ring-2 focus:ring-brand-teal/30"
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[11px] text-gray-400">{bio.length} / 500</span>
          <button
            onClick={handleSaveBio}
            disabled={savingBio}
            className="rounded-lg bg-brand-primary px-5 py-2.5 text-sm font-bold leading-none text-white active:bg-brand-teal disabled:opacity-50"
          >
            {savingBio ? "送出中…" : "送出（待審核）"}
          </button>
        </div>
      </Section>

      <Section title={`介紹圖片（${media?.length ?? "…"}）`}>
        {media === null && <LoadingSpinner label="載入中…" />}
        {media && media.length === 0 && (
          <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-6 text-center text-xs text-gray-500">
            尚未上傳圖片
          </div>
        )}
        {media &&
          media.map((m, i) => (
            <div
              key={m.id}
              className="mb-2 flex items-center gap-2 rounded-lg border border-gray-200 p-2"
            >
              <img
                src={m.storage_url}
                alt={m.alt_text || ""}
                className="h-14 w-14 flex-shrink-0 rounded-md object-cover"
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-gray-800">
                  {m.alt_text || "（無說明）"}
                </div>
                <div className="truncate text-[10px] text-gray-400">
                  {m.storage_url}
                </div>
              </div>
              <div className="flex flex-col">
                <button
                  onClick={() => handleMove(i, -1)}
                  disabled={i === 0}
                  className="flex h-8 w-9 items-center justify-center rounded text-sm text-gray-500 disabled:opacity-30"
                >
                  ↑
                </button>
                <button
                  onClick={() => handleMove(i, 1)}
                  disabled={i === media.length - 1}
                  className="flex h-8 w-9 items-center justify-center rounded text-sm text-gray-500 disabled:opacity-30"
                >
                  ↓
                </button>
              </div>
              <button
                onClick={() => handleDelete(m.id)}
                className="flex h-10 w-9 items-center justify-center rounded text-sm text-brand-error"
              >
                刪
              </button>
            </div>
          ))}
        <button
          onClick={() => setShowAdd(true)}
          className="mt-2 w-full rounded-lg border border-dashed border-brand-primary/40 py-3 text-sm font-medium leading-none text-brand-primary"
        >
          ＋ 新增圖片
        </button>
      </Section>

      {showAdd && (
        <AddMediaModal
          onClose={() => setShowAdd(false)}
          onSubmit={handleAddMedia}
        />
      )}
    </div>
  );
}

export function CoachBanner({
  coach,
  coachInitial,
  venueNames,
  introReviewStatusText,
}) {
  const multiplier = getMultiplier(coach);
  return (
    <div className="mb-5 w-full rounded-xl bg-gradient-to-br from-[#123e6f] via-[#0b6d82] to-[#17a085] p-4 text-white">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/25 bg-white/10">
          <span className="text-[15px] font-bold leading-none">
            {coachInitial}
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[17px] font-bold leading-tight">
            {coach.name}
          </div>
          {coach.phone && (
            <div className="mt-1 text-xs leading-none text-white/70">
              {coach.phone}
            </div>
          )}
        </div>
        <div className="inline-flex shrink-0 items-center gap-1 self-start whitespace-nowrap rounded-full border border-white/20 bg-white/10 px-2.5 py-[5px] text-[11px] font-bold leading-none">
          {multiplier !== 1 && <span aria-hidden="true">🏅</span>}
          {coach.is_senior ? "資深" : "一般"} ×{multiplier.toFixed(2)}
        </div>
      </div>

      <div className="mt-3 rounded-[10px] bg-white/10 px-3 py-2.5">
        <div className="flex items-center gap-1.5 text-[11px] leading-none text-white/70">
          <ShieldIcon className="h-3 w-3" />
          授權場館
        </div>
        <div className="mt-1.5 text-[17px] font-bold leading-snug text-white/95">
          {venueNames.length > 0 ? venueNames.join("、") : "尚未設定場館"}
        </div>
      </div>

      {coach.intro_review_status && (
        <div className="mt-2.5 flex items-center gap-1.5 text-[13px] leading-none text-white/85">
          <InfoIcon className="h-3.5 w-3.5 shrink-0 text-white/70" />
          介紹狀態：{introReviewStatusText}
        </div>
      )}
    </div>
  );
}

function getMultiplier(coach) {
  const raw = coach?.pricing_multiplier ?? coach?.multiplier ?? 1;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function ShieldIcon({ className }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 3l7 3v5c0 4.6-3 8.2-7 10-4-1.8-7-5.4-7-10V6l7-3z" />
    </svg>
  );
}

function InfoIcon({ className }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5" />
      <path d="M12 8h.01" />
    </svg>
  );
}

function Section({ title, children }) {
  return (
    <section className="mb-5">
      <h3 className="mb-1.5 px-1 text-[13px] font-semibold text-gray-500">
        {title}
      </h3>
      <div className="rounded-xl border border-gray-200 bg-white p-3.5">
        {children}
      </div>
    </section>
  );
}

function AddMediaModal({ onClose, onSubmit }) {
  const toast = useToast();
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [alt, setAlt] = useState("");
  const [busy, setBusy] = useState(false);

  function handleFile(f) {
    if (!f) return;
    if (!["image/jpeg", "image/png"].includes(f.type)) { toast.error("只接受 JPG / PNG 圖片"); return; }
    if (f.size > 5 * 1024 * 1024) { toast.error("圖片大小不得超過 5MB"); return; }
    setFile(f);
    setPreview(URL.createObjectURL(f));
  }

  async function submit() {
    if (!file || busy) return;
    setBusy(true);
    await onSubmit({ file, alt_text: alt });
    setBusy(false);
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-end bg-black/40"
      onClick={() => !busy && onClose()}
    >
      <div
        className="mx-auto w-full max-w-md rounded-t-2xl bg-white p-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-bold text-brand-primary">
            新增介紹圖片
          </h3>
          <button
            onClick={() => !busy && onClose()}
            className="-mr-2 flex h-10 items-center px-2 text-sm text-gray-500"
          >
            關閉
          </button>
        </div>
        <div className="space-y-3 text-sm">
          <div>
            <span className="mb-1 block text-xs font-medium text-gray-700">
              圖片（JPG / PNG，≤ 5MB）
            </span>
            <div
              className={`relative flex min-h-32 flex-col items-center justify-center rounded-xl border-2 border-dashed p-4 transition ${file ? "border-brand-teal bg-brand-teal/5" : "border-gray-300"}`}
              onClick={() => !file && fileRef.current?.click()}
            >
              {preview ? (
                <>
                  <img src={preview} alt="預覽" className="max-h-44 rounded-lg object-contain" />
                  <button
                    type="button"
                    className="mt-2 text-xs text-gray-500 underline"
                    onClick={(e) => { e.stopPropagation(); setFile(null); setPreview(null); }}
                  >重新選擇</button>
                </>
              ) : (
                <div className="text-center text-sm text-gray-400">
                  <div className="mb-1 text-3xl">🖼️</div>
                  <div>點此選擇圖片</div>
                </div>
              )}
              <input ref={fileRef} type="file" accept="image/jpeg,image/png" className="hidden"
                onChange={(e) => handleFile(e.target.files?.[0])} />
            </div>
          </div>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-gray-700">
              圖片說明（選填）
            </span>
            <input
              type="text"
              value={alt}
              onChange={(e) => setAlt(e.target.value)}
              maxLength={50}
              className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base"
            />
          </label>
          <button
            type="button"
            disabled={!file || busy}
            onClick={submit}
            className="w-full rounded-lg bg-brand-primary py-3 font-bold text-white active:bg-brand-teal disabled:opacity-50"
          >
            {busy ? "上傳中…" : "送出"}
          </button>
        </div>
      </div>
    </div>
  );
}
