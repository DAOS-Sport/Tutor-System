import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

const ToastContext = createContext(null);
let _seq = 0;

const TYPE_STYLE = {
  success: 'bg-brand-green text-white',
  error: 'bg-brand-error text-white',
  info: 'bg-brand-primary text-white',
  warning: 'bg-brand-amber text-white',
};

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);

  const remove = useCallback((id) => {
    setItems((arr) => arr.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (message, type = 'info', duration = 2400) => {
      const id = ++_seq;
      setItems((arr) => [...arr, { id, message, type }]);
      if (duration > 0) setTimeout(() => remove(id), duration);
      return id;
    },
    [remove]
  );

  const api = useMemo(
    () => ({
      success: (m, d) => push(m, 'success', d),
      error:   (m, d) => push(m, 'error', d),
      info:    (m, d) => push(m, 'info', d),
      warning: (m, d) => push(m, 'warning', d),
    }),
    [push]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 top-4 z-50 flex flex-col items-center gap-2 px-4">
        {items.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto w-full max-w-md rounded-lg px-4 py-3 text-sm font-medium shadow-lg ${TYPE_STYLE[t.type] || TYPE_STYLE.info}`}
            onClick={() => remove(t.id)}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within <ToastProvider>');
  return ctx;
}
