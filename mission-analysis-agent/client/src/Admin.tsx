import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api, generatePassword, type AdminMission, type User } from './api';
import Logo from './Logo';
import Modal from './Modal';
import ToolBench from './ToolBench';
import Models from './Models';

type Editing = { mode: 'add' } | { mode: 'edit'; user: User } | { mode: 'password'; user: User } | null;

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Never');

function status(u: User) {
  if (u.disabled) return <span className="badge off">Disabled</span>;
  if (u.locked) return <span className="badge warn">Locked</span>;
  if (u.mustChangePassword) return <span className="badge info">Must change password</span>;
  return <span className="badge ok">Active</span>;
}

export default function Admin({ user: me }: { user: User }) {
  const [tab, setTab] = useState<'users' | 'missions' | 'tools' | 'models'>('users');
  const [users, setUsers] = useState<User[]>([]);
  const [missions, setMissions] = useState<AdminMission[]>([]);
  const [editing, setEditing] = useState<Editing>(null);
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    const [u, m] = await Promise.all([api<User[]>('GET', '/api/admin/users'), api<AdminMission[]>('GET', '/api/admin/missions')]);
    setUsers(u); setMissions(m);
  }, []);
  useEffect(() => { load().catch((e) => setNotice(e.message)); }, [load]);
  const missionName = (id: string) => missions.find((m) => m.id === id)?.name ?? id;

  return (
    <div className="admin">
      <header className="admin-header">
        <div className="brand"><Logo /><span>Mission Analysis Agent</span></div>
        <h1>Administration</h1>
        <Link className="btn ghost-dark" to="/">← Back to chats</Link>
      </header>
      <main className="admin-main">
        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'users'} className={tab === 'users' ? 'tab active' : 'tab'} onClick={() => setTab('users')}>Users <span className="count">{users.length}</span></button>
          <button role="tab" aria-selected={tab === 'missions'} className={tab === 'missions' ? 'tab active' : 'tab'} onClick={() => setTab('missions')}>Missions <span className="count">{missions.length}</span></button>
          <button role="tab" aria-selected={tab === 'models'} className={tab === 'models' ? 'tab active' : 'tab'} onClick={() => setTab('models')}>Models</button>
          <button role="tab" aria-selected={tab === 'tools'} className={tab === 'tools' ? 'tab active' : 'tab'} onClick={() => setTab('tools')}>Tool bench</button>
          {tab === 'users' && <button className="btn primary push-right" onClick={() => setEditing({ mode: 'add' })}>＋ Add user</button>}
        </div>
        {notice && <div className="notice" onClick={() => setNotice('')}>{notice}</div>}

        {tab === 'models' ? <Models /> : tab === 'tools' ? <ToolBench missions={missions} /> : tab === 'users' ? (
          <div className="card">
            <table className="table">
              <thead><tr><th>User</th><th>Role</th><th>Missions</th><th>Last sign-in</th><th>Status</th><th /></tr></thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td><div className="strong">{u.displayName}{u.id === me.id && <span className="you"> (you)</span>}</div><div className="mono muted">{u.username}</div></td>
                    <td>{u.role === 'superuser' ? <span className="badge accent">Superuser</span> : 'User'}</td>
                    <td>{u.role === 'superuser' ? <span className="muted">All missions</span> : u.missions.length ? u.missions.map((m) => <span key={m} className="chip">{missionName(m)}</span>) : <span className="muted">None</span>}</td>
                    <td className="muted">{when(u.lastLoginAt)}</td>
                    <td>{status(u)}</td>
                    <td className="actions">
                      <button className="btn small" onClick={() => setEditing({ mode: 'edit', user: u })}>Edit</button>
                      <button className="btn small" onClick={() => setEditing({ mode: 'password', user: u })}>Reset password</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="mission-grid">
            {missions.map((m) => (
              <div key={m.id} className="card mission-card">
                <div className="mission-head"><h3>{m.name}</h3><span className="mono muted">{m.id}</span></div>
                <p>{m.description || <span className="muted">No description</span>}</p>
                <div className="stats3">
                  <div><b>{m.documents ?? '–'}</b><span>documents</span></div>
                  <div><b>{m.hasTelemetry ? m.telemetryRuns ?? '–' : '–'}</b><span>telemetry runs</span></div>
                  <div><b>{m.users}</b><span>users with access</span></div>
                </div>
                <div className="mono muted small">MongoDB: {m.mongoDatabase}</div>
              </div>
            ))}
            <p className="muted small">Missions are created in the ingestion dashboard (localhost:8090) and appear here automatically.</p>
          </div>
        )}
      </main>

      <Modal open={editing !== null} onClose={() => setEditing(null)} wide={editing?.mode !== 'password'}>
        {editing?.mode === 'password' ? (
          <ResetPassword user={editing.user} onClose={() => setEditing(null)} onDone={(msg) => { setEditing(null); setNotice(msg); load(); }} />
        ) : editing ? (
          <UserForm me={me} user={editing.mode === 'edit' ? editing.user : null} missions={missions}
            onClose={() => setEditing(null)} onDone={(msg) => { setEditing(null); setNotice(msg); load(); }} />
        ) : null}
      </Modal>
    </div>
  );
}

