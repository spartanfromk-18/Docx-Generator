import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

/** Toast stack with aria-live announcements. */
const ToastContext = createContext(() => undefined);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);

  const push = useCallback((message, tone = "info", ttl = 4200) => {
    const id = ++idRef.current;
    setToasts((prev) => [...prev.slice(-3), { id, message, tone }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), ttl);
  }, []);

  const value = useMemo(() => {
    const fn = (message, tone, ttl) => push(message, tone, ttl);
    fn.success = (m, ttl) => push(m, "success", ttl);
    fn.error = (m, ttl) => push(m, "danger", ttl);
    fn.info = (m, ttl) => push(m, "info", ttl);
    return fn;
  }, [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.tone}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
