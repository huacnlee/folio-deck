import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GmailClient, SCOPES, REDIRECT_URI, SESSION_KEY, parseCredentials, beginAuthorization, callbackCode, parseMessage, decodeHeader, htmlToText, buildRawMessage } from '../gmail.js';

const credentials = { installed: { client_id: '123456-test.apps.googleusercontent.com', client_secret: 'test-client-secret' } };
const session = { clientId: credentials.installed.client_id, clientSecret: credentials.installed.client_secret, refreshToken: 'test-refresh', email: 'me@example.test' };
const store = value => {
  const values = new Map(value ? [[SESSION_KEY, JSON.stringify(value)]] : []);
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
};
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const b64 = value => Buffer.from(value).toString('base64url');
const apiMessage = (id = 'abc', format = 'metadata') => ({ id, threadId: 'def', internalDate: '1700000000000', snippet: 'Hello &amp; goodbye', labelIds: ['INBOX', 'UNREAD'], payload: { headers: [{ name: 'Subject', value: '=?UTF-8?B?5L2g5aW9?=' }, { name: 'From', value: 'Clara <clara@example.test>' }, { name: 'To', value: 'me@example.test' }], ...(format === 'full' ? { mimeType: 'multipart/alternative', parts: [{ mimeType: 'text/plain', body: { data: b64('Hello 世界') } }, { mimeType: 'text/html', body: { data: b64('<p>HTML alternative</p>') } }] } : {}) } });

test('desktop OAuth validates client type and uses unpredictable PKCE/state', () => {
  assert.deepEqual(parseCredentials(JSON.stringify(credentials)), { clientId: session.clientId, clientSecret: session.clientSecret });
  assert.throws(() => parseCredentials({ web: credentials.installed }), /Desktop app/);
  assert.throws(() => parseCredentials('{broken'), /JSON/);
  const first = beginAuthorization(credentials, 1000), second = beginAuthorization(credentials, 1000);
  assert.notEqual(first.pending.state, second.pending.state);
  const url = new URL(first.url);
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(first.pending.verifier).digest('base64url'));
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(url.searchParams.get('scope'), SCOPES.join(' '));
  assert.equal(url.searchParams.get('prompt'), 'consent');
});

test('callbacks enforce exact origin, path, state, expiry and one authorization code', () => {
  const { pending } = beginAuthorization(credentials, 1000);
  const url = `${REDIRECT_URI}?code=test-code&state=${pending.state}`;
  assert.equal(callbackCode(url, pending, 1100), 'test-code');
  for (const bad of [url.replace('127.0.0.1', 'evil.example'), url.replace('oauth2callback', 'other'), url + '&state=other', url + '&code=second', url.replace(pending.state, 'wrong')])
    assert.throws(() => callbackCode(bad, pending, 1100));
  assert.throws(() => callbackCode(url, pending, 700000), /expired/);
  assert.throws(() => callbackCode(`${REDIRECT_URI}?error=access_denied&state=${pending.state}`, pending, 1100), /cancelled/);
});

test('MIME parsing decodes international headers, plain alternatives and attachments', () => {
  const message = apiMessage('abc', 'full');
  message.payload.parts.push({ mimeType: 'application/pdf', filename: 'Outline.pdf', body: { attachmentId: 'attach-id', size: 2048 } });
  const parsed = parseMessage(message);
  assert.equal(parsed.subject, '你好');
  assert.equal(parsed.body, 'Hello 世界');
  assert.equal(parsed.sender, 'Clara');
  assert.equal(parsed.snippet, 'Hello & goodbye');
  assert.equal(parsed.unread, true);
  assert.deepEqual(parsed.attachments, [{ name: 'Outline.pdf', size: 2048, attachmentId: 'attach-id' }]);
  assert.equal(decodeHeader('=?ISO-8859-1?Q?caf=E9?='), 'café');
  assert.equal(htmlToText('<style>hidden</style><script>unsafe()</script><p>Hello<br>world<img src="https://tracker.example"></p>'), 'Hello\nworld[Image]');
  const htmlOnly = { payload: { mimeType: 'text/html', body: { data: b64('<p>Only HTML</p>') } } };
  assert.equal(parseMessage(htmlOnly).body, 'Only HTML');
});

test('outgoing MIME is UTF-8 base64url and preserves reply threading without header injection', () => {
  const raw = buildRawMessage({ from: 'me@example.test', to: 'you@example.test', subject: '你好', body: 'Hello\n世界', inReplyTo: '<original@example.test>', references: '<previous@example.test> <original@example.test>' });
  assert.match(raw, /^[A-Za-z0-9_-]+$/);
  const mime = Buffer.from(raw, 'base64url').toString('utf8');
  assert.match(mime, /Subject: =\?UTF-8\?B\?5L2g5aW9\?=/);
  assert.match(mime, /In-Reply-To: <original@example.test>/);
  const body = mime.split('\r\n\r\n')[1];
  assert.equal(Buffer.from(body, 'base64').toString('utf8'), 'Hello\r\n世界');
  for (const fields of [{ subject: 'Hi\r\nBcc: bad@example.test' }, { to: 'invalid' }, { body: ' ' }])
    assert.throws(() => buildRawMessage({ from: 'me@example.test', to: 'you@example.test', subject: 'Hi', body: 'Hello', ...fields }));
});

