import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, getSession, setSession } from "./api.js";

/**
 * Authentication provider — dev-login, silent session restore, organization
 * switching, and a credits balance shared across the app.
 */

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [state, setState] = useState(() => {
    const session = getSession();
    return {
      user: session?.user ?? null,
      org: session?.org ?? null,
      orgs: session?.orgs ?? [],
      ready: !session, // no session → nothing to restore
    };
  });
  const [credits, setCredits] = useState(null);

  const applySession = useCallback((data) => {
    setSession(data);
    setState({ user: data.user, org: data.org, orgs: data.orgs ?? [], ready: true });
  }, []);

  // Restore session on mount.
  useEffect(() => {
    if (state.ready) return;
    let cancelled = false;
    (async () => {
      try {
        const me = await api.get("/v1/me");
        if (cancelled) return;
        const session = getSession();
        setSession({ ...session, user: { id: me.id, email: me.email, display_name: me.display_name }, org: me.org, orgs: me.orgs });
        setState({ user: { id: me.id, email: me.email, display_name: me.display_name }, org: me.org, orgs: me.orgs ?? [], ready: true });
        setCredits(me.credits ?? null);
      } catch {
        if (!cancelled) {
          setSession(null);
          setState({ user: null, org: null, orgs: [], ready: true });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [state.ready]);

  const devLogin = useCallback(async (email, displayName) => {
    const data = await api.post("/v1/auth/dev-login", {
      email,
      ...(displayName ? { display_name: displayName } : {}),
    }, { auth: false });
    applySession(data);
    return data;
  }, [applySession]);

  const logout = useCallback(() => {
    setSession(null);
    setState({ user: null, org: null, orgs: [], ready: true });
    setCredits(null);
  }, []);

  const switchOrg = useCallback(async (orgId) => {
    const data = await api.post("/v1/auth/switch-org", { org_id: orgId });
    applySession(data);
  }, [applySession]);

  const refreshCredits = useCallback(async () => {
    try {
      const billing = await api.get("/v1/billing/credits");
      setCredits({ balance: billing.balance, reserved: billing.reserved, available: billing.available });
      return billing;
    } catch {
      return null;
    }
  }, []);

  const value = useMemo(
    () => ({
      ...state,
      credits,
      setCredits,
      devLogin,
      logout,
      switchOrg,
      refreshCredits,
      isAuthed: Boolean(state.user),
    }),
    [state, credits, devLogin, logout, switchOrg, refreshCredits],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
