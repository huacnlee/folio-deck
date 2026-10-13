import process from 'process';
import { nodeCommand } from './oauth-runtime.js';
import { GmailError, REDIRECT_URI, callbackCode } from './gmail.js';

// Only the loopback transport runs in Node. OAuth, PKCE, token storage and all
// Gmail operations stay in the gpui-shell application. No packages or backend.
export async function serveCallback() {
  const { createServer } = await import('node:http');
  const state = process.argv[1];
  if (!/^[A-Za-z0-9_-]{43}$/.test(state || '')) process.exit(2);
  let callback = null;
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Connection', 'close');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
    const url = new URL(request.url, 'http://127.0.0.1:9481');
    const reply = (status, value) => { response.writeHead(status, {'Content-Type':'application/json'}); response.end(JSON.stringify(value)); };
    if (request.headers.host !== '127.0.0.1:9481' || request.headers.origin) return reply(403, {error:'forbidden'});
    if (url.pathname === '/result' || url.pathname === '/cancel') {
      if (request.headers['x-folio-state'] !== state) return reply(403, {error:'forbidden'});
      if (url.pathname === '/cancel' && request.method === 'POST') {
        reply(200, {cancelled:true}); shutdown(); return;
      }
      if (url.pathname === '/result' && request.method === 'GET') {
        reply(200, {callback});
        if (callback) shutdown();
        return;
      }
      return reply(405, {error:'method'});
    }
    if (request.method !== 'GET' || url.pathname !== '/oauth2callback') return reply(404, {error:'not_found'});
    if (url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== state) return reply(400, {error:'state_mismatch'});
    if (callback) return reply(409, {error:'already_received'});
    if (!url.searchParams.get('error') && (url.searchParams.getAll('code').length !== 1 || !url.searchParams.get('code'))) return reply(400, {error:'code_missing'});
    callback = url.href;
    response.writeHead(200, {'Content-Type':'text/html; charset=utf-8'});
    response.end('<!doctype html><meta charset="utf-8"><title>Folio Desk</title><style>body{background:#faf9f6;color:#36342f;font:16px system-ui;margin:12vh auto;max-width:520px;padding:32px}h1{font-size:24px;font-weight:500}p{line-height:1.6}</style><h1>Authorization received.</h1><p>Return to Folio Desk to finish connecting your mailbox. You can close this tab.</p>');
  });
  const expiry = setTimeout(() => shutdown(), 10 * 60 * 1000);
  function shutdown() { clearTimeout(expiry); server.close(); server.closeIdleConnections(); setTimeout(() => process.exit(0), 500).unref(); }
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.on('error', error => { process.send?.({error:error.code === 'EADDRINUSE' ? 'port_busy' : 'listen_failed'}); process.exit(1); });
  server.listen(9481, '127.0.0.1', () => { process.send?.({ready:true}); process.disconnect?.(); });
}

const launchSource = `
import { spawn } from 'node:child_process';
const child = spawn(process.execPath, ['--input-type=module', '-e', process.argv[1], process.argv[2]], {detached:true, stdio:['ignore','ignore','ignore','ipc']});
const timeout = setTimeout(() => { child.kill(); process.exit(1); }, 5000);
child.on('error', () => { clearTimeout(timeout); process.exit(1); });
child.on('exit', () => { clearTimeout(timeout); process.exit(1); });
child.on('message', value => {
  clearTimeout(timeout);
  if (!value.ready) { console.log(JSON.stringify(value)); process.exit(1); }
  console.log(JSON.stringify(value)); child.removeAllListeners('exit'); child.unref();
});
`;

export class CallbackListener {
  constructor(pending, { request = globalThis.fetch, execute = (command, args) => process.run(command, args) } = {}) {
    this.pending = pending;
    this.request = request;
    this.execute = execute;
    this.cancelled = false;
  }
  async start() {
    let result;
    try { result = await this.execute(nodeCommand, ['--input-type=module', '-e', launchSource, `(${serveCallback.toString()})()`, this.pending.state]); }
    catch { throw new GmailError('Could not start the callback listener. Install Node.js 20 or newer and reinstall Folio.', 'listener_failed'); }
    let status;
    try { status = JSON.parse(result.stdout); } catch { status = {}; }
    if (result.code !== 0 || !status.ready) throw new GmailError(status.error === 'port_busy' ? 'The Gmail callback port is in use. Finish the other sign-in or try again later.' : 'Could not start the Gmail callback listener.', 'listener_failed');
    if (this.cancelled) await this.stop();
  }
  async poll() {
    const response = await this.request(`${new URL(REDIRECT_URI).origin}/result`, {headers:{'X-Folio-State':this.pending.state}});
    if (!response.ok) throw new GmailError('The callback listener stopped. Start sign-in again.', 'listener_failed');
    const result = await response.json();
    if (result.callback) { callbackCode(result.callback, this.pending); return result.callback; }
    return null;
  }
  async stop() {
    this.cancelled = true;
    try { await this.request(`${new URL(REDIRECT_URI).origin}/cancel`, {method:'POST', headers:{'X-Folio-State':this.pending.state}}); } catch { /* Already stopped or expired. */ }
  }
}
