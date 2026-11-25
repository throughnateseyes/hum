/**
 * Access to the AI director on a hosted Hum.
 *
 * The server is the real check (server/director.ts + server/limits.ts). This side only makes its
 * answers friendly: when an AI action comes back with `access_code` (or is about to run without a
 * code on a site that needs one), the AccessGate modal asks for a code, checks it with the server's
 * free `check` mode, saves it and lets the waiting action try again. When the site has AI switched off
 * (`no_key`), the same modal explains how to run Hum yourself.
 */
import { create } from 'zustand';

const KEY = 'hum.accessCode';
const ENDPOINT = '/api/director';

export function readAccessCode(): string {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveAccessCode(code: string) {
  try {
    if (code) localStorage.setItem(KEY, code);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: the code lives for this page only */
  }
  memoryCode = code;
  useAccessGate.setState({ saved: !!code, canDraw: false });
  void learnCan();
}

/**
 * Ask the server what the code in use may do (drawings). Only for showing or hiding the control: the
 * server checks again on every request.
 */
export async function learnCan(): Promise<void> {
  await checkCode(currentCode()).catch(() => 'unknown');
}

export const forgetAccessCode = () => saveAccessCode('');

/** fallback when localStorage throws (private windows) */
let memoryCode = '';
export const currentCode = () => readAccessCode() || memoryCode;

/* ───────────────────────── what we know about the server ───────────────────────── */

/**
 * Where Nate takes requests for a code. Empty until he gives his handle: with no link, the access
 * section just says "Ask Nate for one." so nothing points at the wrong account.
 */
export const NATE_TWITTER_URL = '';

/** 'code': it wants a code. 'off': no AI on this site. 'open': no code needed. 'unknown': not asked yet. */
export type ServerNeed = 'unknown' | 'open' | 'code' | 'off';
let need: ServerNeed = 'unknown';

/** every change goes through here so the welcome screen and the Make a video button see it at once */
function setNeed(n: ServerNeed) {
  need = n;
  if (useAccessGate.getState().need !== n) useAccessGate.setState({ need: n });
}

let learning: Promise<void> | null = null;
/**
 * Ask the server once whether it wants a code (the free `check` mode, no Claude call), so the start
 * screen can ask for a code up front and Make a video can show its lock before anyone presses it.
 */
export function learnNeed(): Promise<void> {
  if (need !== 'unknown') return Promise.resolve();
  learning ??= checkCode('').then(
    (r) => {
      learning = null;
      if (need !== 'unknown') return; // a real request answered first
      if (r === 'ok') setNeed('open');
      else if (r === 'wrong') setNeed('code');
      else if (r === 'off') setNeed('off');
    },
    () => {
      learning = null;
    },
  );
  return learning;
}

/**
 * Could an AI request go ahead without asking the person anything? False when the site has AI off, or
 * wants a code and none is saved. Background requests (one-tap start) check this and stay offline.
 */
export const aiAllowedQuietly = () => need !== 'off' && !(need === 'code' && !currentCode());

let answered = false;
/** Claude has answered here this visit, or the site wants no code: the next request won't be refused for want of one */
export const aiAnswers = () => answered || need === 'open';

export type CheckResult = 'ok' | 'wrong' | 'off' | 'unknown';

/** Ask the server whether `code` works, without calling Claude. 'unknown' = couldn't tell. */
export async function checkCode(code: string, signal?: AbortSignal): Promise<CheckResult> {
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'check', accessCode: code || undefined }),
      signal,
    });
    const json = (await res.json().catch(() => null)) as { error?: string; can?: { draw?: boolean } } | null;
    if (res.ok) {
      // a late answer about another code must not unlock anything
      if (code === currentCode() || !currentCode()) useAccessGate.setState({ canDraw: json?.can?.draw === true });
      return 'ok';
    }
    if (res.status === 403 && json?.error === 'access_code') return 'wrong';
    if (res.status === 501 && json?.error === 'no_key') return 'off';
    return 'unknown';
  } catch (err) {
    if (signal?.aborted) throw err;
    return 'unknown';
  }
}

/* ───────────────────────── the modal's state ───────────────────────── */

export type GateMode = 'code' | 'off';
export type GateOutcome = 'unlocked' | 'dismissed';

interface GateState {
  open: boolean;
  mode: GateMode;
  /** shown inline under the field */
  error: string;
  /** whether a code is saved (for the Inspector) */
  saved: boolean;
  /** an AI action is waiting on this (false when opened just to change the code) */
  pending: boolean;
  /** what the code in use may do beyond directing a video */
  canDraw: boolean;
  /** what the server wants (see ServerNeed); 'unknown' until learnNeed or a real request finds out */
  need: ServerNeed;
}

