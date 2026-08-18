import React, { useEffect, useRef, useState } from "react";
import AvatarCropper from '../components/coach/AvatarCropper';
import CoachDetailModal from '../components/CoachDetailModal';
import { coachesApi } from "../api/coaches";
import { venuesApi } from "../api/venues";
import { useAuth } from "../context/AuthContext";
import { useToast } from "../context/ToastContext";
import LoadingSpinner from "../components/LoadingSpinner";
import Collapsible from "../components/Collapsible";
import { cleanVenueList } from "../utils/venues";

/**
 * 版面調整重點（邏輯零變動）：
 * 1. 外層 max-w-md + pb-6：桌機開也不會攤平（底部導覽已改 in-flow，內容不再被覆蓋，免大留白）
 * 2. Section 標題移出卡片：消掉箱中箱，整頁變輕；區塊間距統一 mb-5
 * 3. 所有輸入（textarea / modal input）改 16px：iOS 聚焦不再自動縮放跳動
 * 4. 觸控目標：送出鈕、↑↓刪、新增圖片全部 ≥40px 高
 * 5. Modal 底部加 env(safe-area-inset-bottom)
 * 6. 診斷 console.log 改成只在 DEV 跑（原本每次 render 都印）
 */

// 家長端小卡的自介只有 line-clamp-2（見 components/CoachCard.jsx），約兩行。
// 正式庫實測：212 位教練只有 8 位寫了自介，其中 3 位寫了 201～268 字 ——
// 家長看得到的永遠只有前兩行，後面全被吃掉。上限訂在 40 字，並讓教練當場看到
// 家長實際會看到的樣子，比寫一行「請簡短」有用。
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;

// 40 是「軟」上限：超過只警告，不擋儲存（owner 2026-08-17）。
// 家長端小卡是 line-clamp-2，超過的部分家長看不到 —— 但那是他自己的取捨，
// 系統的責任是講清楚，不是替他決定。
// BIO_HARD_MAX 才是真正擋下來的界線，那是防呆不是政策：正式庫最長 268 字，
// 訂 500 讓既有資料都還能重新儲存。
const BIO_MAX = 40;
const BIO_HARD_MAX = 500;
// 詳細介紹本來就要寫長的；這個上限只是擋整篇文章貼進來。
const BIO_DETAIL_MAX = 2000;
const BIO_SWEET_MIN = 20;

function bioState(len) {
  if (len > BIO_MAX) {
    return {
      tone: 'text-brand-amber font-bold',
      label: `${len} / ${BIO_MAX}`,
      warn: `超過 ${BIO_MAX} 字，家長端小卡只顯示兩行，多出來的會被截斷`,
    };
  }
  if (len >= BIO_SWEET_MIN) {
    return { tone: 'text-brand-green font-bold', label: `● 長度剛好 ${len} / ${BIO_MAX}`, warn: null };
  }
  return { tone: 'text-gray-400', label: `${len} / ${BIO_MAX}`, warn: null };
}

