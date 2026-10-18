import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { guideCatalog } from '../utils/guideCatalog.mjs';
import { coachTopicPlan } from '../utils/coachTopicTours.mjs';
import { parentTopicPlan } from '../utils/parentTopicTours.mjs';

export default function GuidePage() {
  const { role } = useAuth();
  const coach = role === 'coach';
  const [query, setQuery] = useState('');
  const lessons = guideCatalog[coach ? 'coach' : 'parent'].filter(lesson => coach ? coachTopicPlan(lesson.id) : (lesson.id !== 'parent-booking' && parentTopicPlan(lesson.id)));
  const needle = query.trim().toLowerCase();
  const visible = lessons.filter(lesson => {
    const searchText = coach
      ? [lesson.title, ...coachTopicPlan(lesson.id).steps.flatMap(step => [step.title, step.text])]
      : [lesson.title, lesson.entry, ...lesson.steps, ...lesson.tips];
    return searchText.join(' ').toLowerCase().includes(needle);
  });
  return (
    <section className="min-h-full bg-white pb-6">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b bg-white px-4">
        <Link to={coach ? '/coach/profile' : '/'} aria-label={coach ? '返回個人頁' : '返回首頁'}
          className="flex h-11 w-11 items-center justify-center rounded-full text-2xl text-brand-primary">‹</Link>
        <h1 className="font-bold text-brand-primary">{coach ? '教練教學指南' : '家長功能引導'}</h1>
      </header>
      <Link to={coach ? '/coach' : '/'} state={{ replayFeatureTour: true }}
        className="flex min-h-11 shrink-0 items-center justify-between border-b border-brand-teal/20 bg-brand-teal/5 px-5 text-sm text-brand-primary">
        <span>想再認識一次各項功能？</span><span className="font-bold text-brand-primary">重看功能引導 ↗</span>
      </Link>
      <div className="space-y-4 p-4">
        <p className="text-sm leading-6 text-gray-600">{coach ? '選一個主題，按「下一步」查看功能說明。最後按「完成，返回首頁」恢復正常使用；也可隨時按「結束引導」回首頁。引導結束後會解除遮罩，不會代您操作或送出資料。' : '選一個主題，按「下一步」查看功能說明。最後按「完成」回指南；也可隨時按「跳過」回首頁。不會代您操作或送出資料。'}</p>
        <label className="block text-sm text-gray-700">搜尋教學
          <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={coach ? '例如：授課記錄、課前規劃、個人介紹' : '例如：團報、簽到、付款'} className="mt-1 min-h-11 w-full rounded-lg border border-gray-300 px-3 py-2" />
        </label>
        <p aria-live="polite" className="text-xs text-gray-500">顯示 {visible.length}／{lessons.length} 個主題</p>
        {visible.map(lesson => (
          <Link key={lesson.id} data-guide-entry to={coach ? '/coach/guide' : '/guide'} state={{ topicTour: lesson.id }}
            className="flex min-h-14 items-center justify-between gap-3 rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm font-bold text-brand-primary">
            <span>{lesson.title}</span><span className="shrink-0">開始引導 →</span>
          </Link>
        ))}
        {!visible.length && <p className="rounded-lg bg-gray-50 p-4 text-sm text-gray-600">沒有符合的教學，請換個關鍵字。</p>}
      </div>
    </section>
  );
}
