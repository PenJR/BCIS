import { useEffect, useMemo, useState } from 'react';
import { BrowserRouter, HashRouter, Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { apiHealth, apiRequest } from './api';
import { auditRoles, collectionWriteRoles, ledgerViewRoles } from './roles';
import Workspace from './Workspace';
import './App.css';

type User = {
  id: number;
  username: string;
  fullName: string;
  email?: string | null;
  status: string;
  role: string;
};

type Auth = {
  token: string;
  user: User;
};

const loginSchema = z.object({
  username: z.string().trim().min(1, 'Enter your username.'),
  password: z.string().min(1, 'Enter your password.'),
});

type LoginFields = z.infer<typeof loginSchema>;

const navigation = [
  { path: '/', label: 'Dashboard' },
  { path: '/subscribers', label: 'Subscribers' },
  { path: '/service-accounts', label: 'Service accounts' },
  { path: '/billing', label: 'Billing & invoices' },
  { path: '/payments', label: 'Payments' },
  { path: '/collections', label: 'Collections', roles: collectionWriteRoles },
  { path: '/receivables', label: 'Receivables' },
  { path: '/receipts', label: 'Receipts' },
  { path: '/reports', label: 'Reports', roles: ledgerViewRoles },
  { path: '/audit-logs', label: 'Audit logs', roles: auditRoles },
];

function canOpen(path: string, role: string): boolean {
  const item = navigation.find((entry) => entry.path === path);
  if (!item) return false;
  return !('roles' in item) || !item.roles || item.roles.includes(role);
}

function Login({ onAuthenticated }: { onAuthenticated: (auth: Auth) => void }) {
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginFields>({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: '', password: '' },
  });

  const submit = handleSubmit(async (values) => {
    setError('');
    setWorking(true);
    try {
      const response = await apiRequest<{ token: string; user: User }>(
        '/api/v1/auth/login',
        undefined,
        { method: 'POST', body: JSON.stringify(values) },
      );
      if (!response.success || !response.data?.token || !response.data.user) {
        throw new Error(response.message ?? 'Sign-in failed.');
      }
      onAuthenticated(response.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to sign in.');
    } finally {
      setWorking(false);
    }
  });

  return (
    <main className="login-shell">
      <section className="login-card">
        <div className="brand-row">
          <div className="brand-mark">B</div>
          <div>
            <p className="eyebrow">Broadband operations</p>
            <h1>BCIS Office</h1>
            <p className="muted">Billing, collections and subscriber services</p>
          </div>
        </div>
        <form className="form-stack" onSubmit={submit}>
          <label className="field">
            Username
            <input autoComplete="username" {...register('username')} />
            {errors.username && <small className="field-error">{errors.username.message}</small>}
          </label>
          <label className="field">
            Password
            <input type="password" autoComplete="current-password" {...register('password')} />
            {errors.password && <small className="field-error">{errors.password.message}</small>}
          </label>
          {error && <div className="notice error" role="alert">{error}</div>}
          <button className="primary-button" disabled={working}>
            {working ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="login-footnote">Sign in using your BCIS staff account.</p>
      </section>
    </main>
  );
}

function ProtectedRoute({
  auth,
  children,
  allowedRoles,
}: {
  auth: Auth | null;
  children: React.ReactNode;
  allowedRoles?: string[];
}) {
  const location = useLocation();
  if (!auth) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (allowedRoles && !allowedRoles.includes(auth.user.role)) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

function AppShell({
  auth,
  onLogout,
}: {
  auth: Auth;
  onLogout: () => Promise<void>;
}) {
  const location = useLocation();
  const [health, setHealth] = useState('Checking service…');
  const [logoutError, setLogoutError] = useState('');

  useEffect(() => {
    let active = true;
    void apiHealth()
      .then((result) => {
        if (active) setHealth(
          typeof result === 'object' && result !== null && 'success' in result && result.success
            ? 'API connected'
            : 'API unavailable',
        );
      })
      .catch(() => {
        if (active) setHealth('API unavailable');
      });
    return () => { active = false; };
  }, []);

  const links = useMemo(
    () => navigation.filter((item) => canOpen(item.path, auth.user.role)),
    [auth.user.role],
  );

  const logout = async () => {
    setLogoutError('');
    try {
      await onLogout();
    } catch (cause) {
      setLogoutError(cause instanceof Error ? cause.message : 'Could not sign out.');
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Link className="brand" to="/">
          <span className="brand-icon">B</span>
          <span><strong>BCIS</strong><small>Office system</small></span>
        </Link>
        <div className="nav-caption">WORKSPACE</div>
        <nav className="sidebar-nav" aria-label="Main navigation">
          {links.map((item) => (
            <Link
              key={item.path}
              className={`nav-link ${location.pathname === item.path ? 'active' : ''}`}
              to={item.path}
            >
              <span className="nav-dot" />
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className={`connection-dot ${health === 'API connected' ? 'online' : ''}`} />
          <span>{health}</span>
        </div>
      </aside>
      <main className="main-shell">
        <header className="topbar">
          <div>
            <p className="eyebrow">Operations console</p>
            <h1>{navigation.find((item) => item.path === location.pathname)?.label ?? 'BCIS Office'}</h1>
          </div>
          <div className="profile">
            <div className="profile-copy">
              <strong>{auth.user.fullName}</strong>
              <span>{auth.user.role.replace(/_/g, ' ')}</span>
            </div>
            <button className="button button-quiet" type="button" onClick={() => void logout()}>
              Sign out
            </button>
          </div>
        </header>
        {logoutError && <div className="notice error">{logoutError}</div>}
        <Routes>
          <Route path="/" element={<ProtectedRoute auth={auth}><Workspace page="dashboard" auth={auth} /></ProtectedRoute>} />
          <Route path="/subscribers" element={<ProtectedRoute auth={auth}><Workspace page="subscribers" auth={auth} /></ProtectedRoute>} />
          <Route path="/service-accounts" element={<ProtectedRoute auth={auth}><Workspace page="service-accounts" auth={auth} /></ProtectedRoute>} />
          <Route path="/billing" element={<ProtectedRoute auth={auth}><Workspace page="billing" auth={auth} /></ProtectedRoute>} />
          <Route path="/payments" element={<ProtectedRoute auth={auth}><Workspace page="payments" auth={auth} /></ProtectedRoute>} />
          <Route path="/collections" element={<ProtectedRoute auth={auth} allowedRoles={collectionWriteRoles}><Workspace page="collections" auth={auth} /></ProtectedRoute>} />
          <Route path="/receivables" element={<ProtectedRoute auth={auth}><Workspace page="receivables" auth={auth} /></ProtectedRoute>} />
          <Route path="/receipts" element={<ProtectedRoute auth={auth}><Workspace page="receipts" auth={auth} /></ProtectedRoute>} />
          <Route path="/reports" element={<ProtectedRoute auth={auth} allowedRoles={ledgerViewRoles}><Workspace page="reports" auth={auth} /></ProtectedRoute>} />
          <Route path="/audit-logs" element={<ProtectedRoute auth={auth} allowedRoles={auditRoles}><Workspace page="audit-logs" auth={auth} /></ProtectedRoute>} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function AppContent() {
  const [auth, setAuth] = useState<Auth | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

  if (!auth) {
    if (location.pathname !== '/login') {
      return <Navigate to="/login" replace />;
    }
    return <Login onAuthenticated={(nextAuth) => {
      setAuth(nextAuth);
      navigate('/');
    }} />;
  }

  if (location.pathname === '/login') return <Navigate to="/" replace />;

  const logout = async () => {
    const response = await apiRequest('/api/v1/auth/logout', auth.token, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    if (!response.success) throw new Error(response.message ?? 'Sign-out failed.');
    setAuth(null);
    navigate('/login');
  };

  return <AppShell auth={auth} onLogout={logout} />;
}

export default function App() {
  const Router = window.location.protocol === 'file:' ? HashRouter : BrowserRouter;

  return (
    <Router>
      <AppContent />
    </Router>
  );
}
