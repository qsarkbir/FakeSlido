import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { createApp } from '../dist/server.js';

const newKey = () => randomBytes(32).toString('base64url');
const first = { questionId: 'one', text: '好きな色は？', type: 'single', options: ['青', '緑'], style: 'horizontal' };
const second = { questionId: 'two', text: '好きな果物は？', type: 'multiple', options: ['梨', 'りんご', 'ぶどう'], style: 'vertical' };
const servers = new Set();

after(async () => {
  await Promise.all([...servers].map(server => new Promise(resolve => {
    server.close(resolve);
    server.closeAllConnections();
  })));
});

async function fixture(options = {}) {
  const key = newKey();
  const server = createApp({ adminKey: key, waitMs: 100, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.add(server);
  const origin = 'http://127.0.0.1:' + server.address().port;
  async function call(path, { token = key, method = 'GET', data, headers = {} } = {}) {
    const response = await new Promise((resolve, reject) => {
      const outgoing = request(origin + path, {
        method, headers: {
          ...(token && { Authorization: 'Bearer ' + token }),
          ...(data !== undefined && { 'Content-Type': 'application/json', Origin: origin }),
          ...headers
        }
      }, resolve);
      outgoing.on('error', reject);
      outgoing.end(data === undefined ? undefined : JSON.stringify(data));
    });
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    const responseHeaders = new Headers(response.headers);
    return { status: response.statusCode, headers: responseHeaders, raw,
      body: responseHeaders.get('content-type')?.includes('application/json') ? JSON.parse(raw) : null };
  }
  const state = async () => (await call('/api/admin/state')).body;
  const deck = async (questions, config = {}) => call('/api/admin/deck', {
    method: 'PUT', data: { questions, deckRevision: (await state()).deckRevision, ...config }
  });
  const control = (action, questionId, confirm) => call('/api/admin/control', {
    method: 'POST', data: { action, questionId, confirm }
  });
  const erase = (sessionId, token = key) => call('/api/admin/control', {
    token, method: 'POST', data: { action: 'erase', confirm: true, sessionId }
  });
  const vote = (token, questionId, choices, voteRevision, voterToken = newKey()) => call('/api/public/vote', {
    token, method: 'POST', data: { questionId, voterToken, choices, voteRevision }
  });
  return { origin, key, state, deck, control, erase, call, vote };
}

test('公開状態、受付状態、発表モードが独立し、未オープンの質問を返さない', async () => {
  const { call, deck, control, vote } = await fixture();
  const { body: created } = await deck([first, second]);
  const { participantCode: token, presentationToken } = created;
  const publicState = () => call('/api/public/state', { token });
  const result = () => call('/api/public/results?questionId=one', { token });
  const present = path => call('/api/present/state' + (path ?? ''), { token: presentationToken });
  assert.deepEqual((await publicState()).body.questions, []);
  assert.equal((await control('publish', 'one')).status, 400);
  await control('select', 'one');
  assert.equal((await present()).body.question, null);
  await control('open', 'one');
  const opened = (await publicState()).body;
  assert.deepEqual(opened.questions.map(q => q.questionId), ['one']);
  assert.equal((await call('/api/public/state?revision=' + opened.revision, { token })).status, 204);
  assert.equal((await result()).status, 404);

  const voter = newKey();
  const revision = opened.questions[0].voteRevision;
  assert.equal((await vote(token, 'one', [1], revision, voter)).status, 400);
  assert.equal((await vote(token, 'one', 1, revision, voter)).status, 200);
  assert.equal((await vote(token, 'one', 2, revision, voter)).status, 200);
  assert.deepEqual((await publicState()).body, opened);
  assert.equal((await present()).body.question.respondentCount, 1);
  assert.equal(Object.hasOwn((await present()).body.question, 'results'), false);

  const starting = await present();
  const pending = present('?revision=' + starting.body.revision);
  await control('show-results');
  assert.equal((await pending).body.mode, 'results');
  assert.equal((await result()).body.options[1].optionVotes, 1);
  assert.equal((await vote(token, 'one', 1, revision, voter)).status, 200);
  assert.equal((await result()).body.options[0].optionVotes, 1);

  await control('close', 'one');
  assert.equal((await vote(token, 'one', 2, revision, voter)).status, 409);
  await control('show-question');
  assert.equal((await result()).status, 200);
  assert.equal(Object.hasOwn((await present()).body.question, 'results'), false);
  await control('show-results');
  await control('unpublish', 'one');
  assert.equal((await present()).body.mode, 'question');
  assert.equal((await result()).status, 404);
});

test('受付開始で発表画面が、受付を開始した質問の表示に切り替わる', async () => {
  const { call, deck, control } = await fixture();
  const { body: { presentationToken: token } } = await deck([first, second]);
  const present = revision => call('/api/present/state' + (revision === undefined ? '' : '?revision=' + revision), { token });
  const { body: waiting } = await present();
  assert.equal(waiting.question, null);

  const pending = present(waiting.revision);
  await control('open', first.questionId);
  const { body: opened } = await pending;
  assert.equal(opened.question.questionId, first.questionId);
  assert.equal(opened.question.isOpen, true);
  assert.equal(opened.mode, 'question');
  assert.equal(opened.question.resultsPublished, false);

  await control('show-results');
  const switching = await control('open', second.questionId);
  assert.ok(switching.body.questions.every(question => question.isOpen));
  assert.equal(switching.body.questions[0].resultsPublished, true);
  const { body: switched } = await present();
  assert.equal(switched.question.questionId, second.questionId);
  assert.equal(switched.mode, 'question');
  assert.equal(switched.question.resultsPublished, false);
  assert.equal(Object.hasOwn(switched.question, 'results'), false);
});

test('複数選択を集計し、CSVとJSONに集計値だけを書き出す', async () => {
  const { call, deck, control, vote } = await fixture();
  const { body: created } = await deck([{ ...first, text: '=SUM(1,2)' }, {
    ...second, options: ['梨', '  +りんご', 'ぶどう"']
  }]);
  const { participantCode: token } = created;
  await control('open', 'two');
  const revision = created.questions[1].voteRevision;
  const voter = newKey();
  assert.equal((await vote(token, 'two', [1, 1], revision)).status, 400);
  assert.equal((await vote(token, 'two', [1, 4], revision)).status, 400);
  assert.equal((await vote(token, 'two', [], revision)).status, 400);
  assert.equal((await vote(token, 'two', [2, 1], revision, voter)).status, 200);
  assert.equal((await vote(token, 'two', [1, 2], revision, voter)).status, 200);
  assert.equal((await vote(token, 'two', [1, 3], revision)).status, 200);

  const { body: data, raw } = await call('/api/admin/export?format=json');
  assert.equal(data.format, 'fakeslido-results');
  assert.equal(data.sessionId, created.sessionId);
  assert.equal(data.questions[0].respondentCount, 0);
  assert.equal(data.questions[0].options[0].percentage, 0);
  assert.equal(data.questions[0].questionText, '=SUM(1,2)');
  assert.equal(data.questions[1].totalSelections, 4);
  assert.equal(data.questions[1].respondentCount, 2);
  assert.deepEqual(data.questions[1].options.map(o => o.percentage), [100, 50, 50]);
  assert.doesNotMatch(raw.toString(), /127\.0\.0\.1|voterToken|pseudonym|voteTime/);
  assert.ok(!raw.toString().includes(voter));

  const csv = await call('/api/admin/export?format=csv');
  assert.equal(csv.raw.subarray(0, 3).toString('hex'), 'efbbbf');
  assert.match(csv.raw.toString(), /"'=SUM\(1,2\)"/);
  assert.match(csv.raw.toString(), /"'  \+りんご"/);
  assert.match(csv.raw.toString(), /"ぶどう""",1,2,4,50\.0/);
});

test('編集、並べ替え、復元、リセットで票世代を正しく扱う', async () => {
  const { call, deck, state, control, vote } = await fixture();
  const { body: before } = await deck([first, second]);
  const gen = before.questions[0].voteRevision;
  const revised = { ...first, text: '新しい質問' };
  await control('open', 'one');
  await control('open', 'two');
  await vote(before.participantCode, 'one', 1, gen);
  const reordered = await deck([second, { ...first, style: 'donut' }]);
  assert.equal(reordered.body.questions[1].voteRevision, gen);
  assert.equal(reordered.body.questions[1].results.respondentCount, 1);
  assert.equal((await deck([first], { deckRevision: before.deckRevision })).body.code, 'deck_changed');
  assert.equal((await deck([second, revised])).body.code, 'confirm_reset');
  assert.equal((await state()).questions[1].text, first.text);
  const afterEdit = await deck([second, revised], { confirmReset: true });
  assert.ok(afterEdit.body.questions[1].voteRevision > gen);
  assert.equal(afterEdit.body.questions[1].results.respondentCount, 0);
  assert.equal((await vote(before.participantCode, 'one', 2, gen)).status, 409);
  assert.equal((await control('reset-votes', 'one')).status, 400);
  const reset = await control('reset-votes', 'one', true);
  assert.ok(reset.body.questions[1].voteRevision > afterEdit.body.questions[1].voteRevision);
  assert.equal(reset.body.questions[0].voteRevision, afterEdit.body.questions[0].voteRevision);
  const restored = await deck([revised, second], { replace: true });
  assert.ok(restored.body.questions.every(q => !q.everOpened && !q.isOpen && !q.resultsPublished));
  assert.deepEqual((await call('/api/public/state', { token: before.participantCode })).body.questions, []);
});

test('全消去で旧参加・発表キーを失効し、待機中の発表画面にも反映する', async () => {
  const { call, deck, control, erase } = await fixture();
  const { body: before } = await deck([first]);
  const token = before.presentationToken;
  const current = await call('/api/present/state', { token });
  const waiting = call('/api/present/state?revision=' + current.body.revision, { token });
  assert.equal((await control('erase')).status, 400);
  assert.equal((await erase()).status, 400);
  assert.equal((await erase(1)).status, 400);
  assert.equal((await erase(before.sessionId, before.participantCode)).status, 401);
  const { status, body: after } = await erase(before.sessionId);
  assert.equal(status, 200);
  assert.notEqual(after.sessionId, before.sessionId);
  assert.notEqual(after.participantCode, before.participantCode);
  assert.deepEqual(after.questions, []);
  assert.equal((await waiting).status, 410);
  assert.equal((await call('/api/public/state', { token: before.participantCode })).status, 410);
  assert.equal((await call('/api/admin/state')).status, 200);
});

test('以前のセッションの確認では現在のセッションを消去できない', async () => {
  const { call, control, deck, erase, state, vote } = await fixture();
  const before = await state();
  const attempts = await Promise.all([erase(before.sessionId), erase(before.sessionId)]);
  assert.deepEqual(attempts.map(result => result.status).sort(), [200, 409]);
  const { body: current } = await deck([second]);
  await control('open', 'two');
  assert.equal((await vote(current.participantCode, 'two', [1, 2], current.questions[0].voteRevision)).status, 200);

  const exportPath = '/api/admin/export?format=json&sessionId=';
  assert.equal((await call(exportPath + before.sessionId)).status, 409);
  assert.equal((await erase(before.sessionId)).status, 409);
  const exported = await call(exportPath + current.sessionId);
  assert.equal(exported.status, 200);
  assert.equal(exported.body.sessionId, current.sessionId);
  assert.equal(exported.body.questions[0].respondentCount, 1);
  assert.equal(exported.body.questions[0].totalSelections, 2);
  assert.equal((await state()).sessionId, current.sessionId);
});

test('状態取得や投票では期限が延びず、期限到来で票と参加・発表キーを消去する', async () => {
  const { call, control, deck, state, vote } = await fixture({ idleMs: 350 });
  await deck([first]);
  await control('open', 'one');
  const before = await state();
  await sleep(85);
  assert.equal((await vote(before.participantCode, 'one', 1, before.questions[0].voteRevision)).status, 200);
  assert.equal((await call('/api/admin/preflight')).status, 200);
  const afterVote = await state();
  assert.equal(afterVote.sessionId, before.sessionId);
  assert.equal(afterVote.expiresAt, before.expiresAt);
  assert.ok(afterVote.serverTime > before.serverTime);
  assert.equal(afterVote.questions[0].results.respondentCount, 1);
  await sleep(Math.max(0, before.expiresAt - Date.now()) + 30);
  const after = await state();
  assert.notEqual(after.sessionId, before.sessionId);
  assert.ok(after.expiresAt > before.expiresAt);
  assert.deepEqual(after.questions, []);
  assert.equal((await call('/api/public/state', { token: before.participantCode })).status, 410);
  assert.equal((await call('/api/present/state', { token: before.presentationToken })).status, 410);
});

test('管理キーと現在のセッションでのみ期限を延長し、運営画面に通知する', async () => {
  const idleMs = 60_000;
  const { call, deck, erase, state } = await fixture({ idleMs, waitMs: 1000 });
  const { body: before } = await deck([first]);
  const publicState = () => call('/api/public/state', { token: before.participantCode });
  const presentState = () => call('/api/present/state', { token: before.presentationToken });
  const publicBefore = (await publicState()).body;
  const presentBefore = (await presentState()).body;
  for (const data of [publicBefore, presentBefore]) {
    assert.equal(Object.hasOwn(data, 'expiresAt'), false);
    assert.equal(Object.hasOwn(data, 'serverTime'), false);
  }
  const extend = (sessionId, token) => call('/api/admin/control', {
    token, method: 'POST', data: { action: 'extend-expiry', sessionId }
  });
  assert.equal((await extend(before.sessionId, before.participantCode)).status, 401);
  assert.equal((await extend()).status, 400);
  const waiting = call('/api/admin/state?revision=' + before.revision);
  await sleep(15);
  const { status, body: extended } = await extend(before.sessionId);
  assert.equal(status, 200);
  assert.equal(extended.sessionId, before.sessionId);
  assert.ok(extended.expiresAt > before.expiresAt);
  assert.ok(extended.expiresAt > extended.serverTime && extended.expiresAt - extended.serverTime <= idleMs);
  assert.deepEqual(extended.questions, before.questions);
  const notified = await waiting;
  assert.equal(notified.status, 200);
  assert.equal(notified.body.expiresAt, extended.expiresAt);
  assert.deepEqual((await publicState()).body, publicBefore);
  assert.deepEqual((await presentState()).body, presentBefore);

  const { body: fresh } = await erase(before.sessionId);
  assert.equal((await extend(before.sessionId)).status, 409);
  assert.equal((await state()).expiresAt, fresh.expiresAt);
});

test('集計の書き出しで更新した期限を運営画面に通知する', async () => {
  const { call, state } = await fixture({ waitMs: 1000 });
  const before = await state();
  const waiting = call('/api/admin/state?revision=' + before.revision);
  await sleep(15);
  assert.equal((await call('/api/admin/export?format=json')).status, 200);
  const result = await waiting;
  assert.equal(result.status, 200);
  assert.ok(result.body.expiresAt > before.expiresAt);
  assert.equal(result.body.sessionId, before.sessionId);
});

test('本番前チェックは運営認証で現在の接続情報を取得する', async () => {
  const { origin, call, state } = await fixture();
  const before = await state();
  const path = '/api/admin/preflight';
  for (const token of [null, before.participantCode, before.presentationToken]) {
    assert.equal((await call(path, { token })).status, 401);
  }
  const result = await call(path);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.deepEqual(result.body, {
    origin, transport: 'local', sessionId: before.sessionId,
    participantCode: before.participantCode, presentationToken: before.presentationToken
  });
  assert.equal((await call(path + '?test=true')).status, 400);
  assert.equal((await call(path, { method: 'POST' })).status, 405);
  assert.equal((await call('/api/present/state', { token: result.body.presentationToken })).body.sessionId,
    before.sessionId);
  const after = await state();
  assert.deepEqual(after, { ...before, serverTime: after.serverTime });
});

test('新しいプロセス相当のサーバーには旧セッションの票と鍵を渡さない', async () => {
  const before = await fixture();
  const { body: created } = await before.deck([first]);
  await before.control('open', 'one');
  await before.vote(created.participantCode, 'one', 1, created.questions[0].voteRevision);
  const after = await fixture();
  assert.notEqual((await after.state()).sessionId, created.sessionId);
  assert.deepEqual((await after.state()).questions, []);
  assert.equal((await after.call('/api/admin/state', { token: before.key })).status, 401);
  assert.equal((await after.call('/api/public/state', { token: created.participantCode })).status, 410);
});

test('権限、オリジン、型、本文サイズとレートを制限する', async () => {
  const { call, deck, control, vote } = await fixture({ voteLimit: 2 });
  assert.equal((await deck([{ ...first, options: [''] }])).status, 400);
  assert.equal((await deck([{ ...second, style: 'donut' }])).status, 400);
  const { body: before } = await deck([first]);
  const token = before.participantCode;
  assert.equal((await call('/api/admin/state', { token })).status, 401);
  assert.equal((await call('/api/admin/export?format=json', { token })).status, 401);
  const data = { action: 'open', questionId: 'one' };
  assert.equal((await call('/api/admin/control', { method: 'POST', data, headers: { Origin: 'https://example.test' } })).status, 403);
  assert.equal((await call('/api/admin/control', { method: 'POST', data, headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await call('/api/public/vote', {
    token, method: 'POST', data: 'a'.repeat(16 * 1024)
  })).status, 413);
  assert.equal((await call('/api/admin/deck', {
    method: 'PUT', data: 'a'.repeat(256 * 1024)
  })).status, 413);

  await control('open', 'one');
  const revision = before.questions[0].voteRevision;
  const firstVote = await vote(token, 'one', 1, revision);
  assert.equal(firstVote.status, 200);
  assert.equal(firstVote.headers.get('cache-control'), 'no-store');
  assert.equal(firstVote.headers.get('set-cookie'), null);
  assert.equal((await vote(token, 'one', 1, revision)).status, 200);
  const limited = await vote(token, 'one', 1, revision);
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.has('retry-after'));
});

test('JSON の型が違う入力を拒否し、質問集と票を変更しない', async () => {
  const { call, control, deck, state, vote } = await fixture();
  const before = await state();
  for (const data of [null, [], true, { questions: [{ ...first, options: ['青', 2] }], deckRevision: before.deckRevision }]) {
    assert.equal((await call('/api/admin/deck', { method: 'PUT', data })).status, 400);
  }
  assert.equal((await call('/api/admin/control', { method: 'POST', data: { action: 'erase', confirm: 'true' } })).status, 400);
  const after = await state();
  assert.deepEqual(after, { ...before, serverTime: after.serverTime });

  const { body: created } = await deck([first]);
  const token = created.participantCode;
  const revision = created.questions[0].voteRevision;
  await control('open', 'one');
  assert.equal((await vote(token, 'one', 1, String(revision))).status, 400);
  assert.equal((await vote(token, 'one', '1', revision)).status, 400);
  assert.equal((await vote(token, 'one', 1, revision, {})).status, 400);
  assert.equal((await state()).questions[0].results.respondentCount, 0);
  const accepted = await vote(token, 'one', 1, revision);
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.body, { sessionId: created.sessionId, voteRevision: revision });
});

test('静的ファイルを固定リストから提供し、QRコードの版とハッシュを固定する', async () => {
  const { call } = await fixture();
  for (const [path, entry] of [['/', 'participate'], ['/admin', 'admin'], ['/present', 'present']]) {
    const page = await call(path);
    assert.equal(page.status, 200, path);
    assert.ok(page.raw.toString().includes(`type="module" src="/${entry}.js"`), path);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'.*frame-ancestors 'none'/);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  }
  const javascript = ['/participate.js', '/admin.js', '/present.js', '/common.js', '/charts.js', '/preflight.js', '/qr.js'];
  const assets = [
    ...javascript.map(path => [path, 'text/javascript; charset=utf-8']),
    ['/styles.css', 'text/css; charset=utf-8'],
    ['/mark.svg', 'image/svg+xml']
  ];
  for (const [path, contentType] of assets) {
    const asset = await call(path);
    assert.equal(asset.status, 200, path);
    assert.equal(asset.headers.get('content-type'), contentType, path);
    assert.ok(asset.raw.length > 0, path);
  }
  assert.equal((await call('/server.js')).status, 404);
  assert.equal((await call('/vendor/..%2F..%2Fserver.js')).status, 404);
  const source = await readFile(new URL('../public/vendor/qrcode.js', import.meta.url));
  const qr = await call('/vendor/qrcode.js');
  assert.equal(qr.status, 200);
  assert.deepEqual(qr.raw, source);
  assert.equal(createHash('sha256').update(qr.raw).digest('hex'),
    '79ec86f82856005b1c887905cfccfcfbec3821ca61c7fd5a952faa5f778f791c');
});

test('HTTPS公開モードでは公開オリジンと短期の接続元別制限を使う', async () => {
  const baseUrl = 'https://poll.example.test';
  const { call, key } = await fixture({ baseUrl, transport: 'cloudflare', voteLimit: 1 });
  const forwarded = { Host: 'poll.example.test', Origin: baseUrl };
  const admin = await call('/api/admin/state', { headers: forwarded });
  assert.equal(admin.status, 200);
  assert.equal(admin.headers.get('strict-transport-security'), 'max-age=31536000');
  assert.equal((await call('/api/admin/state', { token: key })).status, 421);
  const preflight = await call('/api/admin/preflight', { headers: forwarded });
  assert.equal(preflight.status, 200);
  assert.equal(preflight.body.origin, baseUrl);
  assert.equal(preflight.body.transport, 'cloudflare');
  assert.equal((await call('/api/admin/preflight')).status, 421);

  const deck = await call('/api/admin/deck', {
    method: 'PUT', headers: forwarded, data: { questions: [first], deckRevision: admin.body.deckRevision }
  });
  assert.equal(deck.status, 200);
  const open = await call('/api/admin/control', {
    method: 'POST', headers: forwarded, data: { action: 'open', questionId: 'one' }
  });
  assert.equal(open.status, 200);
  const { participantCode: token, questions } = open.body;
  const send = ip => call('/api/public/vote', {
    token, method: 'POST', headers: { ...forwarded, ...(ip && { 'CF-Connecting-IP': ip }) },
    data: { questionId: 'one', choices: 1, voterToken: newKey(), voteRevision: questions[0].voteRevision }
  });
  assert.equal((await send()).status, 403);
  assert.equal((await send('192.0.2.1')).status, 200);
  assert.equal((await send('192.0.2.1')).status, 429);
  assert.equal((await send('192.0.2.2')).status, 200);
});
