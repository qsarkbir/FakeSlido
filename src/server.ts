import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { ApiError, PollSession, requireValue, tokenPattern } from './session.js';
import type {
  AdminState, ErrorResponse, PresentState, PublicResults, PublicState, ResultsExport, Role, VoteReceipt
} from './types.js';

const headers = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY'
};
const documents = ['/', '/admin', '/present'];
const assets = {
  '/styles.css': 'text/css; charset=utf-8',
  '/common.js': 'text/javascript; charset=utf-8',
  '/admin.js': 'text/javascript; charset=utf-8',
  '/participate.js': 'text/javascript; charset=utf-8',
  '/present.js': 'text/javascript; charset=utf-8',
  '/charts.js': 'text/javascript; charset=utf-8',
  '/vendor/qrcode.js': 'text/javascript; charset=utf-8',
  '/mark.svg': 'image/svg+xml'
};
const digest = (value: string) => createHash('sha256').update(value).digest();

type JsonResponse = AdminState | ErrorResponse | PresentState | PublicResults | PublicState | VoteReceipt;

function putJson(response: ServerResponse, status: number, value: JsonResponse) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

// JSON.parse が成功しても、期待した形式とは限らない。呼び出し元に unknown を返して検証を促す。
async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ApiError(415, 'JSON形式のリクエストが必要です。');
  }
  if (Number(request.headers['content-length']) > limit) {
    throw new ApiError(413, '送信データが大きすぎます。');
  }
  const raw = await new Promise<Buffer>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: Error) => {
      clearTimeout(timer);
      request.off('data', receive);
      request.off('end', onEnd);
      request.off('close', onClose);
      request.off('error', finish);
      if (error) {
        request.pause();
        reject(error);
      } else {
        resolve(Buffer.concat(chunks, size));
      }
    };
    const receive = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) finish(new ApiError(413, '送信データが大きすぎます。'));
      else chunks.push(chunk);
    };
    const onEnd = () => finish();
    const onClose = () => finish(new ApiError(400, 'リクエストが中断されました。'));
    const timer = setTimeout(() => finish(new ApiError(408, '送信がタイムアウトしました。')), 8000);
    request.on('data', receive);
    request.once('end', onEnd);
    request.once('close', onClose);
    request.once('error', finish);
  });
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    throw new ApiError(400, 'JSONの内容を確認してください。');
  }
}

function csvText(value: string) {
  const text = String(value);
  const safe = /^[\t\r\n]|^\s*[=+\-@＝＋－＠]/u.test(text) ? "'" + text : text;
  return '"' + safe.replaceAll('"', '""') + '"';
}

function csvExport(data: ResultsExport) {
  const rows = ['sessionId,questionId,questionOrder,questionText,questionType,optionIndex,optionText,optionVotes,respondentCount,totalSelections,percentage'];
  for (const q of data.questions) {
    for (const option of q.options) {
      rows.push([
        csvText(data.sessionId), csvText(q.questionId), q.questionOrder, csvText(q.questionText),
        q.questionType, option.optionIndex, csvText(option.optionText), option.optionVotes,
        q.respondentCount, q.totalSelections, option.percentage.toFixed(1)
      ].join(','));
    }
  }
  return '\ufeff' + rows.join('\r\n') + '\r\n';
}

// タプルのユニオンで、操作ごとに許すメソッドと認証ロールの組を定義する。
type Route =
  | [method: 'GET', role: Role, operation: 'state']
  | [method: 'GET', role: 'public', operation: 'results']
  | [method: 'POST', role: 'public', operation: 'vote']
  | [method: 'PUT', role: 'admin', operation: 'deck']
  | [method: 'POST', role: 'admin', operation: 'control']
  | [method: 'GET', role: 'admin', operation: 'export'];
const routes = new Map<string, Route>([
  ['/api/public/state', ['GET', 'public', 'state']],
  ['/api/public/results', ['GET', 'public', 'results']],
  ['/api/public/vote', ['POST', 'public', 'vote']],
  ['/api/present/state', ['GET', 'present', 'state']],
  ['/api/admin/state', ['GET', 'admin', 'state']],
  ['/api/admin/deck', ['PUT', 'admin', 'deck']],
  ['/api/admin/control', ['POST', 'admin', 'control']],
  ['/api/admin/export', ['GET', 'admin', 'export']]
]);

function checkParameters(url: URL, ...allowed: string[]) {
  const names = [...url.searchParams.keys()];
  requireValue(new Set(names).size === names.length && names.every(name => allowed.includes(name)));
}

