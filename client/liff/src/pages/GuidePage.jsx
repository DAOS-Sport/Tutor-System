import React from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function GuidePage() {
  const { role } = useAuth();
  const coach = role === 'coach';
  return (
    <section className="flex h-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-white px-4">
        <Link to={coach ? '/coach/profile' : '/'} aria-label={coach ? '返回個人頁' : '返回首頁'}
          className="flex h-11 w-11 items-center justify-center rounded-full text-2xl text-brand-primary">‹</Link>
        <h1 className="font-bold text-brand-primary">{coach ? '教練' : '家長'}教學指南</h1>
      </header>
      <Link to={coach ? '/coach' : '/'} state={{ replayFeatureTour: true }}
        className="flex min-h-11 shrink-0 items-center justify-between border-b border-brand-teal/20 bg-brand-teal/5 px-5 text-sm text-brand-primary">
        <span>想再認識一次各項功能？</span><span className="font-bold text-brand-primary">重看功能引導 ↗</span>
      </Link>
      <iframe data-guide-frame title={coach ? '教練操作說明' : '家長操作說明'}
        src={`/brand/guides/${coach ? 'coach' : 'parent'}.html?v=20260909-5`}
        className="min-h-0 w-full flex-1 border-0" />
    </section>
  );
}
