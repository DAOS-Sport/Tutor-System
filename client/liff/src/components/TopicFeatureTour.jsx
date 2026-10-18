import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { markTourShown, tourKey } from '../utils/guideTour.mjs';
import { coachTopicPlan } from '../utils/coachTopicTours.mjs';
import { coachGuideContext } from '../utils/coachGuideDemo';
import { parentTopicPlan } from '../utils/parentTopicTours.mjs';
import { guideDemoContext } from '../utils/guideDemo';
import { venuesApi } from '../api/venues';
import { coachesApi } from '../api/coaches';
import { coursesApi } from '../api/courses';
import { courseTypesApi } from '../api/courseTypes';

const visible = node => node && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0 && getComputedStyle(node).visibility !== 'hidden';
function findTarget(step) {
  const selector = step.target === 'main' && step.targetText ? 'main h1, main h2, main h3, main h4, main p, main span, main button, main div' : step.target === 'main' ? 'main h1, main h3, main h4' : step.target;
  const candidates = Array.from(document.querySelectorAll(selector)).filter(visible);
  if (step.target.startsWith('[data-coach-guide=') || step.target.startsWith('[data-tour-nav=')) return candidates.length === 1 ? candidates[0] : null;
  return candidates
    .filter(node => !step.targetText || node.textContent.includes(step.targetText))
    .sort((a, b) => step.targetText ? a.textContent.length - b.textContent.length : 0)[0] || null;
}