export default function CoachProfilePage() {
  const { coach } = useAuth();
  const toast = useToast();
  const [bio, setBio] = useState("");
  const [savingBio, setSavingBio] = useState(false);
  const [media, setMedia] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [venueMap, setVenueMap] = useState({}); // venue id → 名稱
  const [freshVenueIds, setFreshVenueIds] = useState(null); // 掛載時重抓，避免 localStorage 舊快取把多場館收斂成單一值
  // 審核狀態與退回原因都以「伺服器最新值」為準，不是登入當下的快取。
  // AuthContext 的自動 refresh 只跑家長端，教練這邊送出後橫幅永遠停在舊狀態。
  const [reviewStatus, setReviewStatus] = useState(coach?.intro_review_status || "");
  const [reviewNote, setReviewNote] = useState(coach?.intro_review_note || "");
  const [bioOpen, setBioOpen] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState("");
  const [cropFile, setCropFile] = useState(null);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [detail, setDetail] = useState("");
  const [detailOpen, setDetailOpen] = useState(false);
  const [savingDetail, setSavingDetail] = useState(false);

  useEffect(() => {
    if (!coach?.id) return;
    setBio(coach.bio_rich_text || coach.bio || "");
    setAvatarUrl(coach.avatar_url || "");
    setDetail(coach.bio_detail || "");
    let alive = true;
    coachesApi
      .listMedia(coach.id)
      .then((d) => alive && setMedia(d || []))
      .catch(() => alive && setMedia([]));
    // 重新抓取教練完整 profile。這支回傳的不只 venue_ids —— bio 與審核狀態同樣
    // 是快取值，之前只取了場館，導致教練在別的裝置改過介紹後這裡還顯示舊文字。
    coachesApi
      .detail(coach.id)
      .then((c) => {
        if (!alive || !c) return;
        setFreshVenueIds(cleanVenueList(c.venue_ids || c.venues || []));
        if (c.bio_rich_text != null) setBio(c.bio_rich_text);
        if (c.avatar_url !== undefined) setAvatarUrl(c.avatar_url || "");
        if (c.bio_detail !== undefined) setDetail(c.bio_detail || "");
      })
      .catch(() => {
        /* 失敗則退回快取的 coach.venue_ids */
      });
    // 審核狀態與主管退回原因走「需要登入且只能看自己」的端點。
    // 這幾個欄位不能放在公開的 /coaches/:id —— 那等於誰都讀得到主管的內部評語。
    coachesApi
      .privateProfile(coach.id)
      .then((p) => {
        if (!alive || !p) return;
        if (p.intro_review_status) setReviewStatus(p.intro_review_status);
        setReviewNote(p.intro_review_note || "");
      })
      .catch(() => {
        /* 失敗則沿用登入時的快取狀態，不擋畫面 */
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
  const venueIds = cleanVenueList(freshVenueIds || coach?.venue_ids || coach?.venues || []);
  const venueNames = venueIds.map((id) => venueMap[id] || id);
  const introReviewStatusText = reviewStatus
    ? {
        draft: "草稿",
        pending_review: "審核中",
        published: "已發布",
        rejected: "未通過",
      }[reviewStatus] || reviewStatus
    : "";
  const coachInitial = (coach?.name || "教").trim().slice(0, 1) || "教";

  const bioStatus = bioState(bio.length);

  // 展開時若還沒寫過詳細介紹，就把個人介紹的文字帶進來當起點 ——
  // 教練不必從空白開始，也看得出兩者的關係。這只是畫面上的預設值，
  // 沒按儲存就不會寫進 DB（DB 為空代表「他還沒補充」，那個事實要留著）。
  function openDetail() {
    if (!detail.trim() && bio.trim()) setDetail(bio);
    setDetailOpen(true);
  }

  async function handleSaveDetail() {
    if (savingDetail) return;
    if (detail.length > BIO_DETAIL_MAX) {
      toast.error(`詳細介紹最多 ${BIO_DETAIL_MAX} 字，目前 ${detail.length} 字`);
      return;
    }
    setSavingDetail(true);
    try {
      const updated = await coachesApi.updateBio(coach.id, bio, detail);
      setReviewStatus(updated?.intro_review_status || "pending_review");
      setReviewNote("");
      setDetailOpen(false);
      toast.success("詳細介紹已送出（待主管審核）");
    } catch (err) {
      toast.error(err?.response?.data?.error || "儲存失敗");
    } finally {
      setSavingDetail(false);
    }
  }

  function pickAvatar(e) {
    const f = e.target.files?.[0];
    e.target.value = '';        // 同一個檔案再選一次也要能觸發 change
    if (!f) return;
    if (!['image/jpeg', 'image/png'].includes(f.type)) {
      toast.error('只接受 JPG / PNG 圖片');
      return;
    }
    // 這裡擋的是「原檔」大小。裁切後輸出固定 512×512 JPEG，一定遠小於上限，
    // 但先擋住可以省掉把 20MB 讀進記憶體再裁的那段。
    if (f.size > AVATAR_MAX_BYTES) {
      toast.error('圖片請小於 5MB');
      return;
    }
    setCropFile(f);
  }

  async function handleCropped(file) {
    setCropFile(null);
    setAvatarBusy(true);
    try {
      const r = await coachesApi.uploadAvatar(coach.id, file);
      setAvatarUrl(r?.avatar_url || '');
      toast.success('大頭照已更新');
    } catch (err) {
      toast.error(err?.response?.data?.error || '上傳失敗');
    } finally {
      setAvatarBusy(false);
    }
  }

  async function handleRemoveAvatar() {
    if (avatarBusy) return;
    setAvatarBusy(true);
    try {
      await coachesApi.removeAvatar(coach.id);
      setAvatarUrl('');
      toast.success('已移除大頭照');
    } catch (err) {
      toast.error(err?.response?.data?.error || '移除失敗');
    } finally {
      setAvatarBusy(false);
    }
  }

  async function handleSaveBio() {
    if (savingBio) return;
    // 超過 40 只是警告，照樣存得進去。這裡擋的是防呆上限。
    if (bio.length > BIO_HARD_MAX) {
      toast.error(`個人介紹最多 ${BIO_HARD_MAX} 字，目前 ${bio.length} 字`);
      return;
    }
    setSavingBio(true);
    try {
      // 回傳值含更新後的 intro_review_status（後端會寫成 pending_review）。
      // 原本這裡把它丟掉，橫幅就停在登入時的舊狀態 —— 教練送出後看到「未通過」
      // 還掛在那，會以為沒送成功而重複送。
      const updated = await coachesApi.updateBio(coach.id, bio);
      setReviewStatus(updated?.intro_review_status || "pending_review");
      setReviewNote("");   // 重新送審後，上一輪的退回原因就不再適用
      setBioOpen(false);
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
    <div className="mx-auto w-full max-w-md px-4 pt-4 pb-6">
      <CoachBanner
        coach={coach}
        coachInitial={coachInitial}
        venueNames={venueNames}
        introReviewStatusText={introReviewStatusText}
        avatarUrl={avatarUrl}
      />

      {/* 兩塊預設收合。標題列右上角是「編輯 ✏」，展開後同一個位置變成「儲存」——
          動作永遠在同一個地方，教練不用找。 */}
      <div className="mb-3">
        <Collapsible
          title="個人介紹"
          subtitle="家長端可看"
          open={bioOpen}
          onToggle={() => setBioOpen((o) => !o)}
          accent
          action={
            <HeaderAction
              open={bioOpen}
              busy={savingBio}
              onEdit={() => setBioOpen(true)}
              onSave={handleSaveBio}
              busyLabel="送出中…"
            />
          }
        >
          {/* 大頭照與自介同屬「家長會看到什麼」，放在一起編輯才不用兩處來回切。
              這裡不再套自己的外框 —— 外層 Collapsible 已經有框了。 */}
          <div className="mb-3 flex items-center gap-3 border-b border-gray-100 pb-3">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-primary text-2xl font-bold text-white">
          {avatarUrl
            ? <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
            : coachInitial}
            </div>
            <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-gray-800">大頭照</div>
          <p className="mt-0.5 text-[11px] leading-4 text-gray-500">家長看到的圓形頭像，建議清晰的半身照</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <label className={`cursor-pointer rounded-lg border border-brand-teal px-3 py-1.5 text-xs font-bold text-brand-teal ${avatarBusy ? 'pointer-events-none opacity-50' : 'active:bg-brand-teal/10'}`}>
              {avatarBusy ? '處理中…' : (avatarUrl ? '更換照片' : '上傳照片')}
              <input type="file" accept="image/jpeg,image/png" className="hidden" onChange={pickAvatar} disabled={avatarBusy} />
            </label>
            {avatarUrl && (
              <button type="button" onClick={handleRemoveAvatar} disabled={avatarBusy}
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-500 disabled:opacity-50">
                移除
              </button>
            )}
          </div>
            </div>
          </div>
          {/* 2026-08-17 owner 指示移除區塊內的「主管退回原因」。
              代價要記著：教練現在只會從橫幅看到「介紹狀態：未通過」，看不到主管
              寫了什麼要他改。資料仍在 detail() 的回傳裡（reviewNote），admin 端
              也還看得到 —— 要放回來只是把這段補回去。 */}
          <textarea
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            rows={3}
            maxLength={BIO_HARD_MAX}
            placeholder="例：教學十年，專長自由式與蛙式，擅長帶零基礎與怕水的孩子。"
            className={`w-full rounded-lg border p-3 text-base leading-relaxed focus:outline-none focus:ring-2 ${
              bio.length > BIO_MAX
                ? 'border-brand-amber focus:border-brand-amber focus:ring-brand-amber/30'
                : 'border-gray-300 focus:border-brand-teal focus:ring-brand-teal/30'
            }`}
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className={`text-[11px] ${bioStatus.tone}`}>{bioStatus.label}</span>
            <span className="text-[11px] text-gray-400">儲存後送審</span>
          </div>
          {bioStatus.warn && (
            <p className="mt-1 flex items-start gap-1 text-[11px] font-bold leading-4 text-brand-amber">
              <span aria-hidden="true">⚠</span>{bioStatus.warn}
            </p>
          )}

        </Collapsible>
      </div>

      {cropFile && (
        <AvatarCropper
          file={cropFile}
          onCancel={() => setCropFile(null)}
          onConfirm={handleCropped}
        />
      )}

      {/* 詳細介紹：家長點小卡的「看詳細介紹」才會看到的長版說明。
          與上面的個人介紹是兩個欄位 —— 那個只有 40 字、家長在小卡上只看得到兩行；
          這個可以慢慢寫，讓家長好好端詳。 */}
      <div className="mb-3">
        <Collapsible
          title="詳細介紹"
          subtitle={[detail.trim() ? `${detail.length} 字` : "尚未補充",
            media?.length ? `${media.length} 張` : null].filter(Boolean).join(" · ")}
          open={detailOpen}
          onToggle={() => (detailOpen ? setDetailOpen(false) : openDetail())}
          accent
          action={
            <HeaderAction
              open={detailOpen}
              onEdit={openDetail}
              onSave={handleSaveDetail}
              busy={savingDetail}
              busyLabel="送出中…"
            />
          }
        >
          <p className="mb-2 text-[11px] leading-5 text-gray-500">
            家長點「看詳細介紹」才會看到這一段。第一次展開會先帶入上面的個人介紹，
            你可以接著往下補充教學方式、適合的孩子、上課節奏等等。
          </p>
          <textarea
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            rows={8}
            maxLength={BIO_DETAIL_MAX}
            placeholder="例：我帶課會先讓孩子在水裡放鬆，確認願意把臉放進水裡之後才開始練換氣…"
            className="w-full rounded-lg border border-gray-300 p-3 text-base leading-relaxed focus:border-brand-teal focus:outline-none focus:ring-2 focus:ring-brand-teal/30"
          />
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[11px] text-gray-400">{detail.length} / {BIO_DETAIL_MAX}</span>
            <span className="text-[11px] text-gray-400">儲存後送審</span>
          </div>

          {/* 介紹圖片併進來（owner 2026-08-18）：這一整塊就是「家長點進去會看到什麼」，
              文字與照片本來就要一起看、一起改。拆成兩個摺疊區的話，教練改完文字
              還要再找一個區塊改照片，而預覽又只有一個。
              注意兩者的儲存時機不同：文字要按「儲存」才送審，照片是上傳／刪除／
              排序當下就即時寫進 DB（沿用原本的行為，沒有改）。 */}
          <div className="mt-4 border-t border-gray-100 pt-3">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-bold text-gray-800">介紹圖片</span>
              <span className="text-[11px] text-gray-400">
                {media === null ? "載入中…" : `${media.length} 張 · 變更即時生效`}
              </span>
            </div>
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
          </div>

          <button
            type="button"
            onClick={() => setPreviewOpen(true)}
            className="mt-3 flex w-full items-center justify-between rounded-xl border border-brand-teal/40 bg-brand-teal/5 px-4 py-2.5 text-left active:bg-brand-teal/10"
          >
            <span className="min-w-0">
              <span className="block text-sm font-bold text-brand-teal">預覽家長看到的樣子</span>
              <span className="mt-0.5 block text-[11px] leading-4 text-gray-500">
                審核通過後家長才看得到；這裡連未發布的圖也會顯示
              </span>
            </span>
            <span className="shrink-0 text-brand-teal">›</span>
          </button>
        </Collapsible>
      </div>

      {previewOpen && (
        <CoachDetailModal
          coach={{ ...coach, bio, bio_detail: detail, avatar_url: avatarUrl }}
          venueNames={venueNames}
          onClose={() => setPreviewOpen(false)}
        />
      )}


      {showAdd && (
        <AddMediaModal
          onClose={() => setShowAdd(false)}
          onSubmit={handleAddMedia}
        />
      )}
    </div>
  );
}

// 只在本檔使用（沒有其他檔案 import），不對外 export。
function CoachBanner({
  coach,
  coachInitial,
  venueNames,
  introReviewStatusText,
  avatarUrl,
}) {
  const multiplier = getMultiplier(coach);
  return (
    <div className="mb-5 w-full rounded-xl bg-gradient-to-br from-[#123e6f] via-[#0b6d82] to-[#17a085] p-4 text-white">
      <div className="flex items-center gap-3">
        <div className="relative h-10 w-10 shrink-0">
          <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full border border-white/25 bg-white/10">
            {avatarUrl
              ? <img src={avatarUrl} alt="" className="h-full w-full object-cover" />
              : <span className="text-[15px] font-bold leading-none">{coachInitial}</span>}
          </div>
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

/**
 * 折疊區塊標題列右上角的動作鈕：收合時是「編輯 ✏」，展開時是「儲存」。
 *
 * 兩個狀態共用同一個位置是刻意的 —— 動作固定在同一處，教練不用先找按鈕在哪。
 * 這顆鈕在 Collapsible 的切換鈕「之外」（見該元件註解），所以點它不會連帶收合；
 * 收合是由 onSave 自己決定要不要做。
 */
function HeaderAction({ open, busy, onEdit, onSave, saveLabel = "儲存", busyLabel }) {
  if (!open) {
    return (
      <button
        type="button"
        onClick={onEdit}
        className="shrink-0 rounded-lg px-2 py-1.5 text-xs font-bold text-brand-primary active:bg-brand-primary/10"
      >
        編輯 ✏
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onSave}
      disabled={busy}
      className="shrink-0 rounded-lg bg-brand-primary px-3 py-1.5 text-xs font-bold leading-none text-white active:bg-brand-teal disabled:opacity-50"
    >
      {busy ? busyLabel || "處理中…" : saveLabel}
    </button>
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
