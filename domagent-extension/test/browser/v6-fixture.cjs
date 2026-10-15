const path = require('node:path');
const fs = require('node:fs/promises');
const https = require('node:https');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { actionHtml, respondToForm } = require('./action-fixtures.cjs');

const root = path.resolve(__dirname, '../../..');
const localRequire = createRequire(path.join(root, 'domagent-mcp/package.json'));
const { Client } = localRequire('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = localRequire('@modelcontextprotocol/sdk/client/streamableHttp.js');
const AGENT_KEY = 'da_browser-fixture-key-0123456789abcdef';
const description = 'Operate only this explicitly approved disposable browser fixture page';

/** Real v6 service over TLS (CA-signed for Firefox), a disposable page server and an MCP client. */
async function startService(directory) {
  await fs.mkdir(directory, { recursive: true });
  const run = args => execFileSync('openssl', args, { stdio: 'ignore' });
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(directory, 'ca-key.pem'),
    '-out', path.join(directory, 'ca.pem'), '-days', '1', '-subj', '/CN=DomAgent v6 test CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(directory, 'key.pem'),
    '-out', path.join(directory, 'server.csr'), '-subj', '/CN=127.0.0.1']);
  await fs.writeFile(path.join(directory, 'server.ext'),
    'subjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth');
  run(['x509', '-req', '-in', path.join(directory, 'server.csr'), '-CA', path.join(directory, 'ca.pem'),
    '-CAkey', path.join(directory, 'ca-key.pem'), '-CAcreateserial', '-out', path.join(directory, 'cert.pem'),
    '-days', '1', '-extfile', path.join(directory, 'server.ext')]);
  const ca = (await fs.readFile(path.join(directory, 'ca.pem'), 'utf8')).replace(/-----[^-]+-----|\s/g, '');
  const { Store } = await import(pathToFileURL(path.join(root, 'domagent-mcp/store.js')).href);
  const { createApp } = await import(pathToFileURL(path.join(root, 'domagent-mcp/app.js')).href);
  let app;
  const tls = https.createServer({ key: await fs.readFile(path.join(directory, 'key.pem')),
    cert: await fs.readFile(path.join(directory, 'cert.pem')) }, (req, res) => app.server.listeners('request')[0](req, res));
  tls.on('upgrade', (req, socket, head) => app.hub.upgrade(req, socket, head));
  await new Promise(resolve => tls.listen(0, '127.0.0.1', resolve));
  const origin = `https://127.0.0.1:${tls.address().port}`;
  const store = new Store(':memory:');
  const agents = new Map([['atlas', { id: 'atlas', name: 'Atlas', url: 'https://atlas.example/',
    key_hash: createHash('sha256').update(AGENT_KEY).digest('hex') }]]);
  app = createApp(store, { origin, protectedOrigins: [origin, 'https://control.test'], bind: '127.0.0.1', port: 0, agents });
  const address = await app.listen();
  const pages = http.createServer(async (req, res) => {
    if (await respondToForm(req, res)) return;
    res.setHeader('Content-Type', 'text/html');
    if (req.url === '/login') { res.end('<title>Fixture login</title><h1>Sign in here</h1>'); return; }
    res.end('<title>Fixture task page</title><h1>Approved session fixture</h1>' + actionHtml);
  });
  await new Promise(resolve => pages.listen(0, '127.0.0.1', resolve));
  const pageUrl = `http://127.0.0.1:${pages.address().port}/`;
  const clients = [];
  const mcp = async () => {
    const client = new Client({ name: 'v6-browser-fixture', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp/atlas`), {
      requestInit: { headers: { Authorization: `Bearer ${AGENT_KEY}` } } }));
    clients.push(client);
    const raw = (name, args = {}) => client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
    const call = async (name, args = {}) => {
      const result = await raw(name, args);
      const value = JSON.parse(result.content[0].text);
      if (result.isError) throw Object.assign(new Error(`${name}: ${value.error}`), { code: value.error, details: value });
      return value;
    };
    return { client, raw, call };
  };
  return { origin, ca, app, store, pageUrl, mcp, description,
    async close() {
      if (this.closed) return;
      this.closed = true;
      for (const client of clients) await client.close().catch(() => {});
      await app.close().catch(() => {}); store.close();
      tls.closeAllConnections?.(); tls.close(); pages.close();
    } };
}

module.exports = { startService, description, root };
