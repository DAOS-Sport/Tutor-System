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
      coursesApi.basePrice(courseType),
    ])
      .then(([coach, venue, bp]) => {
        if (!alive) return;
        setBootData({
          coach,
          venue,
          basePrice: bp.original_price,
          trialPrice: bp.trial_price,
          sessionsPerPeriod: bp.sessions_per_period,
        });
      })
      .catch(() => {
        if (!alive) return;
        setBootError('資料載入失敗');
        onError?.('資料載入失敗');
      });
    return () => {
      alive = false;
    };
  }, [coachId, venueId, courseType, onError]);

  return { bootData, bootError };
}
