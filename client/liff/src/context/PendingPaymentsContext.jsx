import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useLocation } from 'react-router-dom';
import { coursesApi } from '../api/courses';
import { useAuth } from './AuthContext';

/**
 * 「待填寫/送出轉帳資料」的訂單計數（跨元件共享）。
 * 家長常在報名送出後跳出畫面去轉帳，導致訂單停在「待對帳、尚未上傳付款資料」狀態卻被遺忘、
 * 甚至重複報名。此 context 統一計算這類訂單數，供：
 *   1) 首頁橫幅（點擊導向「我的課程」待審核分頁）
 *   2) 底部導覽「我的課程」右上角紅色數字
 * 兩處共用同一份資料與刷新邏輯，避免各自為政、數字不一致。
 */
const PendingPaymentsContext = createContext(null);

// 一筆報名是否「待家長填寫/送出轉帳資料」：
//  - 生命週期為待對帳（pending_payment）
//  - 非團報（團報付款走另一條流程，不在此提醒）
//  - 尚未同時具備「匯款末五碼 + 付款證明」
// 判定與 MyCoursesPage 的 paymentSubmitted 一致（AND），確保紅點數＝實際會顯示
// 「上傳付款資料」按鈕的卡片數。
export function needsPaymentAction(cp) {
  return (
    cp?.lifecycle === 'pending_payment' &&
    !cp.group_order_id &&
    !(cp.payment_proof_url && cp.transfer_last_5)
  );
}

export function PendingPaymentsProvider({ children }) {
  const { role, parent } = useAuth();
  const location = useLocation();
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(false);
  // 併發保護：只採用最後一次請求的結果，避免快慢請求交錯覆蓋。
  const reqIdRef = useRef(0);

  const refresh = useCallback(() => {
    if (role !== 'parent' || !parent?.id) {
      setOrders([]);
      return Promise.resolve([]);
    }
    const myReq = ++reqIdRef.current;
    setLoading(true);
    return coursesApi
      .myCourses(parent.id)
      .then((list) => {
        if (myReq !== reqIdRef.current) return [];
        const pending = (Array.isArray(list) ? list : []).filter(needsPaymentAction);
        setOrders(pending);
        return pending;
      })
      .catch(() => {
        // 載入失敗不阻擋任何畫面；維持前一次計數（不硬歸零，避免紅點閃爍消失）。
        return [];
      })
      .finally(() => {
        if (myReq === reqIdRef.current) setLoading(false);
      });
  }, [role, parent?.id]);

  // 身分就緒後先抓一次（不論當前在哪一頁），讓非首頁分頁也能顯示紅點。
  const didInitialRef = useRef(false);
  useEffect(() => {
    if (role === 'parent' && parent?.id) {
      if (!didInitialRef.current) {
        didInitialRef.current = true;
        refresh();
      }
    } else {
      didInitialRef.current = false;
      setOrders([]);
    }
  }, [role, parent?.id, refresh]);

  // 回到首頁 / 我的課程時刷新，讓紅點與實際訂單同步（例如剛上傳完付款資料返回）。
  useEffect(() => {
    if (location.pathname === '/' || location.pathname === '/my-courses') {
      refresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  const value = useMemo(
    () => ({
      count: orders.length,
      orders,
      loading,
      refresh,
    }),
    [orders, loading, refresh],
  );

  return (
    <PendingPaymentsContext.Provider value={value}>{children}</PendingPaymentsContext.Provider>
  );
}

export function usePendingPayments() {
  const ctx = useContext(PendingPaymentsContext);
  if (!ctx) throw new Error('usePendingPayments must be used within <PendingPaymentsProvider>');
  return ctx;
}
