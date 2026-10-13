import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../config.js';
import { appFixture, post, ORIGIN } from './helpers.js';

test('local administration needs no OIDC and remote dashboard remains disabled by default', async () => {
  const config = loadConfig({ DOMAGENT_ORIGIN: ORIGIN, DOMAGENT_OIDC_ISSUER: 'https://old-control.test/auth' });
  assert(config.protectedOrigins.includes('https://old-control.test'));
  assert.equal(config.operatorSecret(), null);
  const f = await appFixture();
  try {
    assert.equal((await fetch(`${f.base}/dashboard`)).status, 404);
    assert.equal((await post(f.base, '/api/operator/login', { secret: 'x'.repeat(40) }, { Origin: ORIGIN })).status, 404);
  } finally { await f.close(); }
});

test('static operator sessions and CSRF are separate from client credentials and invalidated on secret rotation', async () => {
  let secret = 's'.repeat(40);
  const f = await appFixture({ operatorSecret: () => secret });
  try {
    const client = f.store.createClient('Atlas');
    assert.equal((await post(f.base, '/api/operator/login', { secret: client.credential }, { Origin: ORIGIN })).status, 401);
    const login = await post(f.base, '/api/operator/login', { secret }, { Origin: ORIGIN });
    assert.equal(login.status, 200);
    const session = await login.json();
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.match(login.headers.get('set-cookie'), /HttpOnly/);
    assert.match(login.headers.get('set-cookie'), /Secure/);
    assert.equal((await fetch(`${f.base}/api/operator/clients`, { headers: { Cookie: cookie } })).status, 200);
    const path = `/api/operator/client/${client.id}/revoke`;
    assert.equal((await post(f.base, path, { csrf: 'wrong' }, { Cookie: cookie, Origin: ORIGIN })).status, 403);
    assert.equal((await post(f.base, path, { csrf: session.csrf }, { Cookie: cookie, Origin: 'https://attacker.test' })).status, 403);
    secret = 'q'.repeat(40);
    assert.equal((await fetch(`${f.base}/api/operator/clients`, { headers: { Cookie: cookie } })).status, 401);
    assert.equal(f.store.client(client.id).id, client.id);
  } finally { await f.close(); }
});
