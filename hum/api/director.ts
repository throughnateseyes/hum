/**
 * Vercel Node function: POST /api/director → Claude (via handleDirector).
 * Set ANTHROPIC_API_KEY (and optionally HUM_MODEL, HUM_RATE_LIMIT, HUM_ACCESS_CODE,
 * HUM_ALLOWED_ORIGIN) in the Vercel project's environment variables.
 */
import { handleDirector } from '../server/director';

const MAX_BODY_BYTES = 64_000;

function corsHeaders(request: Request): Record<string, string> {
  const allowed = process.env.HUM_ALLOWED_ORIGIN?.trim();
  if (!allowed) return {};
  const origin = request.headers.get('origin') ?? '';
  const list = allowed.split(',').map((s) => s.trim());
  if (!list.includes('*') && !list.includes(origin)) return {};
  return {
    'access-control-allow-origin': list.includes('*') ? '*' : origin,
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'origin',
  };
}

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

function clientIp(request: Request): string {
  const fwd = request.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  return request.headers.get('x-real-ip')?.trim() || 'unknown';
}

export async function POST(request: Request): Promise<Response> {
  const cors = corsHeaders(request);
  const len = Number(request.headers.get('content-length') ?? 0);
  if (len > MAX_BODY_BYTES) return json(413, { error: 'too_large', note: 'Request too large.' }, cors);
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json(413, { error: 'too_large', note: 'Request too large.' }, cors);
    body = text ? JSON.parse(text) : {};
  } catch {
    return json(400, { error: 'bad_json', note: 'Invalid JSON.' }, cors);
  }
  try {
    const result = await handleDirector(body, clientIp(request));
    return json(result.status, result.json, cors);
  } catch (err) {
    console.error('[hum-director]', err);
    return json(500, { error: 'internal', note: 'Director crashed.' }, cors);
  }
}

export function OPTIONS(request: Request): Response {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}
