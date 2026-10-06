import { useEffect, useMemo, useState } from 'react';
import './App.css';

type User = {
  id: number;
  username: string;
  fullName: string;
  email?: string | null;
  status: string;
  role: string;
};

type ApiResult<T> = {
  success: boolean;
  message?: string;
  data?: T;
  token?: string;
};

type PageKey =
  | 'dashboard'
  | 'subscribers'
  | 'billing'
  | 'payments'
  | 'collections'
  | 'reports'
  | 'administration';

const API_BASE = 'http://localhost:3000';

const subscribersData = [
  { account: 'BCIS-1001', name: 'Maria Santos', area: 'Malaybalay', status: 'ACTIVE' },
  { account: 'BCIS-1048', name: 'Ramon Dela Cruz', area: 'Valencia', status: 'OVERDUE' },
  { account: 'BCIS-1109', name: 'Alicia Gomez', area: 'Kibawe', status: 'ACTIVE' },
  { account: 'BCIS-1182', name: 'Benjie Flores', area: 'Manolo Fortich', status: 'SUSPENDED' },
];

const billingRows = [
  { invoice: 'INV-2458', subscriber: 'Maria Santos', amount: '₱1,250.00', status: 'UNPAID' },
  { invoice: 'INV-2461', subscriber: 'Ramon Dela Cruz', amount: '₱2,890.00', status: 'PARTIALLY PAID' },
  { invoice: 'INV-2464', subscriber: 'Alicia Gomez', amount: '₱1,580.00', status: 'PAID' },
  { invoice: 'INV-2470', subscriber: 'Benjie Flores', amount: '₱990.00', status: 'OVERDUE' },
];

const paymentRows = [
  { receipt: 'RCPT-0891', subscriber: 'Maria Santos', method: 'GCash', amount: '₱1,250.00', status: 'POSTED' },
  { receipt: 'RCPT-0893', subscriber: 'Ramon Dela Cruz', method: 'Cash', amount: '₱800.00', status: 'POSTED' },
  { receipt: 'RCPT-0895', subscriber: 'Alicia Gomez', method: 'Bank Transfer', amount: '₱1,580.00', status: 'PENDING' },
  { receipt: 'RCPT-0900', subscriber: 'Benjie Flores', method: 'Cash', amount: '₱500.00', status: 'REVERSED' },
];

const collectionRows = [
  { batch: 'BATCH-101', collector: 'J. Salazar', area: 'Malaybalay', status: 'SUBMITTED', cash: '₱48,250.00' },
  { batch: 'BATCH-102', collector: 'R. Magbanua', area: 'Valencia', status: 'IN_PROGRESS', cash: '₱36,900.00' },
  { batch: 'BATCH-103', collector: 'M. Lim', area: 'Kibawe', status: 'REMITTED', cash: '₱41,120.00' },
];

const reportRows = [
  { name: 'Daily Collection', owner: 'Accounting' },
  { name: 'Aging Report', owner: 'Collections' },
  { name: 'Subscriber Ledger', owner: 'Accounting' },
  { name: 'Audit Activity', owner: 'Administration' },
];

async function apiRequest<T>(path: string, options: RequestInit = {}, token?: string): Promise<ApiResult<T>> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers ?? {}),
    },
  });

  return (await response.json()) as ApiResult<T>;
}