export default function TopicFeatureTour({ onActiveChange }) {
  const { role, user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [tour, setTour] = useState(null);
  const [box, setBox] = useState(null);
  const [missing, setMissing] = useState(false);
  const [loadError, setLoadError] = useState('');
  // 說明文字實際需要的高度（教練端用它決定框線收多高，讓文字放得下、不必捲動）。
  const [panelNeed, setPanelNeed] = useState(320);
  const panel = useRef(null);
  const topicPlan = role === 'coach' ? coachTopicPlan : parentTopicPlan;
  const guidePath = role === 'coach' ? '/coach/guide' : '/guide';
  const homePath = role === 'coach' ? '/coach' : '/';
  const plan = tour && topicPlan(tour.id);
  const step = plan?.steps[tour.index];
  const active = ['parent', 'coach'].includes(role) && !!tour && tour.key === tourKey(role, user?.data?.id);

  useEffect(() => {
    const id = location.state?.topicTour;
    const next = topicPlan(id);
    const key = tourKey(role, user?.data?.id);
    // Cross-route tour state keeps topicTour so GeneralGuideTour never claims
    // onboarding mid-tour. guideDemo marks continuation and must not reset index 0.
    if (location.state?.guideDemo) {
      // A full browser reload loses in-memory tour state. Never leave an orphaned
      // DEMO page without its blocking overlay. A changed role/account invalidates
      // the original key as well, so clear only this tour and return to the guide.
      if (!tour || !next || !key || tour.key !== key) {
        setTour(null);
        navigate(guidePath, { replace: true, state: null });
      }
      return;
    }
    if (!next || !key) return;
    if (role === 'coach') {
      // Suppress this session's automatic overview after finishing or skipping
      // a topic; an explicit replay remains available from the guide page.
      markTourShown(key);
      const context = coachGuideContext();
      setTour({ id, key, index: 0, context });
      navigate(next.start, { replace: true, state: { topicTour: id, guideDemo: { kind: 'coach-feature-tour', topicId: id, ...context, view: '', index: 0 } } });
      return;
    }
    let cancelled = false;
    setLoadError('');
    (async () => {
      let courseType = id === 'parent-group' ? 2 : 1;
      if (id === 'parent-trial') {
        const types = await courseTypesApi.listActive();
        const trialType = (types || []).find((item) => item.trial_enabled === true);
        if (!trialType) throw Error('目前沒有啟用中的試上品項，無法開始此引導');
        courseType = Number(trialType.course_type);
      }
      const venues = await venuesApi.list();
      const listedVenue = (venues || []).find((item) => item.name === '新北高中' && item.purchasable !== false);
      if (!listedVenue) throw Error('新北高中目前未啟用或未開放購買，無法開始此引導');
      const venue = await venuesApi.detail(listedVenue.id);
      const coaches = await coachesApi.list({ venueId: listedVenue.id });
      const coach = (coaches || []).find((item) => item.is_placeholder || item.name === '待分配');
      if (!coach) throw Error('新北高中目前沒有待分配教練，無法開始此引導');
      const price = await coursesApi.basePrice(courseType, listedVenue.id);
      if (!price || !Number.isFinite(Number(price.original_price))) throw Error('目前無法取得新北高中的課程定價，無法開始此引導');
      const context = guideDemoContext(id, { venue, coach, price, courseType });
      if (cancelled) return;
      setTour({ id, key, index: 0, context });
      navigate(next.start, {
        replace: true,
        state: { topicTour: id, guideDemo: { kind: 'feature-tour', ...context, view: '', index: 0 } },
      });
    })().catch((error) => {
      if (!cancelled) setLoadError(error?.message || '教學資料無法載入');
    });
    return () => { cancelled = true; };
  }, [location.state?.topicTour, location.state?.guideDemo, role, user?.data?.id, navigate]);

  useEffect(() => {
    onActiveChange(active);
    return () => onActiveChange(false);
  }, [active, onActiveChange]);

  // Long real forms remain scrollable for reading. Only scrolling is forwarded;
  // the page stays inert and every data operation is independently guarded.
  useEffect(() => {
    if (!active || role !== 'coach' || !step) return;
    const overlay = panel.current?.parentElement;
    if (!overlay) return;
    const scrollBy = delta => {
      const target = findTarget(step);
      const scrollNode = target?.querySelector('[data-coach-guide-scroll]')
        || target?.closest('main') || document.scrollingElement;
      scrollNode?.scrollBy({ top: delta, behavior: 'instant' });
    };
    const wheel = event => {
      if (panel.current?.contains(event.target)) return;
      event.preventDefault(); scrollBy(event.deltaY);
    };
    let touchY = null;
    const start = event => { touchY = panel.current?.contains(event.target) ? null : event.touches[0]?.clientY; };
    const move = event => {
      if (touchY == null || !event.touches[0]) return;
      const nextY = event.touches[0].clientY;
      event.preventDefault(); scrollBy(touchY - nextY); touchY = nextY;
    };
    overlay.addEventListener('wheel', wheel, { passive: false });
    overlay.addEventListener('touchstart', start, { passive: true });
    overlay.addEventListener('touchmove', move, { passive: false });
    return () => {
      overlay.removeEventListener('wheel', wheel);
      overlay.removeEventListener('touchstart', start);
      overlay.removeEventListener('touchmove', move);
    };
  }, [active, role, step]);


  useEffect(() => {
    if (!active || !step) { setBox(null); return; }
    setBox(null);
    if (step.route || step.page) {
      const context = tour.context || {};
      const q = new URLSearchParams({ venue: context.venue?.id || '', coach: context.coach?.id || '', courseType: String(context.courseType || 1) });
      const routes = {
        trial: '/trial',
        venue: `/venue?courseType=${q.get('courseType')}${tour.id === 'parent-trial' ? '&trial=1' : ''}`,
        coaches: `/coaches?${q}${tour.id === 'parent-trial' ? '&trial=1' : ''}`,
        enroll: `/enroll?${q}${tour.id === 'parent-trial' ? '&trial=1' : ''}`,
        checkout: '/checkout/DEMO-CHECKOUT',
        profile: '/profile',
        groupNew: `/group/new?${q}`,
        groupStatus: '/group/DEMO-GROUP',
        groupJoin: '/group/join/DEMO-TOKEN',
        courses: '/my-courses',
        booking: '/book-slot/DEMO-PERIOD',
      };
      navigate(step.route || routes[step.page], {
        replace: true,
        state: {
          topicTour: tour.id,
          guideDemo: { kind: role === 'coach' ? 'coach-feature-tour' : 'feature-tour', ...(role === 'coach' ? { topicId: tour.id } : {}), ...context, view: step.view || '', index: tour.index },
        },
      });
    }
    setMissing(false);
    const root = document.getElementById('root');
    const oldInert = root.inert;
    const previous = document.activeElement;
    root.inert = true;
    panel.current?.querySelector('button')?.focus();
    let lastTarget;
    let frame;
    let previousRect = '';
    const began = performance.now();
    const measure = () => {
      const target = findTarget(step);
      setMissing(!target && performance.now() - began > 1500);
      if (target) {
        if (target !== lastTarget) { target.scrollIntoView({ block: role === 'coach' ? 'start' : 'center', behavior: 'instant' }); lastTarget = target; }
        const r = target.getBoundingClientRect();
        const x = Math.max(8, r.left), y = Math.max(8, r.top);
        const next = { x, y, width: Math.max(0, Math.min(r.right, innerWidth - 8) - x), height: Math.max(0, Math.min(r.bottom, innerHeight - 8) - y) };
        const serial = JSON.stringify(next);
        if (serial !== previousRect) { setBox(next.width > 0 && next.height > 0 ? next : null); previousRect = serial; }
      } else if (previousRect) { setBox(null); previousRect = ''; }
      frame = requestAnimationFrame(measure);
    };
    frame = requestAnimationFrame(measure);
    return () => { cancelAnimationFrame(frame); root.inert = oldInert; if (previous?.isConnected) previous.focus(); };
  }, [active, tour?.index, step]);


  useEffect(() => {
    const height = panel.current?.scrollHeight;
    if (height && Math.abs(height - panelNeed) > 2) setPanelNeed(height);
  });

  if (loadError) return createPortal(<div role="alert" className="fixed inset-0 z-[110] bg-black/70 p-8 text-white"><p>{loadError}</p><button onClick={() => { setLoadError(''); navigate(guidePath, { replace: true, state: null }); }}>返回指南</button></div>, document.body);
  if (!active || !step) return null;
  const close = () => { setTour(null); navigate(homePath, { replace: true, state: null }); };
  const finish = () => { setTour(null); navigate(role === 'coach' ? homePath : guidePath, { replace: true, state: null }); };
  const width = Math.min(328, innerWidth - 40);
  // 教練端版面與家長端相同（無底色、框線＋箭頭、文字在框外）。教練端反白的是整個區塊，常比螢幕還高，
  // 目標上方放得下整段說明時，文字放在框的上方；否則把框線收短，留出剛好放得下說明文字的空間，文字放在框的下方。
  const coachAbove = box && role === 'coach' && box.y - 20 >= panelNeed + 60;
  const shown = box && role === 'coach' && !coachAbove
    ? { ...box, height: Math.max(48, Math.min(box.height, innerHeight - box.y - panelNeed - 84)) } : box;
  const below = shown && (role === 'coach' ? !coachAbove : shown.y < innerHeight * .42 && shown.y + shown.height < innerHeight - 300);
  const top = shown ? (below ? shown.y + shown.height + 60 : Math.max(20, shown.y - (role === 'coach' ? panelNeed + 60 : 280))) : Math.max(20, innerHeight / 2 - 120);
  const pointX = shown ? Math.min(innerWidth - 20, shown.x + shown.width / 2) : 0;
  const pointY = shown ? (below ? shown.y + shown.height + 5 : shown.y - 5) : 0;
  return createPortal(
    <React.Fragment>

    <div role="dialog" aria-modal="true" aria-labelledby="topic-tour-title" className="fixed inset-0 z-[110] text-white" style={{ background: 'rgba(0,0,0,.68)' }}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); close(); }
        if (event.key === 'Tab') {
          const buttons = [...panel.current.querySelectorAll('button:not(:disabled)')];
          const index = buttons.indexOf(document.activeElement);
          event.preventDefault();
          buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
        }
      }}>
      {shown && <>
        <div aria-hidden="true" className="pointer-events-none absolute rounded-xl border-2 border-white" style={{ left: shown.x - 3, top: shown.y - 3, width: shown.width + 6, height: shown.height + 6 }} />
        <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" fill="none" stroke="white" strokeWidth="2.5">
          <path d={below ? `M ${pointX + 22} ${pointY + 46} Q ${pointX - 8} ${pointY + 32} ${pointX} ${pointY} m -8 11 8 -11 7 12` : `M ${pointX - 24} ${pointY - 42} Q ${pointX + 8} ${pointY - 28} ${pointX} ${pointY} m -7 -12 7 12 9 -10`} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </>}
      <section ref={panel} className="absolute overflow-y-auto" style={{ pointerEvents: 'auto', left: (innerWidth - width) / 2, top, width, maxHeight: Math.max(140, innerHeight - top - 16), textShadow: '0 1px 3px rgba(0,0,0,.8)' }}>
        <p className="mb-3 text-sm text-white/75">{tour.index + 1} / {plan.steps.length} · 功能引導</p>
        <div data-topic-tour-body className="contents">
          <h2 id="topic-tour-title" className="text-2xl font-bold leading-snug">{step.title}</h2>
          <p className="mt-3 text-base leading-7">{step.text}</p>
          {missing && <p role="status" className="mt-2 text-sm">此帳號目前沒有顯示這個操作位置，或資料尚未載入。略過不代表已完成操作。</p>}
        </div>
        <div data-topic-tour-actions className="mt-6 flex flex-wrap items-center gap-4">
          <button type="button" disabled={!box} className="min-h-11 flex-1 rounded-full border-2 border-white px-6 py-2 font-bold disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
            onClick={() => tour.index === plan.steps.length - 1 ? finish() : setTour({ ...tour, index: tour.index + 1 })}>
            {tour.index === plan.steps.length - 1 ? (role === 'coach' ? '完成，返回首頁' : '完成') : '下一步'}
          </button>
          <button type="button" className="min-h-11 rounded-full px-5 py-2 underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white" onClick={close}>{role === 'coach' ? '結束引導' : '跳過'}</button>
        </div>
      </section>
    </div></React.Fragment>, document.body);
}
