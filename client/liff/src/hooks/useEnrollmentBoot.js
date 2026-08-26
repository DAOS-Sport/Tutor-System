import { useEffect, useState } from 'react';
import { coachesApi } from '../api/coaches';
import { coursesApi } from '../api/courses';
import { venuesApi } from '../api/venues';

export default function useEnrollmentBoot({ coachId, venueId, courseType, onError }) {
  const [bootData, setBootData] = useState(null);
  const [bootError, setBootError] = useState(null);

  useEffect(() => {
    let alive = true;
    setBootError(null);
    // 缺 coach / venue（多半是直接深連結進 /enroll，未經選場館/教練）→ 早返不打 /coaches/null、/venues/null
    if (!coachId || !venueId) {
      setBootError('請從首頁重新選擇場館與教練');
      return () => { alive = false; };
    }
    Promise.all([
      coachesApi.detail(coachId),
      venuesApi.detail(venueId),
      // venue 一定要傳：base-price 分區之後會用場館決定價格，少帶就直接 400
      // VENUE_REQUIRED，整個報名頁變成「資料載入失敗」。上面早就驗過 venueId
      // 不為空，卻沒有往下傳 —— 這一行漏掉的代價是所有家長都無法報名。
      coursesApi.basePrice(courseType, venueId),
    ])
      .then(([coach, venue, bp]) => {
        if (!alive) return;
        setBootData({
          coach,
          venue,
          basePrice: bp.original_price,
          tierPrices: bp.tier_prices || null,
          trialEnabled: bp.trial_enabled === true,
          trialPrice: bp.trial_price,
          sessionsPerPeriod: bp.sessions_per_period,
        });
      })
      .catch((err) => {
        if (!alive) return;
        // 三個請求併發，任何一個失敗都會走到這裡。原本一律顯示「資料載入失敗」，
        // 於是畫面上看不出是教練、場館還是價格出問題 —— 這次的 VENUE_REQUIRED
        // 就是因此花了不少時間才定位。伺服器有給訊息就照實顯示。
        const msg = err?.response?.data?.error || '資料載入失敗';
        setBootError(msg);
        onError?.(msg);
      });
    return () => {
      alive = false;
    };
  }, [coachId, venueId, courseType, onError]);

  return { bootData, bootError };
}