function App() {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('Admin123!');
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [health, setHealth] = useState('Checking API...');
  const [users, setUsers] = useState<User[]>([]);
  const [serviceTypes, setServiceTypes] = useState<Array<{ id: number; name: string; description?: string | null }>>([]);
  const [error, setError] = useState('');
  const [activePage, setActivePage] = useState<PageKey>('dashboard');

  useEffect(() => {
    void (async () => {
      try {
        const result = await apiRequest<{ success: boolean; message: string }>('/api/health');
        setHealth(result.success ? 'Backend online' : 'Backend unavailable');
      } catch {
        setHealth('Backend unavailable');
      }
    })();
  }, []);

  useEffect(() => {
    if (!token) {
      return;
    }

    void (async () => {
      const me = await apiRequest<{ id: number; username: string; fullName: string; email?: string | null; status: string; role: string }>('/api/v1/auth/me', {}, token);

      if (me.success && me.data) {
        setUser({
          id: me.data.id,
          username: me.data.username,
          fullName: me.data.fullName,
          email: me.data.email,
          status: me.data.status,
          role: me.data.role,
        });
      }

      const userList = await apiRequest<User[]>('/api/v1/users', {}, token);
      if (userList.success && userList.data) {
        setUsers(userList.data);
      }

      const types = await apiRequest<Array<{ id: number; name: string; description?: string | null }>>('/api/v1/service-types', {}, token);
      if (types.success && types.data) {
        setServiceTypes(types.data);
      }
    })();
  }, [token]);

  const handleLogin = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');

    const result = await apiRequest<{ token: string; user: User }>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });

    if (!result.success || !result.data?.token) {
      setError(result.message ?? 'Login failed');
      return;
    }

    setToken(result.data.token);
    setUser(result.data.user);
  };

  const handleLogout = async () => {
    if (!token) {
      return;
    }

    await apiRequest('/api/v1/auth/logout', {
      method: 'POST',
    }, token);
    setToken(null);
    setUser(null);
    setUsers([]);
    setServiceTypes([]);
    setActivePage('dashboard');
  };

  const navItems = useMemo(
    () => [
      { key: 'dashboard' as const, label: 'Dashboard' },
      { key: 'subscribers' as const, label: 'Subscribers' },
      { key: 'billing' as const, label: 'Billing' },
      { key: 'payments' as const, label: 'Payments' },
      { key: 'collections' as const, label: 'Collections' },
      { key: 'reports' as const, label: 'Reports' },
      { key: 'administration' as const, label: 'Administration' },
    ],
    [],
  );

  if (!token || !user) {
    return (
      <div className="login-shell">
        <div className="login-card">
          <div className="brand-row">
            <div className="brand-mark">BCIS</div>
            <div>
              <h1>Subscription Billing</h1>
              <p>Collection and billing system</p>
            </div>
          </div>
          <p className="api-status">{health}</p>
          <form onSubmit={handleLogin} className="login-form">
            <label>
              Username
              <input value={username} onChange={(event) => setUsername(event.target.value)} />
            </label>
            <label>
              Password
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
            </label>
            {error ? <p className="error-text">{error}</p> : null}
            <button type="submit">Login</button>
          </form>
          <div className="demo-box">
            <strong>Demo user:</strong> admin / Admin123!
          </div>
        </div>
      </div>
    );
  }

  const renderPage = () => {
    switch (activePage) {
      case 'subscribers':
        return (
          <div className="page-block">
            <div className="section-heading">
              <h3>Subscribers</h3>
              <button className="secondary-action">New subscriber</button>
            </div>
            <div className="table-card">
              <table>
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Name</th>
                    <th>Area</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {subscribersData.map((row) => (
                    <tr key={row.account}>
                      <td>{row.account}</td>
                      <td>{row.name}</td>
                      <td>{row.area}</td>
                      <td><span className={`status-pill ${row.status.toLowerCase().replace(/\s+/g, '-')}`}>{row.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      case 'billing':
        return (
          <div className="page-block">
            <div className="section-heading">
              <h3>Billing</h3>
              <button className="secondary-action">Generate invoices</button>
            </div>
            <div className="table-card">
              <table>
                <thead>
                  <tr>
                    <th>Invoice</th>
                    <th>Subscriber</th>
                    <th>Amount</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {billingRows.map((row) => (
                    <tr key={row.invoice}>
                      <td>{row.invoice}</td>
                      <td>{row.subscriber}</td>
                      <td>{row.amount}</td>
                      <td><span className={`status-pill ${row.status.toLowerCase().replace(/\s+/g, '-')}`}>{row.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      case 'payments':
        return (
          <div className="page-block">
            <div className="section-heading">
              <h3>Payments</h3>
              <button className="secondary-action">Post payment</button>
            </div>
            <div className="table-card">
              <table>
                <thead>
                  <tr>
                    <th>Receipt</th>
                    <th>Subscriber</th>
                    <th>Method</th>
                    <th>Amount</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {paymentRows.map((row) => (
                    <tr key={row.receipt}>
                      <td>{row.receipt}</td>
                      <td>{row.subscriber}</td>
                      <td>{row.method}</td>
                      <td>{row.amount}</td>
                      <td><span className={`status-pill ${row.status.toLowerCase().replace(/\s+/g, '-')}`}>{row.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      case 'collections':
        return (
          <div className="page-block">
            <div className="section-heading">
              <h3>Collections</h3>
              <button className="secondary-action">Create batch</button>
            </div>
            <div className="table-card">
              <table>
                <thead>
                  <tr>
                    <th>Batch</th>
                    <th>Collector</th>
                    <th>Area</th>
                    <th>Status</th>
                    <th>Cash</th>
                  </tr>
                </thead>
                <tbody>
                  {collectionRows.map((row) => (
                    <tr key={row.batch}>
                      <td>{row.batch}</td>
                      <td>{row.collector}</td>
                      <td>{row.area}</td>
                      <td><span className={`status-pill ${row.status.toLowerCase().replace(/\s+/g, '-')}`}>{row.status}</span></td>
                      <td>{row.cash}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      case 'reports':
        return (
          <div className="page-block">
            <div className="section-heading">
              <h3>Reports</h3>
              <button className="secondary-action">Export report</button>
            </div>
            <div className="table-card">
              <table>
                <thead>
                  <tr>
                    <th>Report</th>
                    <th>Owner</th>
                  </tr>
                </thead>
                <tbody>
                  {reportRows.map((row) => (
                    <tr key={row.name}>
                      <td>{row.name}</td>
                      <td>{row.owner}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      case 'administration':
        return (
          <div className="page-block">
            <div className="section-heading">
              <h3>Administration</h3>
              <button className="secondary-action">Manage users</button>
            </div>
            <div className="panel-grid two-up">
              <div className="panel">
                <h3>User roster</h3>
                <ul className="data-list compact">
                  {users.slice(0, 4).map((entry) => (
                    <li key={entry.id}><span>{entry.fullName}</span><strong>{entry.role}</strong></li>
                  ))}
                </ul>
              </div>
              <div className="panel">
                <h3>Service types</h3>
                <ul className="data-list compact">
                  {serviceTypes.slice(0, 4).map((entry) => (
                    <li key={entry.id}><span>{entry.name}</span><strong>{entry.description ?? 'Standard'}</strong></li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        );
      case 'dashboard':
      default:
        return (
          <div className="page-block">
            <section className="stats-grid">
              <article className="stat-card">
                <span>Total subscribers</span>
                <strong>50</strong>
              </article>
              <article className="stat-card">
                <span>Active service accounts</span>
                <strong>60</strong>
              </article>
              <article className="stat-card">
                <span>Current receivables</span>
                <strong>₱284,550</strong>
              </article>
              <article className="stat-card">
                <span>Pending GCash</span>
                <strong>8</strong>
              </article>
            </section>

            <section className="panel-grid">
              <div className="panel">
                <h3>System overview</h3>
                <ul className="data-list">
                  <li><span>API</span><strong>{health}</strong></li>
                  <li><span>Username</span><strong>{user.username}</strong></li>
                  <li><span>Status</span><strong>{user.status}</strong></li>
                </ul>
              </div>

              <div className="panel">
                <h3>Collections snapshot</h3>
                <ul className="data-list">
                  <li><span>Today's collections</span><strong>₱18,250</strong></li>
                  <li><span>Monthly collections</span><strong>₱486,950</strong></li>
                  <li><span>Open collection batches</span><strong>4</strong></li>
                </ul>
              </div>

              <div className="panel">
                <h3>Service types</h3>
                <ul className="data-list">
                  {serviceTypes.slice(0, 4).map((entry) => (
                    <li key={entry.id}><span>{entry.name}</span><strong>{entry.description ?? 'Standard'}</strong></li>
                  ))}
                </ul>
              </div>
            </section>
          </div>
        );
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">BCIS</div>
        <nav>
          {navItems.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`nav-button ${activePage === item.key ? 'active' : ''}`}
              onClick={() => setActivePage(item.key)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <button className="logout-button" onClick={handleLogout}>Logout</button>
      </aside>

      <main className="content">
        <header className="topbar">
          <div>
            <p className="eyebrow">Logged in as</p>
            <h2>{user.fullName}</h2>
          </div>
          <div className="badge">{user.role}</div>
        </header>

        {renderPage()}
      </main>
    </div>
  );
}

export default App;