interface AppOptions {
  adminKey?: string;
  baseUrl?: string;
  transport?: string;
  idleMs?: number;
  voteLimit?: number;
  waitMs?: number;
}

export function createApp({ adminKey, baseUrl, transport = 'local', idleMs = 43_200_000,
  voteLimit = 600, waitMs = 20_000 }: AppOptions = {}) {
  if (typeof adminKey !== 'string' || !tokenPattern.test(adminKey)
    || Buffer.from(adminKey, 'base64url').toString('base64url') !== adminKey) {
    throw new Error('ADMIN_KEY は32バイトの乱数をBase64URLで符号化してください。');
  }
  const adminHash = digest(adminKey);
  adminKey = undefined;
  if (!['local', 'cloudflare', 'https-proxy'].includes(transport)) throw new Error('TRANSPORT が不正です。');
  const configuredUrl = baseUrl ? new URL(baseUrl) : null;
  if (configuredUrl && (configuredUrl.pathname !== '/' || configuredUrl.username || configuredUrl.password
    || configuredUrl.search || configuredUrl.hash)) {
    throw new Error('BASE_URL にはURLのオリジンを指定してください。');
  }
  if (transport === 'local' && configuredUrl && (configuredUrl.protocol !== 'http:'
    || !['localhost', '127.0.0.1', '[::1]'].includes(configuredUrl.hostname))) {
    throw new Error('ローカルモードではループバックのHTTP URLを指定してください。');
  }
  if (transport !== 'local' && configuredUrl?.protocol !== 'https:') {
    throw new Error('HTTPS公開時は BASE_URL に https:// から始まるオリジンが必要です。');
  }

  const staticFiles = new Map(Object.entries(assets).map(([path, contentType]) => [
    path, { contentType, body: readFileSync(new URL('./public' + path, import.meta.url)) }
  ]));
  for (const path of documents) {
    const filename = path === '/' ? '/index' : path;
    staticFiles.set(path, {
      contentType: 'text/html; charset=utf-8',
      body: readFileSync(new URL('./public' + filename + '.html', import.meta.url))
    });
  }
  const session = new PollSession({ idleMs, voteLimit });

  function authorize(role: Role, request: IncomingMessage) {
    const match = /^Bearer ([A-Za-z0-9_-]{22,43})$/.exec(request.headers.authorization ?? '');
    if (!match) throw new ApiError(401, 'この画面のアクセス用URLを開いてください。');
    const token = match[1];
    if (role === 'admin' && timingSafeEqual(adminHash, digest(token))) return;
    if (role !== 'admin') {
      const expected = role === 'public' ? session.participantCode : session.presentationToken;
      if (timingSafeEqual(digest(expected), digest(token))) return;
      const validLength = role === 'public' ? 22 : 43;
      if (token.length === validLength) {
        throw new ApiError(410, 'このセッションは終了しました。新しい参加・発表URLを開いてください。');
      }
    }
    throw new ApiError(401, 'この画面のアクセス用URLを開いてください。');
  }

  const server = createServer({
    maxHeaderSize: 8192, headersTimeout: 10_000, requestTimeout: 15_000,
    connectionsCheckingInterval: 2000, keepAliveTimeout: 5000
  }, async (request, response) => {
    for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
    response.setHeader('Cache-Control', 'no-store');
    try {
      const address = server.address();
      const origin = configuredUrl?.origin ?? (address && typeof address !== 'string'
        ? 'http://127.0.0.1:' + address.port : undefined);
      if (origin === undefined) throw new Error('待受ポートを取得できません。');
      if (request.headers.host !== new URL(origin).host) throw new ApiError(421, 'アクセスURLを確認してください。');
      if (transport !== 'local') response.setHeader('Strict-Transport-Security', 'max-age=31536000');
      const target = request.url ?? '';
      const url = new URL(target, origin);
      if (url.origin !== origin || !target.startsWith('/')) throw new ApiError(400, 'URLが不正です。');
      const asset = staticFiles.get(url.pathname);
      if (asset && (request.method === 'GET' || request.method === 'HEAD')) {
        response.setHeader('Cache-Control', documents.includes(url.pathname) ? 'no-store' : 'no-cache');
        response.writeHead(200, { 'Content-Type': asset.contentType, 'Content-Length': asset.body.length });
        response.end(request.method === 'HEAD' ? undefined : asset.body);
        return;
      }
      const route = routes.get(url.pathname);
      if (!route) throw new ApiError(404, 'ページが見つかりません。');
      const [method, role, operation] = route;
      if (request.method !== method) {
        response.setHeader('Allow', method);
        throw new ApiError(405, 'このメソッドは利用できません。');
      }
      authorize(role, request);
      switch (operation) {
        case 'state': {
          checkParameters(url, 'revision');
          const revision = url.searchParams.get('revision');
          requireValue(revision === null || /^\d{1,16}$/.test(revision) && Number.isSafeInteger(Number(revision)));
          if (revision !== null && Number(revision) === session.revision[role]) {
            if (role !== 'public') await session.wait(role, response, waitMs);
            if (response.destroyed) return;
            authorize(role, request);
            if (Number(revision) === session.revision[role]) {
              response.writeHead(204).end();
              return;
            }
          }
          putJson(response, 200, session.state(role));
          break;
        }
        case 'results':
          checkParameters(url, 'questionId');
          putJson(response, 200, session.results(url.searchParams.get('questionId')));
          break;
        case 'export': {
          checkParameters(url, 'format', 'sessionId');
          const format = url.searchParams.get('format');
          requireValue(format === 'csv' || format === 'json');
          const requestedSession = url.searchParams.get('sessionId');
          if (requestedSession !== null) session.requireSession(requestedSession);
          const data = session.exportResults();
          response.writeHead(200, {
            'Content-Type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
            'Content-Disposition': 'attachment; filename="fakeslido-results.' + format + '"'
          });
          response.end(format === 'csv' ? csvExport(data) : JSON.stringify(data, null, 2));
          break;
        }
        default: {
          checkParameters(url);
          if ((role === 'admin' || request.headers.origin !== undefined) && request.headers.origin !== origin) {
            throw new ApiError(403, '送信元のオリジンが一致しません。');
          }
          const sessionId = session.sessionId;
          const input = await readJson(request, operation === 'deck' ? 256 * 1024 : 16 * 1024);
          authorize(role, request);
          session.requireSession(sessionId);
          if (operation === 'vote') {
            let ip = request.socket.remoteAddress ?? 'unknown';
            if (transport === 'cloudflare') {
              const forwardedIp = request.headers['cf-connecting-ip'];
              if (!['127.0.0.1', '::1'].includes(ip) || typeof forwardedIp !== 'string' || !isIP(forwardedIp)) {
                throw new ApiError(403, 'トンネルからの接続を確認できません。');
              }
              ip = forwardedIp;
            }
            const voteRevision = session.vote(input, ip);
            putJson(response, 200, { sessionId: session.sessionId, voteRevision });
          } else {
            if (operation === 'deck') session.saveDeck(input);
            else session.control(input);
            putJson(response, 200, session.state('admin'));
          }
        }
      }
    } catch (error) {
      if (response.destroyed) return;
      const safe = error instanceof ApiError;
      if (safe && error.status === 429) response.setHeader('Retry-After', '3');
      if (!request.complete) response.setHeader('Connection', 'close');
      putJson(response, safe ? error.status : 500, {
        error: safe ? error.message : 'サーバーで処理できませんでした。',
        ...(safe && error.code && { code: error.code })
      });
    }
  });
  server.maxConnections = 600;
  server.on('close', () => session.dispose());
  return server;
}

