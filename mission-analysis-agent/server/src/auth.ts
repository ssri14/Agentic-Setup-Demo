import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

export const SESSION_COOKIE = 'maa_session';
export const LOCK_THRESHOLD = 5;
export const LOCK_WINDOW_MS = 10 * 60_000;
export const LOCK_DURATION_MS = 10 * 60_000;
export const MIN_PASSWORD = 10;

// Argon2id with OWASP-recommended minimum parameters (19 MiB, 2 passes).
export const hashPassword = (password: string) => hash(password, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
export const verifyPassword = async (stored: string, password: string) => {
  try { return await verify(stored, password); } catch { return false; }
};

export const newToken = () => randomBytes(32).toString('base64url');
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

// A fixed hash so a login for an unknown username costs the same time as a real one.
let dummyHash: Promise<string> | undefined;
export const dummyPasswordHash = () => (dummyHash ??= hashPassword('not-a-real-password-' + randomBytes(8).toString('hex')));

export function passwordProblem(password: string, username?: string): string | null {
  if (password.length < MIN_PASSWORD) return `Password must be at least ${MIN_PASSWORD} characters`;
  if (password.length > 200) return 'Password is too long';
  if (username && password.toLowerCase().includes(username.toLowerCase())) return 'Password must not contain the username';
  return null;
}