function UserForm({ me, user, missions, onClose, onDone }: { me: User; user: User | null; missions: AdminMission[]; onClose: () => void; onDone: (msg: string) => void }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [password, setPassword] = useState(() => (user ? '' : generatePassword()));
  const [role, setRole] = useState<User['role']>(user?.role ?? 'user');
  const [granted, setGranted] = useState<string[]>(user?.missions ?? missions.slice(0, 1).map((m) => m.id));
  const [disabled, setDisabled] = useState(user?.disabled ?? false);
  const [error, setError] = useState('');
  const self = user?.id === me.id;

  const toggle = (id: string) => setGranted((g) => (g.includes(id) ? g.filter((x) => x !== id) : [...g, id]));
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError('');
    try {
      if (user) {
        await api('PATCH', `/api/admin/users/${user.id}`, { displayName, role, missions: granted, disabled, ...(user.locked ? { unlock: true } : {}) });
        onDone(`Saved ${user.username}.`);
      } else {
        await api('POST', '/api/admin/users', { username, displayName, password, role, missions: granted });
        onDone(`Created ${username}. Give them the temporary password; they must change it at first sign-in.`);
      }
    } catch (err) { setError((err as Error).message); }
  };

  return (
    <form className="dialog-body" onSubmit={submit}>
      <h2>{user ? `Edit ${user.username}` : 'Add user'}</h2>
      <div className="grid2">
        {!user && <label>Username<input value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())} required pattern="[a-z][a-z0-9._\-]{2,31}" placeholder="e.g. analyst" /></label>}
        <label>Display name<input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={80} /></label>
        {!user && (
          <label className="span2">Temporary password
            <div className="input-row"><input value={password} onChange={(e) => setPassword(e.target.value)} required minLength={10} className="mono" />
              <button type="button" className="btn small" onClick={() => setPassword(generatePassword())}>Generate</button></div>
          </label>
        )}
        <label>Role
          <select value={role} onChange={(e) => setRole(e.target.value as User['role'])} disabled={self}>
            <option value="user">User</option><option value="superuser">Superuser</option>
          </select>
        </label>
      </div>
      <fieldset className="grants" disabled={role === 'superuser'}>
        <legend>Mission access {role === 'superuser' && <span className="muted">(superusers see every mission)</span>}</legend>
        {missions.map((m) => (
          <label key={m.id} className="check"><input type="checkbox" checked={role === 'superuser' || granted.includes(m.id)} onChange={() => toggle(m.id)} />
            <span><b>{m.name}</b> <span className="mono muted">{m.id}</span></span></label>
        ))}
      </fieldset>
      {user && !self && <label className="check"><input type="checkbox" checked={disabled} onChange={(e) => setDisabled(e.target.checked)} /><span>Account disabled (signs the user out at once)</span></label>}
      {user?.locked && <p className="hint">This account is locked after failed sign-ins; saving unlocks it.</p>}
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="row-end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">{user ? 'Save' : 'Create user'}</button></div>
    </form>
  );
}

function ResetPassword({ user, onClose, onDone }: { user: User; onClose: () => void; onDone: (msg: string) => void }) {
  const [password, setPassword] = useState(generatePassword);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try { await api('POST', `/api/admin/users/${user.id}/password`, { password }); onDone(`Password reset for ${user.username}. They must change it at next sign-in.`); }
    catch (err) { setError((err as Error).message); }
  };
  return (
    <form className="dialog-body" onSubmit={submit}>
      <h2>Reset password for {user.username}</h2>
      <p>The user is signed out everywhere and must choose a new password after signing in with this one.</p>
      <label>Temporary password<div className="input-row"><input className="mono" value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} required />
        <button type="button" className="btn small" onClick={() => setPassword(generatePassword())}>Generate</button></div></label>
      {error && <div className="form-error" role="alert">{error}</div>}
      <div className="row-end"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary">Reset password</button></div>
    </form>
  );
}
