/**
 * Who may use the AI director, and how much: access codes, the hourly limit per visitor, and a
 * daily spend cap in dollars (counted from what each Claude call actually used).
 *
 * Counts live in Upstash Redis when it's configured, so the limits hold across every serverless
 * instance on Vercel. Without it they're kept in this process's memory, which is fine for `npm run
 * dev` but resets whenever a Vercel instance starts (your Anthropic Console spend limit is then the
 * only hard cap).
 *
 * Env:
 *   HUM_ACCESS_CODES        per-person codes: "sam=river-42, jo=blue-moon". Remove one to cut that person off.
 *   HUM_ACCESS_CODE         one shared code (still works, counted as "shared")
 *   HUM_DRAW_CODES          who may make drawings (slow and costly): names from HUM_ACCESS_CODES, "nate, sam".
 *                           Default nobody. Your own machine on your subscription always may.
 *   HUM_RATE_LIMIT          requests per visitor (IP) per hour, default 60 (a video with footage is several), 0 = off
 *   HUM_DAILY_BUDGET        dollars per day for everyone together, default 5, 0 = off
 *   HUM_CODE_DAILY_BUDGET   dollars per day per code, default 1, 0 = off
 *   HUM_TIMEZONE            when the day resets, an IANA zone like America/Los_Angeles (default UTC)
 *   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN   (or KV_REST_API_URL / KV_REST_API_TOKEN, as
 *                           Vercel's Upstash integration names them)
 */
import type { DirectorEnv } from './director';

/* ───────────────────────── counters ───────────────────────── */

export interface CounterStore {
  readonly kind: 'redis' | 'memory';
  /** add `by` to `key` (creating it with a lifetime of `ttlSec`) and return the new total */
  incr(key: string, by: number, ttlSec: number): Promise<number>;
  get(key: string): Promise<number>;
}

const mem = new Map<string, { v: number; until: number }>();

export const memoryStore: CounterStore = {
  kind: 'memory',
  async incr(key, by, ttlSec) {
    const now = Date.now();
    const cur = mem.get(key);
    const live = cur && cur.until > now ? cur : { v: 0, until: now + ttlSec * 1000 };
    live.v += by;
    mem.set(key, live);
    if (mem.size > 5000) for (const [k, e] of mem) if (e.until <= now) mem.delete(k);
    return live.v;
  },
  async get(key) {
    const cur = mem.get(key);
    return cur && cur.until > Date.now() ? cur.v : 0;
  },
};

