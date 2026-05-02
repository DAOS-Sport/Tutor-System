import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { coursesApi } from '../api/courses';
import CourseCard from '../components/CourseCard';
import LoadingSpinner from '../components/LoadingSpinner';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'pending_payment', label: '待對帳' },
  { key: 'active', label: '進行中' },
  { key: 'completed', label: '已結束' },
];

export default function MyCoursesPage() {
  const navigate = useNavigate();
  const { parent } = useAuth();
  const toast = useToast();
  const [courses, setCourses] = useState(null);
  const [filter, setFilter] = useState('all');
  const [loadError, setLoadError] = useState(null);

  function load() {
    setLoadError(null);
    setCourses(null);
    let alive = true;
    coursesApi
      .myCourses(parent.id)
      .then((d) => alive && setCourses(d || []))
      .catch(() => {
        if (!alive) return;
        setLoadError('課程資料載入失敗');
        toast.error('課程資料載入失敗');
      });
    return () => {
      alive = false;
    };
  }

  useEffect(() => {
    return load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parent.id]);

  const filtered = useMemo(() => {
    if (!courses) return null;
    if (filter === 'all') return courses;
    return courses.filter((c) => c.payment_status === filter);
  }, [courses, filter]);

  const counts = useMemo(() => {
    const m = { all: 0, pending_payment: 0, active: 0, completed: 0 };
    (courses || []).forEach((c) => {
      m.all += 1;
      if (m[c.payment_status] != null) m[c.payment_status] += 1;
    });
    return m;
  }, [courses]);

  return (
    <div className="px-4 py-4">
      <h1 className="mb-3 text-base font-bold text-brand-primary">我的課程</h1>

      <div className="mb-4 -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium transition ${
              filter === f.key
                ? 'border-brand-primary bg-brand-primary text-white'
                : 'border-gray-200 bg-white text-gray-600'
            }`}
          >
            {f.label}（{counts[f.key]}）
          </button>
        ))}
      </div>

      {loadError ? (
        <div className="rounded-2xl border-2 border-dashed border-brand-error/40 bg-white px-6 py-10 text-center">
          <div className="mb-3 text-sm text-brand-error">{loadError}</div>
          <button
            type="button"
            onClick={load}
            className="rounded-lg bg-brand-primary px-4 py-2 text-sm font-bold text-white"
          >
            重新載入
          </button>
        </div>
      ) : filtered === null ? (
        <LoadingSpinner label="載入課程中…" />
      ) : filtered.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="space-y-3">
          {filtered.map((cp) => (
            <CourseCard key={cp.id} variant="period" period={cp} onClick={() => navigate(`/history/${cp.id}`)} />
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-gray-200 bg-white px-6 py-12 text-center">
      <div className="mb-3 text-3xl">📚</div>
      <h3 className="text-sm font-bold text-gray-700">目前沒有符合條件的課程</h3>
      <p className="mt-1 text-xs text-gray-500">回到首頁挑選教練，立即開始報名</p>
    </div>
  );
}