function positiveInteger(value: string | undefined, fallback: number, max: number) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max) throw new Error('数値設定を確認してください。');
  return number;
}

function start() {
  const port = positiveInteger(process.env.PORT, 3000, 65535);
  const idleMinutes = positiveInteger(process.env.IDLE_MINUTES, 720, 35_791);
  const voteLimit = positiveInteger(process.env.VOTES_PER_MINUTE, 600, 100_000);
  const { BASE_URL: baseUrl, TRANSPORT: transport } = process.env;
  const keyWasConfigured = process.env.ADMIN_KEY !== undefined;
  let adminKey: string | undefined = process.env.ADMIN_KEY ?? randomBytes(32).toString('base64url');
  delete process.env.ADMIN_KEY;
  const server = createApp({ adminKey, baseUrl, transport, idleMs: idleMinutes * 60_000, voteLimit });
  server.listen(port, '127.0.0.1', () => {
    const origin = baseUrl ? new URL(baseUrl).origin : 'http://127.0.0.1:' + port;
    console.log('FakeSlido 起動中');
    console.log('運営画面 ' + origin + '/admin' + (keyWasConfigured ? '' : '#' + adminKey));
    adminKey = undefined;
  });
  server.on('error', () => {
    console.error('待受を開始できません。ポート設定を確認してください。');
    process.exitCode = 1;
    adminKey = undefined;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    start();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