/** Upstash Redis over its REST API (plain fetch, no SDK) */
export function upstashStore(url: string, token: string): CounterStore {
  const base = url.replace(/\/+$/, '');
  async function pipeline(cmds: (string | number)[][]): Promise<unknown[]> {
    const res = await fetch(`${base}/pipeline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(cmds),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`upstash ${res.status}`);
    const out = (await res.json()) as { result?: unknown; error?: string }[];
    const bad = out.find((r) => r.error);
    if (bad) throw new Error(`upstash: ${bad.error}`);
    return out.map((r) => r.result);
  }
  return {
    kind: 'redis',
    async incr(key, by, ttlSec) {
      // the window is in the key's name (hour or day), so refreshing the lifetime only tidies up
      const [total] = await pipeline([
        ['INCRBY', key, Math.round(by)],
        ['EXPIRE', key, ttlSec],
      ]);
      return Number(total) || 0;
    },
    async get(key) {
      const [v] = await pipeline([['GET', key]]);
      return Number(v) || 0;
    },
  };
}

let cached: { sig: string; store: CounterStore } | null = null;

export function storeFor(env: DirectorEnv): CounterStore {
  const url = (env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL || '').trim();
  const token = (env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN || '').trim();
  if (!url || !token) return memoryStore;
  const sig = `${url}|${token.length}`;
  if (cached?.sig !== sig) cached = { sig, store: upstashStore(url, token) };
  return cached.store;
}

/** run against the store; if Redis can't be reached, count in memory instead of failing the request */
async function safely<T>(store: CounterStore, fn: (s: CounterStore) => Promise<T>): Promise<T> {
  try {
    return await fn(store);
  } catch (err) {
    if (store === memoryStore) throw err;
    console.warn(`[hum-director] counter store unreachable, counting in memory: ${err instanceof Error ? err.message : String(err)}`);
    return fn(memoryStore);
  }
}

/* ───────────────────────── access codes ───────────────────────── */

export interface AccessCode {
  /** who it belongs to; used in counters and logs, never the code itself */
  name: string;
  code: string;
}

/** HUM_ACCESS_CODES ("sam=river-42, jo=blue-moon") plus HUM_ACCESS_CODE (named "shared") */
export function accessCodes(env: DirectorEnv): AccessCode[] {
  const out: AccessCode[] = [];
  (env.HUM_ACCESS_CODES ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((entry, i) => {
      const eq = entry.indexOf('=');
      const name = eq > 0 ? entry.slice(0, eq).trim() : `code${i + 1}`;
      const code = (eq > 0 ? entry.slice(eq + 1) : entry).trim();
      if (code) out.push({ name: name.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32) || `code${i + 1}`, code });
    });
  const shared = env.HUM_ACCESS_CODE?.trim();
  if (shared) out.push({ name: 'shared', code: shared });
  return out;
}

/** constant-time-ish string compare */
function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/**
 * Which code the request sent. `null`: codes are required and this one is wrong or missing.
 * `'open'`: no codes are configured, anyone may use it.
 */
export function matchCode(env: DirectorEnv, sent: unknown): string | null {
  const codes = accessCodes(env);
  if (!codes.length) return 'open';
  const s = typeof sent === 'string' ? sent.trim() : '';
  let hit: string | null = null;
  // check every code (no early exit) so timing doesn't hint at how many there are
  for (const c of codes) if (safeEqual(s, c.code) && hit === null) hit = c.name;
  return s ? hit : null;
}

/**
 * May this caller make drawings? `who` is a matched code's name. Never for an open site (no codes) and
 * never unless its name is listed; the local backend (your own subscription) always may.
 */
export function canDraw(env: DirectorEnv, who: string | null, local: boolean): boolean {
  if (local) return true;
  if (!who || who === 'open') return false;
  return (env.HUM_DRAW_CODES ?? '')
    .split(/[,\n]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(who);
}

/* ───────────────────────── prices ───────────────────────── */

/** dollars per million tokens: input, output, cache read. Cache writes (5 min) are 1.25× input. */
const PRICES: [RegExp, number, number, number][] = [
  [/^claude-haiku-5-5/, 0.1, 0.5, 0.01],
  [/^claude-sonnet-5-5/, 2, 10, 0.1],
  [/^claude-sonnet-5/, 2, 10, 0.2],
  [/^claude-opus-5-5/, 4, 20, 0.2],
  [/^claude-opus-5/, 5, 25, 0.5],
  [/^claude-fable-5-2/, 8, 40, 0.2],
];
/** anything not listed is priced high on purpose, so an unknown model can't slip past the cap */
const UNKNOWN_PRICE: [number, number, number] = [10, 50, 1];

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/** what one call cost, in dollars */
export function costOf(model: string, u: Usage | undefined): number {
  if (!u) return 0;
  const row = PRICES.find(([re]) => re.test(model));
  const [inP, outP, readP] = row ? [row[1], row[2], row[3]] : UNKNOWN_PRICE;
  const n = (v: number | undefined) => (Number.isFinite(v) ? Number(v) : 0);
  return (n(u.input_tokens) * inP + n(u.cache_creation_input_tokens) * inP * 1.25 + n(u.cache_read_input_tokens) * readP + n(u.output_tokens) * outP) / 1e6;
}

/* ───────────────────────── limits ───────────────────────── */

const HOUR = 3600;
const DAY = 86_400;
/** spend is counted in millionths of a dollar so Redis can add whole numbers */
const MICRO = 1e6;

function num(v: string | undefined, fallback: number): number {
  const t = v?.trim();
  if (t === undefined || t === '') return fallback;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function today(env: DirectorEnv, now: Date): string {
  const tz = env.HUM_TIMEZONE?.trim() || 'UTC';
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export type Gate = { ok: true } | { ok: false; status: number; json: { error: string; note: string; retryAfter?: number } };

/**
 * Before a Claude call: the hourly limit for this visitor, then today's budget (everyone, and this
 * code). Counts the request against the hourly limit when it passes.
 */
export async function checkLimits(env: DirectorEnv, who: { ip: string; code: string }, now = new Date()): Promise<Gate> {
  const store = storeFor(env);
  const day = today(env, now);
  const total = num(env.HUM_DAILY_BUDGET, 5);
  const perCode = who.code === 'open' ? 0 : num(env.HUM_CODE_DAILY_BUDGET, 1);

  // budgets first, so a request that's turned away doesn't use up an hourly slot
  const [spentAll, spentCode] = await safely(store, (s) =>
    Promise.all([total > 0 ? s.get(`hum:spend:${day}`) : 0, perCode > 0 ? s.get(`hum:spend:${day}:${who.code}`) : 0]),
  );
  if (total > 0 && spentAll / MICRO >= total) {
    return { ok: false, status: 429, json: { error: 'budget', note: 'Today’s AI budget is used up. The offline director still works; Claude is back tomorrow.' } };
  }
  if (perCode > 0 && spentCode / MICRO >= perCode) {
    return { ok: false, status: 429, json: { error: 'budget_code', note: 'You’ve used today’s AI allowance for this code. The offline director still works; more tomorrow.' } };
  }

  const limit = Math.floor(num(env.HUM_RATE_LIMIT, 60));
  if (limit > 0) {
    const bucket = Math.floor(now.getTime() / 1000 / HOUR);
    const count = await safely(store, (s) => s.incr(`hum:rl:${who.ip || 'unknown'}:${bucket}`, 1, HOUR + 60));
    if (count > limit) {
      const retryAfter = Math.max(1, (bucket + 1) * HOUR - Math.floor(now.getTime() / 1000));
      return { ok: false, status: 429, json: { error: 'rate_limited', retryAfter, note: `Hourly AI limit reached. Try again in about ${Math.ceil(retryAfter / 60)} min.` } };
    }
  }
  return { ok: true };
}

/** after a Claude call: add what it cost to today's totals. Returns today's total in dollars. */
export async function recordSpend(env: DirectorEnv, code: string, dollars: number, now = new Date()): Promise<number> {
  if (!(dollars > 0)) return 0;
  const store = storeFor(env);
  const day = today(env, now);
  const micro = Math.ceil(dollars * MICRO);
  const [all] = await safely(store, (s) =>
    Promise.all([s.incr(`hum:spend:${day}`, micro, DAY * 2), code !== 'open' ? s.incr(`hum:spend:${day}:${code}`, micro, DAY * 2) : Promise.resolve(0)]),
  );
  return all / MICRO;
}
