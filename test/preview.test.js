import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { get } from 'node:http';

function preview(extra = {}) {
  const key = randomBytes(32).toString('base64url');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/preview.js', import.meta.url))], {
    env: { ...process.env, BASE_URL: '', TRANSPORT: '', PREVIEW_PORT: '0', ADMIN_KEY: key, ...extra },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  return { key, child, closed: once(child, 'close'), output: () => output };
}

test('ローカル試用はコメントを有効にし、既存の公開設定を使わず、設定済み管理キーを出力しない', async () => {
  const { key, child, closed, output } = preview({ TRANSPORT: 'local' });
  try {
    let origin;
    for (let i = 0; i < 100; i++) {
      origin = output().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
      if (origin || child.exitCode !== null) break;
      await sleep(20);
    }
    assert.ok(origin, '試用サーバーが起動すること');
    assert.equal(output().includes(key), false);
    const headers = { Authorization: 'Bearer ' + key };
    const response = await fetch(origin + '/api/admin/state', { headers });
    assert.equal(response.status, 200);
    const state = await response.json();
    assert.deepEqual(state.discussions, []);
    const deck = JSON.parse(await readFile(new URL('../docs/examples/discussion-acceptance-deck.json', import.meta.url), 'utf8'));
    const saved = await fetch(origin + '/api/admin/deck', { method: 'PUT',
      headers: { ...headers, Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ deckRevision: state.deckRevision, questions: deck.questions }) });
    assert.equal(saved.status, 200);
    const loaded = await saved.json();
    assert.equal(loaded.questions.length, 2);
    assert.equal(loaded.discussions.length, 2);
    const status = await (await fetch(origin + '/api/admin/preflight', { headers })).json();
    assert.equal(status.transport, 'local');
    assert.equal(status.origin, origin);
    // fetch は Host を上書きするため、低水準 HTTP で実際に異なる Host を送る。
    const statusCode = await new Promise((resolve, reject) => {
      get(origin + '/api/admin/state', { headers: { ...headers, Host: 'public.example' } }, response => {
        response.resume();
        resolve(response.statusCode);
      }).on('error', reject);
    });
    assert.equal(statusCode, 421);
  } finally {
    child.kill();
    await closed;
  }
});

test('試用は公開設定、不正なポート、管理キーを拒否する', async () => {
  for (const env of [{ BASE_URL: 'https://public.example' }, { TRANSPORT: 'cloudflare' },
    { TRANSPORT: 'https-proxy' }, { PREVIEW_PORT: '-1' }, { PREVIEW_PORT: '65536' },
    { PREVIEW_PORT: '' }, { PREVIEW_PORT: '3e3' }, { ADMIN_KEY: 'invalid-test-key' }]) {
    const { child, closed, key, output } = preview(env);
    const timeout = setTimeout(() => child.kill(), 3000);
    try {
      const [exitCode] = await closed;
      assert.equal(exitCode, 1);
      assert.equal(output().includes('運営画面'), false);
      assert.equal(output().includes(key), false);
      assert.equal(output().includes('invalid-test-key'), false);
    } finally {
      clearTimeout(timeout);
      child.kill();
    }
  }
});
