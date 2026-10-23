import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, NavLink, Route, Routes, useNavigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './api.jsx';
import { ApplicantHome, ApplicationForm, ApplicationStatus } from './Applicant.jsx';
import { ReviewQueue, ReviewCase } from './Officer.jsx';
import { CheckerQueue, CheckerCase, AuditView, Dashboard, Watchlist } from './Checker.jsx';
import './styles.css';

const HOME = { APPLICANT: '/applicant', KYC_OFFICER: '/officer', COMPLIANCE_OFFICER: '/checker' };

function Login() {
  const { login, register } = useAuth();
  const nav = useNavigate();
  const [mode, setMode] = useState('login'); // 'login' | 'signup'
  const signup = mode === 'signup';
  const [name, setName] = useState('');
  const [email, setEmail] = useState('applicant@test.com');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState('');
  const [fieldErrs, setFieldErrs] = useState({});
  const [busy, setBusy] = useState(false);

  const switchMode = (m) => {
    setMode(m); setErr(''); setFieldErrs({}); setPassword(''); setConfirm('');
    setEmail(m === 'signup' ? '' : 'applicant@test.com');
  };

  const submit = async (e) => {
    e.preventDefault();
    setErr(''); setFieldErrs({});
    if (signup && password !== confirm) { setFieldErrs({ confirm: 'Passwords do not match' }); return; }
    setBusy(true);
    try {
      const user = signup ? await register(name.trim(), email.trim(), password) : await login(email, password);
      nav(HOME[user.role]);
    } catch (x) {
      setFieldErrs(x.errors || {});
      setErr(Object.keys(x.errors || {}).length ? '' : x.message);
    } finally { setBusy(false); }
  };

  const fe = (k) => fieldErrs[k] && <span className="error small" role="alert">{fieldErrs[k]}</span>;
  return (
    <main className="narrow">
      <h1>OnboardIQ</h1>
      <p className="muted">Deccan Digital Bank - savings account KYC</p>
      <form onSubmit={submit} className="card" noValidate={false}>
        <h2>{signup ? 'Create applicant account' : 'Log in'}</h2>
        {signup && (
          <label>Full name
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" aria-invalid={!!fieldErrs.name} required />
            {fe('name')}
          </label>
        )}
        <label>Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" aria-invalid={!!fieldErrs.email} required />
          {fe('email')}
        </label>
        <label>Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={signup ? 'new-password' : 'current-password'} minLength={signup ? 8 : undefined} aria-invalid={!!fieldErrs.password} required />
          {signup && !fieldErrs.password && <span className="muted small">At least 8 characters</span>}
          {fe('password')}
        </label>
        {signup && (
          <label>Confirm password
            <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" aria-invalid={!!fieldErrs.confirm} required />
            {fe('confirm')}
          </label>
        )}
        {err && <p className="error" role="alert">{err}</p>}
        <button type="submit" disabled={busy}>{busy ? 'Please wait...' : signup ? 'Sign up' : 'Log in'}</button>
        <p className="small">
          {signup ? 'Already have an account? ' : 'New applicant? '}
          <button type="button" className="link" onClick={() => switchMode(signup ? 'login' : 'signup')}>{signup ? 'Log in' : 'Create an account'}</button>
        </p>
        {!signup && <p className="muted small">Demo users: applicant@test.com, officer@test.com, officer2@test.com, checker@test.com (password Password@123)</p>}
      </form>
    </main>
  );
}

function Guard({ role, children }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== role) return <Navigate to={HOME[user.role]} replace />;
  return children;
}

function Shell({ children }) {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  const links = {
    APPLICANT: [['/applicant', 'My applications'], ['/applicant/new', 'New application']],
    KYC_OFFICER: [['/officer', 'Review queue']],
    COMPLIANCE_OFFICER: [['/checker', 'Checker queue'], ['/checker/dashboard', 'Dashboard'], ['/checker/watchlist', 'Watchlist']],
  }[user?.role] || [];
  return (
    <>
      {user && (
        <header>
          <strong>OnboardIQ</strong>
          <nav aria-label="Main">{links.map(([to, label]) => <NavLink key={to} to={to} end>{label}</NavLink>)}</nav>
          <span className="muted small">{user.email} ({user.role})</span>
          <button className="link" onClick={() => { logout(); nav('/login'); }}>Log out</button>
        </header>
      )}
      {children}
    </>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthProvider>
      <BrowserRouter>
        <Shell>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/applicant" element={<Guard role="APPLICANT"><ApplicantHome /></Guard>} />
            <Route path="/applicant/new" element={<Guard role="APPLICANT"><ApplicationForm /></Guard>} />
            <Route path="/applicant/:id" element={<Guard role="APPLICANT"><ApplicationStatus /></Guard>} />
            <Route path="/officer" element={<Guard role="KYC_OFFICER"><ReviewQueue /></Guard>} />
            <Route path="/officer/:id" element={<Guard role="KYC_OFFICER"><ReviewCase /></Guard>} />
            <Route path="/checker" element={<Guard role="COMPLIANCE_OFFICER"><CheckerQueue /></Guard>} />
            <Route path="/checker/case/:id" element={<Guard role="COMPLIANCE_OFFICER"><CheckerCase /></Guard>} />
            <Route path="/checker/audit/:id" element={<Guard role="COMPLIANCE_OFFICER"><AuditView /></Guard>} />
            <Route path="/checker/dashboard" element={<Guard role="COMPLIANCE_OFFICER"><Dashboard /></Guard>} />
            <Route path="/checker/watchlist" element={<Guard role="COMPLIANCE_OFFICER"><Watchlist /></Guard>} />
            <Route path="*" element={<Navigate to="/login" replace />} />
          </Routes>
        </Shell>
      </BrowserRouter>
    </AuthProvider>
  </StrictMode>,
);
