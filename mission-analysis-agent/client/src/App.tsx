import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { api, setCsrf, type User } from './api';
import Login from './Login';
import ChangePassword from './ChangePassword';
import Shell from './Shell';
import Admin from './Admin';

export type Theme = 'light' | 'dark';

export default function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined);
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('theme') as Theme) || 'light');

  useEffect(() => { document.documentElement.dataset.theme = theme; localStorage.setItem('theme', theme); }, [theme]);
  const refresh = useCallback(async () => {
    try { const me = await api<{ user: User; csrfToken: string }>('GET', '/api/me'); setCsrf(me.csrfToken); setUser(me.user); }
    catch { setUser(null); }
  }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const signOut = async () => { await api('POST', '/api/auth/logout').catch(() => {}); setCsrf(''); setUser(null); };
  const toggleTheme = () => setTheme((t) => (t === 'light' ? 'dark' : 'light'));

  if (user === undefined) return <div className="splash"><div className="spinner" /></div>;
  if (user === null) return <Login onSignedIn={(u, token) => { setCsrf(token); setUser(u); }} />;
  if (user.mustChangePassword) return <ChangePassword user={user} forced onDone={refresh} onCancel={signOut} />;
  return (
    <Routes>
      <Route path="/admin" element={user.role === 'superuser' ? <Admin user={user} /> : <Navigate to="/" replace />} />
      <Route path="/chat/:chatId" element={<Shell user={user} theme={theme} onToggleTheme={toggleTheme} onSignOut={signOut} onPasswordChanged={refresh} />} />
      <Route path="*" element={<Shell user={user} theme={theme} onToggleTheme={toggleTheme} onSignOut={signOut} onPasswordChanged={refresh} />} />
    </Routes>
  );
}
