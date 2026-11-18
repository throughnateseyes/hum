/**
 * Dev-only Vite plugin: mounts POST /api/director on the dev server using handleDirector.
 * Env comes from loadEnv (so .env, .env.local, .env.[mode].local work) merged over process.env.
 *
 *   // vite.config.ts
 *   import { directorDevPlugin } from './server/vitePlugin';
 *   plugins: [react(), directorDevPlugin()]
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnv, type Plugin } from 'vite';
import { cliBackend } from './cliDirector';
import { handleDirector, type DirectorEnv, type LocalBackend } from './director';

const MAX_BODY_BYTES = 64_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('too_large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, json: unknown) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(json));
}

export function directorDevPlugin(options: { path?: string } = {}): Plugin {
  const route = options.path ?? '/api/director';
  let env: DirectorEnv = process.env;
  let local: LocalBackend | null = null;
  return {
    name: 'hum-director-dev',
    apply: 'serve',
    configResolved(config) {
      // '' prefix → load every variable, not just VITE_*; values stay server-side.
      env = { ...process.env, ...loadEnv(config.mode, config.envDir || config.root, '') };
      // no API key? use the local `claude` CLI, i.e. your Claude subscription (dev only)
      local = env.HUM_DIRECTOR?.trim().toLowerCase() === 'api' ? null : cliBackend(env);
      const key = !!env.ANTHROPIC_API_KEY?.trim();
      const mode = local && (!key || env.HUM_DIRECTOR?.trim().toLowerCase() === 'cli') ? 'your Claude subscription (claude CLI)' : key ? 'the Anthropic API key' : 'offline only (no key, no claude CLI)';
      config.logger.info(`  hum director → ${mode}`);
    },
    configureServer(server) {
      // dev-only: save a look thumbnail captured in the browser (see src/dev/thumbs.ts)
      server.middlewares.use('/__hum/thumb', (req, res) => {
        const id = new URL(req.url ?? '', 'http://x').searchParams.get('id') ?? '';
        if (req.method !== 'POST' || !/^[a-z0-9-]{1,48}$/.test(id)) {
          send(res, 400, { error: 'bad_request' });
          return;
        }
        void readBody(req)
          .then((dataUrl) => {
            const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
            if (!m) throw new Error('not a jpeg data url');
            const dir = join(server.config.root, 'src/assets/thumbs');
            mkdirSync(dir, { recursive: true });
            writeFileSync(join(dir, `${id}.jpg`), Buffer.from(m[1], 'base64'));
            send(res, 200, { ok: true });
          })
          .catch((e) => send(res, 400, { error: String(e) }));
      });
      server.middlewares.use(route, (req, res) => {
        if (req.method !== 'POST') {
          res.setHeader('allow', 'POST');
          send(res, 405, { error: 'method_not_allowed', note: 'POST only.' });
          return;
        }
        void (async () => {
          let body: unknown;
          try {
            const text = await readBody(req);
            body = text ? JSON.parse(text) : {};
          } catch (err) {
            const tooLarge = err instanceof Error && err.message === 'too_large';
            send(res, tooLarge ? 413 : 400, { error: tooLarge ? 'too_large' : 'bad_json', note: tooLarge ? 'Request too large.' : 'Invalid JSON.' });
            return;
          }
          try {
            const ip = req.socket.remoteAddress ?? 'local';
            // your Claude subscription only answers this computer, even if the dev server is
            // opened to the network with --host; other devices need the API key
            const fromThisComputer = /^(::1|127\.|::ffff:127\.)/.test(ip);
            const result = await handleDirector(body, ip, env, { local: fromThisComputer ? local : null });
            send(res, result.status, result.json);
          } catch (err) {
            server.config.logger.error(`[hum-director] ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
            send(res, 500, { error: 'internal', note: 'Director crashed — see the dev server log.' });
          }
        })();
      });
    },
  };
}

export default directorDevPlugin;
