/**
 * Local director backend: runs the director through the `claude` CLI (Claude Code) on this machine,
 * so it uses whatever account `claude` is signed in to (e.g. your Pro / Max subscription) instead of
 * an API key. Dev server only. It is imported by server/vitePlugin.ts, never by the Vercel function:
 * a subscription is for your own use, not for serving visitors.
 *
 * Env:
 *   HUM_CLAUDE_BIN    path to the claude binary (default: found on PATH or in the usual install dirs)
 *   HUM_CLI_MODEL     model alias or id for the CLI (default 'sonnet')
 *   HUM_CLI_EDIT_MODEL  model for small edits to a plan or a look (default 'haiku'; 'main' = HUM_CLI_MODEL)
 *   HUM_CLI_BEST_MODEL  model for drawing (default 'opus')
 *   HUM_TIMEOUT_MS    per-request timeout (default 180000)
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DirectorEnv, LocalBackend, LocalRequest, LocalResult } from './director';

export function findClaudeBin(env: DirectorEnv): string | null {
  if (env.HUM_CLAUDE_BIN?.trim()) return env.HUM_CLAUDE_BIN.trim();
  const dirs = (env.PATH ?? '').split(':').filter(Boolean);
  // a dev server started from an app may have a thin PATH, so also try the usual install spots
  dirs.push(join(homedir(), '.local/bin'), join(homedir(), '.claude/local'), '/opt/homebrew/bin', '/usr/local/bin');
  for (const d of dirs) {
    const p = join(d, 'claude');
    if (existsSync(p)) return p;
  }
  return null;
}

interface CliJson {
  is_error?: boolean;
  subtype?: string;
  result?: string;
  structured_output?: unknown;
  api_error_status?: number | null;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
    output_tokens_details?: { thinking_tokens?: number };
  };
}

/** what one call used, for the dev server's log. One answer is two turns (the answer, and the CLI taking it); more means it didn't fit its form and was written again */
function usageLine(mode: string, model: string, effort: string, d: CliJson): string {
  const u = d.usage ?? {};
  const n = (v: number | undefined) => String(v ?? 0);
  const again = (d.num_turns ?? 2) - 2;
  return `[hum-director] ${mode} on ${model} (${effort}): in ${n(u.input_tokens)} new, ${n(u.cache_creation_input_tokens)} written to cache, ${n(u.cache_read_input_tokens)} from cache; out ${n(u.output_tokens)} (${n(u.output_tokens_details?.thinking_tokens)} thinking)${again > 0 ? `; written ${again + 1} times` : ''}`;
}

export function cliBackend(env: DirectorEnv): LocalBackend | null {
  const bin = findClaudeBin(env);
  if (!bin) return null;
  const mainModel = env.HUM_CLI_MODEL?.trim() || 'sonnet';
  // small edits ("make the chorus calmer") run on the small model, like the API path (server/models.ts)
  const editModel = env.HUM_CLI_EDIT_MODEL?.trim() || 'haiku';
  const bestModel = env.HUM_CLI_BEST_MODEL?.trim() || 'opus';
  const timeoutMs = Number(env.HUM_TIMEOUT_MS) || 180_000;

  return (req: LocalRequest) =>
    new Promise<LocalResult>((resolve) => {
      const model = req.tier === 'best' ? bestModel : req.tier === 'small' ? (editModel === 'main' ? mainModel : editModel) : mainModel;
      const pictures = req.images ?? [];
      const args = [
        '-p',
        // pictures can only go in as streamed messages; plain text goes in as it always has
        ...(pictures.length ? ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'] : ['--output-format', 'json']),
        '--model', model,
        '--effort', req.effort,
        '--system-prompt', req.system,
        '--json-schema', JSON.stringify(req.schema),
        // a pure text-in / JSON-out call: no tools, MCP servers, slash commands or saved session,
        // and --safe-mode keeps your personal CLAUDE.md, plugins and hooks out of the prompt
        '--safe-mode',
        '--tools', '',
        '--strict-mcp-config',
        '--disable-slash-commands',
        '--no-session-persistence',
      ];
      const childEnv: NodeJS.ProcessEnv = { ...process.env };
      // without an API key in its env, claude uses its own sign-in (your subscription)
      delete childEnv.ANTHROPIC_API_KEY;
      delete childEnv.ANTHROPIC_BASE_URL;
      delete childEnv.CLAUDECODE;

      // run outside the project so no CLAUDE.md or project settings leak into the prompt
      const child = spawn(bin, args, { cwd: tmpdir(), env: childEnv, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      let done = false;
      const finish = (r: LocalResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        req.signal?.removeEventListener('abort', stop);
        resolve(r);
      };
      const stop = () => {
        child.kill('SIGTERM');
        finish({ ok: false, status: 499, error: 'cancelled', note: 'Cancelled.' });
      };
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        finish({ ok: false, status: 504, error: 'timeout', note: 'Claude took too long to answer.' });
      }, timeoutMs);
      if (req.signal?.aborted) stop();
      else req.signal?.addEventListener('abort', stop);

      child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
      child.on('error', (e) => finish({ ok: false, status: 502, error: 'cli_missing', note: `Couldn’t run claude (${e.message}).` }));
      child.on('close', (code) => {
        let data: CliJson | null = null;
        try {
          data = JSON.parse(out.trim().split('\n').pop() ?? '') as CliJson;
        } catch {
          data = null;
        }
        if (data?.usage && !done) console.info(usageLine(req.mode, model, req.effort, data));
        const text = `${data?.result ?? ''} ${err}`.toLowerCase();
        if (!data || data.is_error || data.subtype !== 'success') {
          if (/log ?in|logged out|not authenticated|invalid api key|oauth/.test(text)) {
            finish({ ok: false, status: 502, error: 'cli_auth', note: 'The claude CLI isn’t signed in — run `claude` in Terminal once and sign in.' });
          } else if (/usage limit|rate limit|429/.test(text)) {
            finish({ ok: false, status: 429, error: 'upstream_rate_limited', note: 'You’ve hit your Claude plan’s usage limit for now.' });
          } else {
            const why = (data?.result ?? err).trim().slice(0, 200) || `exit code ${code}`;
            finish({ ok: false, status: 502, error: 'cli_error', note: `claude CLI error: ${why}` });
          }
          return;
        }
        finish({ ok: true, output: data.structured_output });
      });

      // a child that dies early must not take the dev server down with it
      child.stdin.on('error', () => {});
      child.stdin.end(
        pictures.length
          ? `${JSON.stringify({ type: 'user', message: { role: 'user', content: [...pictures.map((s) => ({ type: 'image', source: { type: 'base64', ...s } })), { type: 'text', text: req.prompt }] } })}\n`
          : req.prompt,
      );
    });
}
