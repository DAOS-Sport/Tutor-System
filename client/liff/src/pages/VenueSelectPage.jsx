import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { venuesApi } from '../api/venues';
import LoadingSpinner from '../components/LoadingSpinner';
import { useToast } from '../context/ToastContext';

export default function VenueSelectPage() {
  const [params] = useSearchParams();
  const courseType = params.get('courseType') || '1';
  const navigate = useNavigate();
  const toast = useToast();
  const [venues, setVenues] = useState(null);

  useEffect(() => {
    let alive = true;
    venuesApi
      .list()
      .then((d) => alive && setVenues(d))
      .catch(() => alive && toast.error('場館清單載入失敗'));
    return () => {
      alive = false;
    };
  }, [toast]);

  if (!venues) return <LoadingSpinner fullPage label="載入場館中…" />;

  return (
    <div className="px-4 py-4">
      <p className="mb-4 text-xs text-gray-500">選擇您要上課的場館</p>
      <div className="space-y-3">
        {venues.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => navigate(`/coaches?venue=${v.id}&courseType=${courseType}`)}
            className="block w-full rounded-2xl border border-gray-200 bg-white p-4 text-left active:scale-[0.99]"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-base font-bold text-brand-primary">{v.name}</h3>
                <p className="mt-1 text-xs text-gray-500">{v.address}</p>
              </div>
              <span className="shrink-0 rounded-full bg-brand-teal/10 px-2 py-1 text-xs font-bold text-brand-teal">
                {v.code}
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
