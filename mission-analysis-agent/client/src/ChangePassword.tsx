import { useState, type FormEvent } from 'react';
import { api, type User } from './api';
import Logo from './Logo';

export default function ChangePassword({ user, forced, onDone, onCancel }: { user: User; forced?: boolean; onDone: () => void; onCancel: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== repeat) return setError('The new passwords do not match');
    setBusy(true); setError('');
    try { await api('POST', '/api/auth/password', { current, next }); onDone(); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };

  const form = (
    <form className={forced ? 'auth-card' : 'dialog-body'} onSubmit={submit}>
      {forced && <div className="auth-brand"><Logo size={36} /><div><h1>Choose a new password</h1><p>Welcome, {user.displayName}. Your current password was set for you; replace it to continue.</p></div></div>}
      {!forced && <h2>Change password</h2>}
      <label>Current password<input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoFocus /></label>
      <label>New password<input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={10} /></label>
      <label>Repeat new password<input type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required /></label>
      <p className="hint">At least 10 characters, not containing your username. Other signed-in devices will be signed out.</p>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="row-end">
        <button type="button" className="btn" onClick={onCancel}>{forced ? 'Sign out' : 'Cancel'}</button>
        <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Change password'}</button>
      </div>
    </form>
  );
  return forced ? <div className="auth-page">{form}</div> : form;
}
