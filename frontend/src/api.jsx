// Tiny API client + auth state. Token lives in sessionStorage (cleared when the tab closes).
import { createContext, useContext, useState } from 'react';

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error || `HTTP ${status}`);
    this.status = status;
    this.errors = body?.errors || {};
  }
}

const token = () => sessionStorage.getItem('token');

export async function api(path, { method = 'GET', body, form } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: { ...(token() && { authorization: `Bearer ${token()}` }), ...(body && { 'content-type': 'application/json' }) },
    body: form || (body && JSON.stringify(body)),
  });
  if (res.status === 401 && path !== '/auth/login') { sessionStorage.clear(); window.location.assign('/login'); }
  const type = res.headers.get('content-type') || '';
  const data = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// Authenticated download (audit CSV, document images) -> object URL.
export async function blobUrl(path) {
  const res = await fetch('/api' + path, { headers: { authorization: `Bearer ${token()}` } });
  if (!res.ok) throw new ApiError(res.status, {});
  return URL.createObjectURL(await res.blob());
}

const AuthCtx = createContext(null);
export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => JSON.parse(sessionStorage.getItem('user') || 'null'));
  const startSession = (r) => {
    sessionStorage.setItem('token', r.token);
    sessionStorage.setItem('user', JSON.stringify(r.user));
    setUser(r.user);
    return r.user;
  };
  const login = async (email, password) => startSession(await api('/auth/login', { method: 'POST', body: { email, password } }));
  // Self-service sign-up: creates an APPLICANT account and signs the person in.
  const register = async (name, email, password) => startSession(await api('/auth/register', { method: 'POST', body: { name, email, password } }));
  const logout = () => { sessionStorage.clear(); setUser(null); };
  return <AuthCtx.Provider value={{ user, login, register, logout }}>{children}</AuthCtx.Provider>;
}
export const useAuth = () => useContext(AuthCtx);

export const fmtDate = (d) => (d ? new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '');
