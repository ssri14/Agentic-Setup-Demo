import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type Chat, type Mission, type User } from './api';
import type { Theme } from './App';
import ChangePassword from './ChangePassword';
import Conversation from './Conversation';
import Logo from './Logo';
import Modal from './Modal';

const STARTERS = [
  'Which runs show missing source samples, and how is that different from delayed delivery?',
  'Summarise the telemetry interpretation rules and where each is defined.',
  'Investigate the warnings in one run and identify the most likely root cause.',
];

function groupChats(chats: Chat[]) {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const day = 86_400_000, t0 = startOfDay.getTime();
  const groups: [string, Chat[]][] = [['Today', []], ['Yesterday', []], ['Previous 7 days', []], ['Older', []]];
  for (const c of chats) {
    const t = Date.parse(c.updatedAt);
    groups[t >= t0 ? 0 : t >= t0 - day ? 1 : t >= t0 - 7 * day ? 2 : 3][1].push(c);
  }
  return groups.filter(([, list]) => list.length);
}

const initials = (name: string) => name.split(/\s+/).map((p) => p[0]).join('').slice(0, 2).toUpperCase();

interface Props { user: User; theme: Theme; onToggleTheme: () => void; onSignOut: () => void; onPasswordChanged: () => void }

export default function Shell({ user, theme, onToggleTheme, onSignOut, onPasswordChanged }: Props) {
  const { chatId } = useParams();
  const navigate = useNavigate();
  const [missions, setMissions] = useState<Mission[] | null>(null);
  const [mission, setMission] = useState<string>(() => localStorage.getItem('mission') ?? '');
  const [chats, setChats] = useState<Chat[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const [deleting, setDeleting] = useState<Chat | null>(null);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const conversation = useRef<{ send: (text: string) => Promise<void>; busy: boolean } | null>(null);
  const [convBusy, setConvBusy] = useState(false);
  const register = useCallback((send: (text: string) => Promise<void>, busy: boolean) => { conversation.current = { send, busy }; setConvBusy(busy); }, []);

  useEffect(() => {
    api<Mission[]>('GET', '/api/missions').then((list) => {
      setMissions(list);
      setMission((m) => (list.some((x) => x.id === m) ? m : list[0]?.id ?? ''));
    }).catch((e) => setError(e.message));
  }, []);

  const loadChats = useCallback(async () => {
    if (!mission) return setChats([]);
    localStorage.setItem('mission', mission);
    setChats(await api<Chat[]>('GET', `/api/missions/${mission}/chats`));
  }, [mission]);
  useEffect(() => { loadChats().catch((e) => setError(e.message)); }, [loadChats]);

  const current = useMemo(() => chats.find((c) => c.id === chatId) ?? null, [chats, chatId]);
  useEffect(() => { if (!chatId) { conversation.current = null; setConvBusy(false); } }, [chatId]);

  const ask = async (text: string) => {
    const question = text.trim();
    if (!question || sending) return;
    setSending(true); setError('');
    try {
      if (chatId && conversation.current) {
        await conversation.current.send(question);
      } else {
        const chat = await api<Chat>('POST', `/api/missions/${mission}/chats`, {});
        await api('POST', `/api/chats/${chat.id}/messages`, { text: question });
        await loadChats();
        navigate(`/chat/${chat.id}`);
      }
      setDraft('');
    } catch (e) { setError((e as Error).message); } finally { setSending(false); }
  };
  const currentMission = missions?.find((m) => m.id === mission) ?? null;

  const newChat = async () => {
    const chat = await api<Chat>('POST', `/api/missions/${mission}/chats`, {});
    await loadChats();
    navigate(`/chat/${chat.id}`);
  };
  const rename = async () => {
    if (!renaming) return;
    const title = renaming.title.trim();
    if (title) await api('PATCH', `/api/chats/${renaming.id}`, { title });
    setRenaming(null);
    await loadChats();
  };
  const remove = async () => {
    if (!deleting) return;
    await api('DELETE', `/api/chats/${deleting.id}`);
    if (deleting.id === chatId) navigate('/');
    setDeleting(null);
    await loadChats();
  };

  return (
    <div className={collapsed ? 'shell collapsed' : 'shell'} onClick={() => setMenuFor(null)}>
      <aside className="sidebar">
        <div className="side-top">
          <div className="brand"><Logo /><span>Mission Analysis Agent</span></div>
          <button className="icon-btn ghost-dark" title="Collapse sidebar" onClick={() => setCollapsed(true)}>«</button>
        </div>
        <label className="mission-select">
          <span>Mission</span>
          <select value={mission} onChange={(e) => { setMission(e.target.value); navigate('/'); }} disabled={!missions?.length}>
            {missions?.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
        <button className="new-chat" onClick={newChat} disabled={!mission}>＋ New chat</button>
        <nav className="chat-list" aria-label="Past chats">
          {groupChats(chats).map(([label, list]) => (
            <div key={label} className="chat-group">
              <div className="group-label">{label}</div>
              {list.map((c) => (
                <div key={c.id} className={c.id === chatId ? 'chat-item active' : 'chat-item'}>
                  {renaming?.id === c.id ? (
                    <input className="rename" autoFocus value={renaming.title} maxLength={120}
                      onChange={(e) => setRenaming({ id: c.id, title: e.target.value })}
                      onKeyDown={(e) => { if (e.key === 'Enter') rename(); if (e.key === 'Escape') setRenaming(null); }}
                      onBlur={rename} onClick={(e) => e.stopPropagation()} />
                  ) : (
                    <Link to={`/chat/${c.id}`} title={c.title}>{c.title}</Link>
                  )}
                  <button className="dots" aria-label={`Options for ${c.title}`} onClick={(e) => { e.stopPropagation(); setMenuFor(menuFor === c.id ? null : c.id); }}>⋯</button>
                  {menuFor === c.id && (
                    <div className="menu" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => { setRenaming({ id: c.id, title: c.title }); setMenuFor(null); }}>Rename</button>
                      <button className="danger" onClick={() => { setDeleting(c); setMenuFor(null); }}>Delete</button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ))}
          {mission && !chats.length && <div className="side-empty">No chats yet in this mission.</div>}
          {missions && !missions.length && <div className="side-empty">No missions have been granted to you yet. Ask the administrator for access.</div>}
        </nav>
        <div className="side-bottom">
          <div className="me"><span className="avatar">{initials(user.displayName)}</span>
            <div><div className="me-name">{user.displayName}</div><div className="me-role">{user.role === 'superuser' ? 'Superuser' : user.username}</div></div></div>
          <div className="side-actions">
            {user.role === 'superuser' && <Link className="side-link" to="/admin">Administration</Link>}
            <button className="side-link" onClick={() => setPasswordOpen(true)}>Change password</button>
            <button className="side-link" onClick={onToggleTheme}>{theme === 'light' ? 'Dark theme' : 'Light theme'}</button>
            <button className="side-link" onClick={onSignOut}>Sign out</button>
          </div>
        </div>
      </aside>

      <main className="conversation">
        <header className="conv-header">
          {collapsed && <button className="icon-btn" title="Show sidebar" onClick={() => setCollapsed(false)}>»</button>}
          <div className="conv-title">
            <span className="mission-pill">{currentMission?.name ?? 'No mission'}</span>
            <span>{current?.title ?? 'New conversation'}</span>
          </div>
        </header>
        {error && <div className="banner-error">{error}</div>}
        <section className="messages">
          {chatId ? <Conversation key={chatId} chatId={chatId} onActivity={() => { loadChats().catch(() => {}); }} register={register} /> : (
          <div className="empty-state">
            <Logo size={44} />
            <h2>{currentMission ? `What would you like to investigate in ${currentMission.name}?` : 'No mission selected'}</h2>
            {currentMission?.description && <p className="muted">{currentMission.description}</p>}
            <div className="starters">
              {STARTERS.map((s) => <button key={s} className="starter" disabled={!mission || sending} onClick={() => ask(s)}>{s}</button>)}
            </div>
          </div>)}
        </section>
        <footer className="composer-wrap">
          <div className="composer">
            <textarea rows={Math.min(6, Math.max(1, draft.split('\n').length))} value={draft} disabled={!mission || sending || convBusy}
              placeholder={convBusy ? 'The agent is working on your question…' : currentMission ? `Ask about ${currentMission.name}` : 'Choose a mission first'}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(draft); } }} />
            <button className="send" disabled={!draft.trim() || sending || convBusy} aria-label="Send" onClick={() => ask(draft)}>↑</button>
          </div>
          <div className="composer-note">Answers will cite mission documents and telemetry. Every answer can be replayed.</div>
        </footer>
      </main>

      <Modal open={!!deleting} onClose={() => setDeleting(null)}>
        <div className="dialog-body">
          <h2>Delete chat?</h2>
          <p>“{deleting?.title}” and everything recorded for it will be deleted. This cannot be undone.</p>
          <div className="row-end"><button className="btn" onClick={() => setDeleting(null)}>Cancel</button><button className="btn danger" onClick={remove}>Delete</button></div>
        </div>
      </Modal>
      <Modal open={passwordOpen} onClose={() => setPasswordOpen(false)}>
        <ChangePassword user={user} onDone={() => { setPasswordOpen(false); onPasswordChanged(); }} onCancel={() => setPasswordOpen(false)} />
      </Modal>
    </div>
  );
}
