import { useEffect, useState } from 'react';

/**
 * 現在是不是桌機寬度。斷點與 Tailwind 的 md: 同一個值（768px）——
 * 兩邊用不同的數字，會出現「CSS already 換成手機版、JS 還以為是桌機」的區間，
 * 而那種錯只在某個特定寬度出現，最難重現。
 *
 * 預設 true（拿不到 matchMedia 時當桌機）：使用者明確要求桌機維持原行為，
 * 所以偵測失敗時要落在「照舊」那一邊，不是落在「改過的」那一邊。
 */
const MQ = '(min-width: 768px)';

export default function useIsDesktop() {
  const [isDesktop, setIsDesktop] = useState(
    () => (typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia(MQ).matches
      : true),
  );

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mql = window.matchMedia(MQ);
    const onChange = (e) => setIsDesktop(e.matches);
    setIsDesktop(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  return isDesktop;
}