test('concurrent expired sessions share one refresh and never persist access tokens', async () => {
  let refreshes = 0;
  const storage = store(session);
  const client = new GmailClient({ storage, fetch: async (url, options) => {
    if (url.endsWith('/token')) { ++refreshes; assert.match(options.body, /grant_type=refresh_token/); await new Promise(resolve => setTimeout(resolve, 10)); return response({ access_token: 'test-access', expires_in: 3600 }); }
    assert.equal(options.headers.Authorization, 'Bearer test-access');
    return response({ emailAddress: 'me@example.test' });
  } });
  await Promise.all([client.profile(), client.profile(), client.profile()]);
  assert.equal(refreshes, 1);
  assert.equal(JSON.parse(storage.getItem(SESSION_KEY)).accessToken, undefined);
});

test('401 refreshes once; credential errors are redacted and require reconnect', async () => {
  let calls = 0, refreshes = 0;
  const client = new GmailClient({ storage: store(session), fetch: async url => {
    if (url.endsWith('/token')) return response({ access_token: `token-${++refreshes}`, expires_in: 3600 });
    return ++calls === 1 ? response({}, 401) : response({ emailAddress: 'me@example.test' });
  } });
  assert.equal((await client.profile()).emailAddress, session.email);
  assert.equal(refreshes, 2); assert.equal(calls, 2);
  const broken = new GmailClient({ storage: store(session), fetch: async () => response({ error: 'invalid_grant', error_description: 'test-refresh secret echoed' }, 400) });
  await assert.rejects(broken.profile(), error => error.code === 'reconnect' && !error.message.includes('test-refresh'));
});

test('lists load only metadata, bound concurrent work, and preserve pagination', async () => {
  const urls = [];
  const client = new GmailClient({ storage: store(session), fetch: async url => {
    urls.push(url);
    if (url.endsWith('/token')) return response({ access_token: 'access', expires_in: 3600 });
    if (new URL(url).pathname.endsWith('/messages')) return response({ messages: [{ id: 'abc' }, { id: '123' }], nextPageToken: 'next', resultSizeEstimate: 50 });
    return response(apiMessage(new URL(url).pathname.split('/').at(-1)));
  } });
  const result = await client.list({ folder: 'INBOX', query: 'from:clara newer_than:1d', pageToken: 'previous' });
  assert.equal(result.messages.length, 2); assert.equal(result.nextPageToken, 'next');
  const list = new URL(urls.find(url => new URL(url).pathname.endsWith('/messages')));
  assert.equal(list.searchParams.get('q'), 'from:clara newer_than:1d');
  assert.equal(list.searchParams.get('pageToken'), 'previous');
  assert.equal(urls.filter(url => url.includes('format=metadata')).length, 2);
});

test('send/mutations use Google resource paths; an ambiguous send is never retried', async () => {
  const requests = [];
  const client = new GmailClient({ storage: store(session), fetch: async (url, options) => {
    if (url.endsWith('/token')) return response({ access_token: 'access', expires_in: 3600 });
    requests.push({ url, options });
    if (url.endsWith('/send')) throw new Error('Connection closed after accepting message');
    return response({ id: 'abc' });
  } });
  await client.modify('abc', ['STARRED'], ['UNREAD']);
  assert.deepEqual(JSON.parse(requests[0].options.body), { addLabelIds: ['STARRED'], removeLabelIds: ['UNREAD'] });
  await client.trash('abc'); await client.untrash('abc');
  await assert.rejects(client.send({ to: 'you@example.test', subject: 'Hi', body: 'Hello', threadId: 'def' }), error => error.code === 'offline');
  assert.equal(requests.filter(r => r.url.endsWith('/send')).length, 1);
  assert.equal(JSON.parse(requests.at(-1).options.body).threadId, 'def');
  await assert.rejects(client.request('/../../evil'), error => error.code === 'invalid_resource');
});

test('sign-in commits only after scopes/profile verification; disconnect blocks late refresh', async () => {
  const storage = store();
  const auth = beginAuthorization(credentials);
  const client = new GmailClient({ storage, fetch: async url => url.endsWith('/token') ? response({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600, scope: SCOPES.join(' ') }) : response({ emailAddress: 'verified@example.test' }) });
  assert.equal(await client.connect(auth.pending, `${REDIRECT_URI}?code=code&state=${auth.pending.state}`, false), 'verified@example.test');
  assert.equal(storage.getItem(SESSION_KEY), null);
  let release;
  client.session.accessToken = null;
  client.fetch = () => new Promise(resolve => { release = resolve; });
  const refresh = client.token();
  client.disconnect();
  release(response({ access_token: 'late-token' }));
  await assert.rejects(refresh, error => error.code === 'reconnect');
  assert.equal(client.session, null);
  assert.equal(storage.getItem(SESSION_KEY), null);
});
