import { useState, type FormEvent } from 'react';
import { api, type User } from './api';
import Logo from './Logo';

export default function Login({ onSignedIn }: { onSignedIn: (user: User, csrf: string) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const r = await api<{ user: User; csrfToken: string }>('POST', '/api/auth/login', { username, password });
      onSignedIn(r.user, r.csrfToken);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand"><Logo size={36} /><div><h1>Mission Analysis Agent</h1><p>Investigate mission documents and telemetry</p></div></div>
        <label>Username<input autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required /></label>
        <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        {error && <div className="form-error" role="alert">{error}</div>}
        <button className="btn primary wide" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}
