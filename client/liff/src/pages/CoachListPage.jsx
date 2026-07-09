import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { coachesApi } from '../api/coaches';
import { coursesApi } from '../api/courses';
import { venuesApi } from '../api/venues';
import CoachCard from '../components/CoachCard';
import LoadingSpinner from '../components/LoadingSpinner';
import PaymentDisclaimerModal from '../components/PaymentDisclaimerModal';
import { useToast } from '../context/ToastContext';
import { courseTypeLabel } from '../utils/format';
import { coachMatchesVenue } from '../utils/venues';

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
  const [nameQuery, setNameQuery] = useState('');
  const [pendingCoach, setPendingCoach] = useState(null);

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

  function handleCoachSelect(coach) {
    setPendingCoach(coach);
  }

  function handleDisclaimerAgree() {
    const c = pendingCoach;
    setPendingCoach(null);
    navigate(`/enroll?venue=${venueId}&courseType=${courseType}&coach=${c.id}`);
  }

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

  // 空白全部濾掉，避免家長誤打空格導致查無結果
  const normalizedQuery = nameQuery.replace(/\s+/g, '').toLowerCase();
  // 未輸入姓名且篩選器停在「全部」時，不列出任何教練，改顯示引導文字
  const searchActive = normalizedQuery.length > 0 || levelFilter !== 'all';

  const filteredCoaches = (coaches || []).filter((c) => {
    if (!coachMatchesVenue(c, [venueId, venue?.id, venue?.name])) return false;
    if (levelFilter === 'senior' && !c.is_senior) return false;
    if (levelFilter === 'regular' && c.is_senior) return false;
    if (normalizedQuery && !(c.name || '').replace(/\s+/g, '').toLowerCase().includes(normalizedQuery)) return false;
    return true;
  });

  return (
    <div className="px-4 py-4">
      <div className="mb-4 rounded-lg bg-brand-primary/5 px-3 py-2 text-xs text-brand-primary">
        <span className="font-bold">{venue.name}</span>
        <span className="mx-1.5 text-gray-300">·</span>
        <span>{courseTypeLabel(courseType)}</span>
      </div>

      {coaches.length > 0 && (
        <div className="mb-3 flex flex-col gap-2 sm:flex-row">
          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value)}
            className="shrink-0 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 focus:border-brand-teal focus:outline-none sm:w-32"
          >
            <option value="all">全部</option>
            <option value="senior">資深教練</option>
            <option value="regular">一般教練</option>
          </select>
          <input
            type="text"
            value={nameQuery}
            onChange={(e) => setNameQuery(e.target.value)}
            placeholder="搜尋教練姓名"
            className="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 placeholder:text-gray-400 focus:border-brand-teal focus:outline-none"
          />
        </div>
      )}

      {coaches.length === 0 && <p className="mb-3 text-xs text-gray-500">此場館暫無可預約教練</p>}
      {coaches.length > 0 && searchActive && (
        <p className="mb-3 text-xs text-gray-500">
          {`共 ${filteredCoaches.length} 位教練，金色徽章為「資深教練」（含學習歷程服務）`}
        </p>
      )}

      {coaches.length > 0 && !searchActive && (
        <div className="flex min-h-[50vh] flex-col items-center justify-center px-6 text-center">
          <div className="mb-3 text-3xl">🔍</div>
          <p className="text-sm font-medium text-gray-500">請輸入教練姓名或透過上方篩選器選擇教練</p>
          <p className="mt-2 text-xs text-gray-400">金色徽章為「資深教練」（含學習歷程服務）</p>
        </div>
      )}

      {searchActive && filteredCoaches.length === 0 && (
        <div className="rounded-lg border border-dashed border-gray-300 px-4 py-10 text-center text-sm text-gray-400">
          查無符合條件的教練，請調整篩選條件或搜尋關鍵字
        </div>
      )}

      {searchActive && filteredCoaches.length > 0 && (
        <div className="space-y-3">
          {filteredCoaches.map((c) => (
            <CoachCard
              key={c.id}
              coach={c}
              basePrice={basePrice}
              onSelect={() => handleCoachSelect(c)}
            />
          ))}
        </div>
      )}

      <PaymentDisclaimerModal
        open={!!pendingCoach}
        onAgree={handleDisclaimerAgree}
        onCancel={() => setPendingCoach(null)}
      />
    </div>
  );
}
