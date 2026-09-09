import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { claimAutoTour, markTourShown, tourKey, tourSeen, tourSteps } from '../utils/guideTour.mjs';

export default function GuideTour() {
  const { user, role } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const key = tourKey(role, user?.data?.id);
  const [tour, setTour] = useState(null);
  const [box, setBox] = useState(null);
  const nextRef = useRef(null);
  const active = tour?.key === key ? tour : null;
  const steps = tourSteps(role);
  const step = active ? steps[active.index] : null;

  useEffect(() => {
    const eligible = role === 'parent' ? location.pathname === '/' : ['/coach', '/coach/profile'].includes(location.pathname);
    if (!key || !user?.token || !eligible || active) return;
    let cancelled = false;
    const claim = () => claimAutoTour(key, async () => {
      const response = await fetch('/api/onboarding/claim', {
        method: 'POST', headers: { Authorization: `Bearer ${user.token}` },
      });
      if (!response.ok) throw new Error('Tour status unavailable');
      return response.json();
    });
    const start = () => {
      markTourShown(key);
      setTour({ key, index: 0 });
    };
    if (location.state?.replayFeatureTour) {
      start();
      navigate(location.pathname, { replace: true, state: null });
      claim();
    } else if (!tourSeen(key)) {
      claim().then(show => { if (!cancelled && show && !tourSeen(key)) start(); });
    }
    return () => { cancelled = true; };
  }, [key, role, user?.token, location.pathname, location.state?.replayFeatureTour, active, navigate]);

  useEffect(() => {
    if (!active) return;
    const root = document.getElementById('root');
    const oldInert = root.inert;
    const focused = document.activeElement;
    root.inert = true;
    nextRef.current?.focus();
    return () => {
      root.inert = oldInert;
      if (focused?.isConnected) focused.focus();
    };
  }, [active?.key]);

  useEffect(() => {
    if (!step) return;
    setBox(null);
    if (step.route) navigate(step.route, { replace: true });
    let frame;
    let scrolled;
    let last = '';
    const measure = () => {
      const target = document.querySelector(step.target);
      if (target) {
        if (scrolled !== target) {
          target.scrollIntoView({ block: 'center', behavior: 'instant' });
          scrolled = target;
        }
        const rect = target.getBoundingClientRect();
        const offset = { x: 0, y: 0, bottom: innerHeight };
        const x = Math.max(8, rect.x + offset.x);
        const y = Math.max(8, rect.y + offset.y);
        const bottom = Math.min(innerHeight - 8, offset.bottom, rect.bottom + offset.y);
        const next = { x, y, width: Math.min(rect.width, innerWidth - x - 8), height: Math.max(0, bottom - y) };
        const serial = JSON.stringify(next);
        if (serial !== last) { setBox(next); last = serial; }
      }
      frame = requestAnimationFrame(measure);
    };
    frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [active?.key, active?.index, navigate]);

  if (!active || !step) return null;
  function close() {
    setTour(null);
    navigate(role === 'coach' ? '/coach' : '/', { replace: true, state: null });
  }
  const width = Math.min(328, innerWidth - 40);
  const left = (innerWidth - width) / 2;
  const below = box && box.y < innerHeight * 0.42 && box.y + box.height < innerHeight - 245;
  const top = box ? (below ? box.y + box.height + 62 : Math.max(30, box.y - 268)) : Math.max(30, innerHeight / 2 - 110);
  const pointX = box ? Math.min(innerWidth - 20, box.x + box.width / 2) : 0;
  const pointY = box ? (below ? box.y + box.height + 5 : box.y - 5) : 0;
  return createPortal(
    <div role="dialog" aria-modal="true" aria-labelledby="guide-tour-title" className="fixed inset-0 z-[100] text-white"
      style={{ background: 'rgba(0,0,0,.68)' }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') close();
        if (event.key === 'Tab') {
          const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
          const index = buttons.indexOf(document.activeElement);
          event.preventDefault();
          buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
        }
      }}>
      {box && <>
        <div aria-hidden="true" className="pointer-events-none absolute rounded-xl border-2 border-white"
          style={{ left: box.x - 3, top: box.y - 3, width: box.width + 6, height: Math.min(box.height + 6, 150) }} />
        <svg aria-hidden="true" className="pointer-events-none absolute inset-0 h-full w-full" fill="none" stroke="white" strokeWidth="2.5">
          <path d={below ? `M ${pointX + 22} ${pointY + 46} Q ${pointX - 8} ${pointY + 32} ${pointX} ${pointY} m -8 11 8 -11 7 12` : `M ${pointX - 24} ${pointY - 42} Q ${pointX + 8} ${pointY - 28} ${pointX} ${pointY} m -7 -12 7 12 9 -10`} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </>}
      <div className="absolute" style={{ left, top, width }}>
        <p className="mb-3 text-sm text-white/75">{active.index + 1} / {steps.length} · 功能引導</p>
        <h2 id="guide-tour-title" className="text-2xl font-bold leading-snug">{step.title}</h2>
        <p className="mt-3 text-base leading-7">{step.text}</p>
        <div className="mt-6 flex items-center gap-4">
          <button ref={nextRef} type="button" className="min-h-11 flex-1 rounded-full border-2 border-white px-6 py-2 font-bold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white"
            onClick={() => active.index === steps.length - 1 ? close() : setTour({ ...active, index: active.index + 1 })}>下一步</button>
          <button type="button" className="min-h-11 rounded-full px-5 py-2 underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white" onClick={close}>跳過</button>
        </div>
      </div>
    </div>, document.body,
  );
}
