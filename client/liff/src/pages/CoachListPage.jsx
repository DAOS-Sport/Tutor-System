import React, { useEffect, useMemo, useState } from 'react';
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
  const isTrial = params.get('trial') === '1'; // 試上流程（/trial 入口）一路帶到報名頁
  const navigate = useNavigate();
  const toast = useToast();

  const [coaches, setCoaches] = useState(null);
  const [venue, setVenue] = useState(null);
  const [basePrice, setBasePrice] = useState(0);
  const [priceInfo, setPriceInfo] = useState(null); // base-price 完整回應（trial_price / sessions_per_period）
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
        setPriceInfo(bp);
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
    navigate(`/enroll?venue=${venueId}&courseType=${courseType}&coach=${c.id}${isTrial ? '&trial=1' : ''}`);
  }

  const filteredCoaches = useMemo(() => {
    if (!Array.isArray(coaches)) return [];
    // Ragic 倍率是分類唯一真相：倍率不等於 1 即為資深教練。
    const isSenior = (coach) => {
      const multiplier = Number(coach.multiplier ?? coach.pricing_multiplier ?? 1);
      return Number.isFinite(multiplier) && multiplier !== 1;
    };
    // 空白全部濾掉，避免家長誤打空格導致查無結果。
    const normalizedQuery = nameQuery.replace(/\s+/g, '').toLocaleLowerCase('zh-TW');

    return coaches.filter((coach) => {
      if (!coachMatchesVenue(coach, [venueId, venue?.id, venue?.name])) return false;
      const senior = isSenior(coach);
      if (levelFilter === 'senior' && !senior) return false;
      if (levelFilter === 'regular' && senior) return false;
      const normalizedName = String(coach.name || '').replace(/\s+/g, '').toLocaleLowerCase('zh-TW');
      return !normalizedQuery || normalizedName.includes(normalizedQuery);
    });
  }, [coaches, levelFilter, nameQuery, venueId, venue?.id, venue?.name]);

  const realCoachCount = useMemo(
    () => filteredCoaches.filter((coach) => !coach.is_placeholder).length,
    [filteredCoaches],
  );

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

  return (
    <div className="px-4 py-4">
      <div className="mb-4 rounded-lg bg-brand-primary/5 px-3 py-2 text-xs text-brand-primary">
        <span className="font-bold">{venue.name}</span>
        <span className="mx-1.5 text-gray-300">·</span>
        <span>{courseTypeLabel(courseType)}</span>
        {isTrial && (
          <>
            <span className="mx-1.5 text-gray-300">·</span>
            <span className="rounded-full bg-brand-teal/10 px-2 py-0.5 font-bold text-brand-teal">試上單次課</span>
          </>
        )}
      </div>

      {coaches.length > 0 && (
        <div className="mb-3 flex flex-col gap-2 sm:flex-row">
          <select
            aria-label="教練分類"
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.currentTarget.value)}
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
      {coaches.length > 0 && (
        <p className="mb-3 text-xs text-gray-500">
          {`共 ${realCoachCount} 位教練${filteredCoaches.some((coach) => coach.is_placeholder) ? '；另可選擇「待分配」' : ''}，金色徽章為「資深教練」（含學習歷程服務）`}
        </p>
      )}

      {coaches.length > 0 && filteredCoaches.length === 0 && (
        <div className="rounded-lg border border-dashed border-gray-300 px-4 py-10 text-center text-sm text-gray-400">
          查無符合條件的教練，請調整篩選條件或搜尋關鍵字
        </div>
      )}

      {filteredCoaches.length > 0 && (
        <div className="space-y-3">
          {filteredCoaches.map((c) => (
            <CoachCard
              key={c.id}
              coach={c}
              basePrice={basePrice}
              isTrial={isTrial}
              trialPrice={priceInfo?.trial_price}
              sessionsPerPeriod={priceInfo?.sessions_per_period}
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