export const useAccessGate = create<GateState>(() => ({ open: false, mode: 'code', error: '', saved: !!readAccessCode(), pending: false, canDraw: false, need: 'unknown' }));

let waiting: ((r: GateOutcome) => void)[] = [];

function settle(r: GateOutcome) {
  const w = waiting;
  waiting = [];
  useAccessGate.setState({ open: false, error: '' });
  w.forEach((fn) => fn(r));
}

/** Open the modal; resolves once the person unlocks (code mode) or closes it. */
export function askForAccess(mode: GateMode, error = '', signal?: AbortSignal, pending = true): Promise<GateOutcome> {
  useAccessGate.setState((s) => ({ open: true, mode, error, pending: pending || (s.open && s.pending) }));
  return new Promise((resolve) => {
    waiting.push(resolve);
    signal?.addEventListener('abort', () => settle('dismissed'), { once: true });
  });
}

/** Open the modal just to set or change the code (no action waiting). */
export const openAccessGate = () => void askForAccess('code', '', undefined, false);

/** the modal's close (×, Esc, outside click, "Continue without AI") */
export const dismissGate = () => settle('dismissed');

/** the modal's Unlock: check the code, then save it and let waiting actions retry */
export async function submitCode(raw: string): Promise<boolean> {
  const code = raw.trim();
  if (!code) {
    useAccessGate.setState({ error: 'Type the code you were given.' });
    return false;
  }
  const r = await checkCode(code);
  if (r === 'wrong') {
    useAccessGate.setState({ error: 'That code didn’t work. Check it and try again.' });
    return false;
  }
  if (r === 'off') {
    setNeed('off');
    useAccessGate.setState({ mode: 'off', error: '' });
    return false;
  }
  // 'ok', or a server too old to check codes: save it and let the real request decide. The server
  // still wants a code (need stays as it is): what changed is that we now have one.
  saveAccessCode(code);
  settle('unlocked');
  return true;
}

/* ───────────────────────── the AI call path ───────────────────────── */

async function errorOf(res: Response): Promise<string> {
  try {
    const json = (await res.clone().json()) as { error?: unknown };
    return typeof json?.error === 'string' ? json.error : '';
  } catch {
    return '';
  }
}

/**
 * POST to the director with the saved code, through the gate. Returns the server's response for the
 * caller to read as before; when the person closes the gate, that's the 403 / 501 response, so the
 * caller's offline fallback runs. `buildBody` gets the code to send each time it's (re)tried.
 */
export async function postDirector(
  buildBody: (accessCode: string | undefined) => unknown,
  opts: { endpoint?: string; signal?: AbortSignal; accessCode?: string; quiet?: boolean } = {},
): Promise<Response> {
  const endpoint = opts.endpoint ?? ENDPOINT;
  let code = opts.accessCode || currentCode();
  /** the gate opens at most once per press: closing it means "go on without AI" */
  let asked = false;
  let entered = false;
  const ask = async (mode: GateMode, error = '') => {
    asked = true;
    // a request nobody pressed a button for (one-tap start) never opens the gate: it stays offline
    if (opts.quiet) return 'dismissed' as GateOutcome;
    const r = await askForAccess(mode, error, opts.signal);
    if (r === 'unlocked') {
      code = currentCode();
      entered = true;
      asked = false; // a fresh code may still be wrong (old server that can't check): allow one more ask
    }
    return r;
  };
  for (;;) {
    // about to run without a code on a site that needs one: ask first
    if (!code && need === 'unknown' && endpoint === ENDPOINT) {
      const r = await checkCode('', opts.signal);
      setNeed(r === 'ok' ? 'open' : r === 'wrong' ? 'code' : r === 'off' ? 'off' : 'unknown');
    }
    if (!code && need === 'code' && !asked && (await ask('code')) === 'unlocked') continue;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildBody(code || undefined)),
      signal: opts.signal,
    });
    if (res.ok) {
      if (!code) setNeed('open');
      answered = true;
      return res;
    }
    const err = res.status === 403 || res.status === 501 ? await errorOf(res) : '';
    if (res.status === 403 && err === 'access_code') {
      setNeed('code');
      if (asked) return res;
      const msg = !code ? '' : entered ? 'That code didn’t work. Check it and try again.' : 'Your saved code didn’t work any more. Try it again, or ask for a new one.';
      if ((await ask('code', msg)) === 'unlocked') continue;
      return res;
    }
    if (res.status === 501 && err === 'no_key') {
      setNeed('off');
      if (!asked) await ask('off');
      return res;
    }
    return res;
  }
}
