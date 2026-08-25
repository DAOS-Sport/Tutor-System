import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 分批載入清單（往下捲才載下一批）。
 *
 * ── 為什麼要有這個 ──
 * 後台好幾張表已經破千（Z03 學員 2,261、簽到 1,499、報名 1,133、上課紀錄 913…）。
 * 一次全撈的代價不只是慢：回應大到一定程度就會撞到逾時或被中途截斷，
 * 而截斷最糟的地方在於「畫面看起來是好的，只是少了幾筆」——沒有任何錯誤訊息。
 * 分批之後每次請求都很小，失敗也只影響那一批，可以重試。
 *
 * ── 怎麼判斷「到底了」──
 * 用「這一批回傳的筆數 < 要求的筆數」來判斷，不需要後端回總數。
 * 好處是後端的回傳形狀完全不用改（照舊回陣列），既有呼叫端一個都不會壞。
 * 代價是剛好整除時會多打一次空的請求 —— 一次很便宜的請求，換不改動介面。
 *
 * ── 換篩選條件時 ──
 * deps 一變就整個重來（清空、offset 歸零）。同時用遞增的 requestId 作廢舊請求：
 * 慢的舊查詢回來時如果直接 append，畫面上會混進上一組篩選的資料，
 * 而且看起來完全像是「篩選壞了」。
 *
 * @param fetchPage  ({ limit, offset }) => Promise<Array>
 * @param deps       篩選條件；變動即重載
 */
export default function useInfiniteList(fetchPage, deps = [], { pageSize = 50 } = {}) {
  const [items, setItems] = useState(null);   // null＝第一批還沒回來
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  const offsetRef = useRef(0);
  const reqIdRef = useRef(0);
  const loadingRef = useRef(false);   // state 有一個 render 的延遲，攔不住連續觸發
  const doneRef = useRef(false);
  const fetchRef = useRef(fetchPage);
  fetchRef.current = fetchPage;

  const loadMore = useCallback(async () => {
    if (loadingRef.current || doneRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError('');
    const myReq = reqIdRef.current;
    const myOffset = offsetRef.current;
    try {
      const batch = await fetchRef.current({ limit: pageSize, offset: myOffset });
      if (myReq !== reqIdRef.current) return;   // 篩選已經換過，這批作廢
      const rows = Array.isArray(batch) ? batch : [];
      offsetRef.current = myOffset + rows.length;
      if (rows.length < pageSize) { doneRef.current = true; setDone(true); }
      setItems((cur) => (cur === null ? rows : [...cur, ...rows]));
    } catch (e) {
      if (myReq !== reqIdRef.current) return;
      setError(e?.response?.data?.error || e?.message || '載入失敗');
      // 不設 done：讓使用者可以重試這一批，而不是整頁卡死。
      setItems((cur) => (cur === null ? [] : cur));
    } finally {
      if (myReq === reqIdRef.current) { loadingRef.current = false; setLoading(false); }
    }
  }, [pageSize]);

  // 篩選變動 → 全部重來
  useEffect(() => {
    reqIdRef.current += 1;
    offsetRef.current = 0;
    doneRef.current = false;
    loadingRef.current = false;
    setItems(null);
    setDone(false);
    setError('');
    setLoading(false);
    loadMore();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  /**
   * 掛在清單底部的哨兵元素。捲到它就載下一批。
   * rootMargin 提前 300px 觸發，讓使用者通常不會真的看到轉圈。
   */
  const sentinelRef = useCallback((node) => {
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMore();
    }, { rootMargin: '300px' });
    io.observe(node);
  }, [loadMore]);

  return { items, loading, done, error, loadMore, sentinelRef, count: items ? items.length : 0 };
}
