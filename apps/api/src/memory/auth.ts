/**
 * Accounts and sessions.
 *
 * Deliberately self-contained: password hashing with scrypt and HMAC-signed
 * tokens, both from node:crypto. No new native dependency, no email provider to
 * sign up for, nothing that stops working when a free tier changes its terms.
 *
 * The security point that actually matters here is not the hashing — it is that
 * `userId` now comes from a signed token instead of a query parameter. Before
 * this, `?userId=someone-else` was enough to read another person's
 * conversations. Auth is the difference between separating users and merely
 * labelling them.
 */
import { createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';
import { optionalEnv } from '../config/env.js';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: string,
  keylen: number,
) => Promise<Buffer>;

const KEY_LENGTH = 64;
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export interface User {
  id: string;
  email: string;
  displayName: string;
  isGuest: boolean;
}

let pool: pg.Pool | undefined;
let ready: Promise<void> | undefined;

function getPool(): pg.Pool {
  const url = optionalEnv('DATABASE_URL');
  if (!url) throw new Error('DATABASE_URL is required for accounts.');
  pool ??= new pg.Pool({ connectionString: url, max: 4 });
  return pool;
}

function init(): Promise<void> {
  ready ??= getPool()
    .query(
      `CREATE TABLE IF NOT EXISTS users (
         id            TEXT PRIMARY KEY,
         email         TEXT UNIQUE NOT NULL,
         display_name  TEXT NOT NULL,
         password_hash TEXT NOT NULL,
         password_salt TEXT NOT NULL,
         is_guest      BOOLEAN NOT NULL DEFAULT false,
         created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    )
    .then(() => undefined);
  return ready;
}

/* ------------------------------------------------------------- passwords */

async function hashPassword(password: string, salt: string): Promise<string> {
  return (await scryptAsync(password, salt, KEY_LENGTH)).toString('hex');
}

/**
 * Constant-time comparison.
 *
 * A plain `===` on a hash leaks timing information, and length mismatches make
 * timingSafeEqual throw, so both are handled explicitly.
 */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/* ---------------------------------------------------------------- tokens */

function secret(): string {
  const value = optionalEnv('AUTH_SECRET');
  if (!value) {
    throw new Error(
      'AUTH_SECRET is not set. Generate one with `openssl rand -hex 32` and add it to .env.',
    );
  }
  return value;
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Issues a signed token.
 *
 * A compact JWT-shaped string rather than a real JWT library: there is one
 * algorithm, one issuer and one audience, so a dependency would add supply
 * chain surface without adding safety. The signature covers the payload, and
 * the payload carries its own expiry.
 */
export function issueToken(userId: string): string {
  const payload = base64url(
    JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS }),
  );
  const signature = base64url(createHmac('sha256', secret()).update(payload).digest());
  return `${payload}.${signature}`;
}

/** Returns the user id, or undefined for anything malformed, forged or expired. */
export function verifyToken(token: string | undefined): string | undefined {
  if (!token) return undefined;

  const [payload, signature] = token.split('.');
  if (!payload || !signature) return undefined;

  const expected = base64url(createHmac('sha256', secret()).update(payload).digest());
  // Compare as raw bytes and in constant time; a forged signature must not be
  // distinguishable from a valid one by how long the check takes.
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return undefined;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString()) as {
      sub?: string;
      exp?: number;
    };
    if (!decoded.sub || !decoded.exp || decoded.exp < Math.floor(Date.now() / 1000)) {
      return undefined;
    }
    return decoded.sub;
  } catch {
    return undefined;
  }
}

/* ----------------------------------------------------------------- users */

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  password_salt: string;
  is_guest: boolean;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    isGuest: row.is_guest,
  };
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export async function register(
  email: string,
  password: string,
  displayName?: string,
): Promise<{ user: User; token: string }> {
  await init();

  const normalised = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalised)) {
    throw new AuthError('That does not look like an email address.', 400);
  }
  if (password.length < 8) {
    throw new AuthError('Use at least 8 characters for your password.', 400);
  }

  const salt = randomBytes(16).toString('hex');
  const hash = await hashPassword(password, salt);
  const id = randomUUID();

  try {
    const result = await getPool().query<UserRow>(
      `INSERT INTO users (id, email, display_name, password_hash, password_salt)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [id, normalised, displayName?.trim() || normalised.split('@')[0], hash, salt],
    );
    const row = result.rows[0]!;
    return { user: toUser(row), token: issueToken(row.id) };
  } catch (error) {
    // 23505 is unique_violation. Telling the user the address is taken does leak
    // that it exists; for a demo the clearer message is worth more than the
    // enumeration risk, and that is a deliberate trade rather than an oversight.
    if ((error as { code?: string }).code === '23505') {
      throw new AuthError('An account with that email already exists.', 409);
    }
    throw error;
  }
}

export async function login(
  email: string,
  password: string,
): Promise<{ user: User; token: string }> {
  await init();

  const result = await getPool().query<UserRow>('SELECT * FROM users WHERE email = $1', [
    email.trim().toLowerCase(),
  ]);
  const row = result.rows[0];

  // Same message and roughly the same work whether the account is missing or
  // the password is wrong, so the response does not reveal which.
  const failure = new AuthError('Wrong email or password.', 401);
  if (!row) {
    await hashPassword(password, 'decoy-salt-for-constant-work');
    throw failure;
  }

  const candidate = await hashPassword(password, row.password_salt);
  if (!safeEqual(candidate, row.password_hash)) throw failure;

  return { user: toUser(row), token: issueToken(row.id) };
}

/**
 * Creates a throwaway account.
 *
 * The demo has to work for someone who will not sign up — that is an explicit
 * acceptance requirement — but a guest still needs a real row so their
 * conversations and preferences are scoped exactly like anyone else's.
 */
export async function createGuest(): Promise<{ user: User; token: string }> {
  await init();

  const id = randomUUID();
  const result = await getPool().query<UserRow>(
    `INSERT INTO users (id, email, display_name, password_hash, password_salt, is_guest)
     VALUES ($1,$2,$3,'','',true) RETURNING *`,
    [id, `guest-${id.slice(0, 8)}@local`, `Guest ${id.slice(0, 4)}`],
  );
  const row = result.rows[0]!;
  return { user: toUser(row), token: issueToken(row.id) };
}

export async function getUser(id: string): Promise<User | undefined> {
  await init();
  const result = await getPool().query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
  const row = result.rows[0];
  return row ? toUser(row) : undefined;
}

export async function closeAuthStore(): Promise<void> {
  await pool?.end().catch(() => undefined);
  pool = undefined;
  ready = undefined;
}
