import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { coachesApi } from '../api/coaches';
import { coursesApi } from '../api/courses';
import { venuesApi } from '../api/venues';
import CoachCard from '../components/CoachCard';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToast } from '../context/ToastContext';
import { courseTypeLabel } from '../utils/format';

export default function CoachListPage() {
  const [params] = useSearchParams();
  const venueId = params.get('venue');
  const courseType = Number(params.get('courseType') || 1);
  const navigate = useNavigate();
  const toast = useToast();

  const [coaches, setCoaches] = useState(null);
  const [venue, setVenue] = useState(null);
  const [basePrice, setBasePrice] = useState(0);
  const [loadError, setLoadError] = useState(null);
  const [levelFilter, setLevelFilter] = useState('all'); // 'all' | 'senior' | 'regular'

  useEffect(() => {
    if (!venueId) {
      setLoadError('未指定場館，請從首頁重新選擇');
      return;
    }
    let alive = true;
    setLoadError(null);
    Promise.all([
      coachesApi.list({ venueId }),
      venuesApi.detail(venueId),
      coursesApi.basePrice(courseType),
    ])
      .then(([cs, v, bp]) => {
        if (!alive) return;
        if (!v) {
          setLoadError('找不到此場館');
          return;
        }
        setCoaches(cs || []);
        setVenue(v);
        setBasePrice(bp.original_price);
      })
      .catch(() => {
        if (!alive) return;
        setLoadError('教練清單載入失敗');
        toast.error('教練清單載入失敗');
      });
    return () => {
      alive = false;
    };
  }, [venueId, courseType, toast]);

  if (loadError) {
    return (
      <div className="px-4 py-8 text-center">
        <div className="mb-3 text-sm text-brand-error">{loadError}</div>
        <button
          type="button"
          onClick={() => navigate('/', { replace: true })}
          className="rounded-lg bg-brand-primary px-4 py-2 text-sm font-bold text-white"
        >
          回首頁
        </button>
      </div>
    );
  }
  if (!coaches || !venue) return <LoadingSpinner fullPage label="載入教練中…" />;

  const filteredCoaches = (coaches || []).filter((c) => {
    if (levelFilter === 'senior') return !!c.is_senior;
    if (levelFilter === 'regular') return !c.is_senior;
    return true;
  });

  return (
    <div className="px-4 py-4">
      <div className="mb-4 rounded-lg bg-brand-primary/5 px-3 py-2 text-xs text-brand-primary">
        <span className="font-bold">{venue.name}</span>
        <span className="mx-1.5 text-gray-300">·</span>
        <span>{courseTypeLabel(courseType)}</span>
      </div>

      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-xs text-gray-500">
          {coaches.length > 0
            ? `共 ${filteredCoaches.length} 位教練，金色徽章為「資深教練」（含學習歷程服務）`
            : '此場館暫無可預約教練'}
        </p>
        {coaches.length > 0 && (
          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value)}
            className="shrink-0 rounded-lg border border-gray-300 px-2 py-1.5 text-xs font-medium text-gray-700 focus:border-brand-teal focus:outline-none"
          >
            <option value="all">全部</option>
            <option value="senior">資深</option>
            <option value="regular">一般</option>
          </select>
        )}
      </div>

      <div className="space-y-3">
        {filteredCoaches.map((c) => (
          <CoachCard
            key={c.id}
            coach={c}
            basePrice={basePrice}
            onSelect={() =>
              navigate(`/enroll?venue=${venueId}&courseType=${courseType}&coach=${c.id}`)
            }
          />
        ))}
      </div>
    </div>
  );
}
