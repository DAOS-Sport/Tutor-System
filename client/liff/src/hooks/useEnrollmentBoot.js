import { useEffect, useState } from 'react';
import { coachesApi } from '../api/coaches';
import { coursesApi } from '../api/courses';
import { venuesApi } from '../api/venues';
import { promotionsApi } from '../api/promotions';

export default function useEnrollmentBoot({ coachId, venueId, courseType, onError }) {
  const [bootData, setBootData] = useState(null);
  const [bootError, setBootError] = useState(null);

  useEffect(() => {
    let alive = true;
    setBootError(null);
    Promise.all([
      coachesApi.detail(coachId),
      venuesApi.detail(venueId),
      coursesApi.basePrice(courseType),
      promotionsApi.list(),
    ])
      .then(([coach, venue, bp, promos]) => {
        if (!alive) return;
        setBootData({ coach, venue, basePrice: bp.original_price, promos });
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
