import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { avatarFor, avatarPalettes } from '../avatar.js';
import { GmailClient, MailCache, CACHE_PREFIX, SCOPES, REDIRECT_URI, SESSION_KEY, parseCredentials, beginAuthorization, callbackCode, parseMessage, decodeHeader, htmlToText, emailHtml, textHtml, keepLineBreaks, buildRawMessage } from '../gmail.js';

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
  assert.equal(parseMessage(htmlOnly).html, '<p>Only HTML</p>');
  assert.equal(parsed.html, '<p>HTML alternative</p>', 'the HTML part is shown when a letter has one');
});

test('letter HTML is reduced to what TextView renders, without trackers or hidden text', () => {
  const html = emailHtml(`<!DOCTYPE html><html><head><title>t</title><style>p{color:red}</style></head><body bgcolor="#fff">
    <span style="display:none;max-height:0">Preheader you should not see</span>
    <p style="color:red" onclick="steal()" class="x">Hello <b>there</b></p>
    <img src="https://tracker.example/open.gif" width="1"><img src="https://cdn.example/logo.png" alt="Acme">
    <script>alert(1)</script><a href="javascript:alert(1)">bad</a> <a href="https://example.test/a?b=1&amp;c=2">ok</a>
    <form action="https://evil.example"><input name="password"></form></body></html>`);
  for (const gone of ['Preheader', 'style', 'onclick', 'class=', 'tracker.example', '<img', '<script', 'javascript:', 'password', '<title', 'bgcolor'])
    assert.ok(!html.includes(gone), `${gone} remains in ${html}`);
  assert.match(html, /<p>Hello <b>there<\/b><\/p>/);
  assert.match(html, /\[Acme\]/);
  assert.match(html, /<a>bad<\/a>/);
  assert.match(html, /<a href="https:\/\/example.test\/a\?b=1&amp;c=2">ok<\/a>/);

  assert.equal(textHtml('Hi <you> & me\nnext line\n\nView: https://github.com/a/b/runs/1.\n\nJobs:\n  * one failed\n  * two failed'),
    '<pre>Hi &lt;you&gt; &amp; me\nnext line</pre><p>View: <a href="https://github.com/a/b/runs/1">https://github.com/a/b/runs/1</a>.</p><pre>Jobs:\n  * one failed\n  * two failed</pre>');

  // TextView drops <br> inside paragraphs: innermost blocks carry lines in <pre>.
  assert.equal(keepLineBreaks('<div class="x"><p>Repository: <b>a/b</b><br>\n   Workflow: CI<br><br></p><p>Plain</p></div>'),
    '<div class="x"><pre>Repository: <b>a/b</b>\nWorkflow: CI</pre><p>Plain</p></div>');
  assert.equal(keepLineBreaks('<table><tr><td width="9">K1<br>K2</td></tr></table>'), '<table><tr><td width="9">K1 K2</td></tr></table>');
  assert.equal(keepLineBreaks('<ul><li>G1<br>G2</li></ul>'), '<ul><li>G1<br>G2</li></ul>', 'lists already break lines');
  assert.match(emailHtml('<p>A<br>B</p>'), /<pre>A\nB<\/pre>/);
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

test('lists reuse cached metadata, apply Gmail history and show saved listings at once', async () => {
  const storage = store(session);
  const urls = [];
  let history = { historyId: '200' };
  const fetch = async url => {
    urls.push(url);
    if (url.endsWith('/token')) return response({ access_token: 'access', expires_in: 3600 });
    const path = new URL(url).pathname;
    if (path.endsWith('/profile')) return response({ emailAddress: session.email, historyId: '100' });
    if (path.endsWith('/history')) return response(history);
    if (path.endsWith('/modify')) return response({ id: 'abc', labelIds: ['INBOX'] });
    if (path.endsWith('/messages')) return response({ messages: [{ id: 'abc' }, { id: '123' }] });
    return response(apiMessage(path.split('/').at(-1), url.includes('format=full') ? 'full' : 'metadata'));
  };
  const first = await new GmailClient({ storage, fetch }).list();
  assert.equal(first.messages.length, 2);
  assert.equal(urls.filter(url => url.includes('format=metadata')).length, 2);

  // A new process starts from the saved index and only asks Gmail what changed.
  urls.length = 0;
  history = { historyId: '300', history: [{ labelsRemoved: [{ message: { id: 'abc', labelIds: ['INBOX'] }, labelIds: ['UNREAD'] }] }, { messagesDeleted: [{ message: { id: '123' } }] }] };
  const client = new GmailClient({ storage, fetch });
  assert.deepEqual(client.cached().messages.map(m => m.id), ['abc', '123']);
  const second = await client.list();
  assert.equal(urls.filter(url => url.includes('format=metadata')).length, 1, 'only the deleted-then-listed id is fetched again');
  assert.equal(second.messages.find(m => m.id === 'abc').unread, false);
  assert.equal(JSON.parse(storage.getItem(`${CACHE_PREFIX}:${session.email}`)).historyId, '300');

  // Bodies are read once, then served from storage with current labels.
  const opened = await client.read('abc');
  urls.length = 0;
  const again = await client.read('abc');
  assert.deepEqual(again, opened); assert.equal(urls.length, 0);
  await client.modify('abc', [], ['UNREAD']);
  assert.equal((await client.read('abc')).unread, false, 'mutations write their returned labels into the cache');

  // An expired history baseline drops cached metadata instead of trusting it.
  history = null;
  client.fetch = async url => new URL(url).pathname.endsWith('/history') ? response({}, 404) : fetch(url);
  urls.length = 0;
  await client.list();
  assert.equal(urls.filter(url => url.includes('format=metadata')).length, 2);

  client.disconnect();
  assert.equal(storage.getItem(`${CACHE_PREFIX}:${session.email}`), null);
  assert.equal(storage.getItem(`${CACHE_PREFIX}:${session.email}:body:abc`), null);
});

test('mail cache filters stale folder rows, bounds bodies and stays in memory when not remembered', () => {
  const storage = store();
  const cache = new MailCache(storage, 'me@example.test');
  cache.historyId = '1';
  const message = parseMessage(apiMessage('abc', 'full'));
  cache.putMeta(message); cache.putList('INBOX', '', ['abc'], '', 1);
  assert.equal(cache.list('INBOX', '').messages.length, 1);
  cache.setLabels('abc', ['UNREAD']);
  assert.equal(cache.list('INBOX', '').messages.length, 0, 'archived letters leave the cached inbox');
  for (let i = 0; i < 70; i++) cache.putBody({ ...message, id: `m${i}` });
  cache.save();
  assert.equal(cache.bodies.length, 60);
  assert.equal(storage.getItem(`${cache.key}:body:m0`), null);
  cache.putBody({ ...message, id: 'huge', body: 'x'.repeat(300 * 1024) });
  assert.equal(cache.body('huge'), null);

  const disk = store({ ...session, remember: true });
  const client = new GmailClient({ storage: disk });
  client.session.remember = false;
  client.cache().putList('INBOX', '', [], '', 1); client.cache().save();
  assert.equal(disk.getItem(`${CACHE_PREFIX}:${session.email}`), null);
});

test('avatars are generated from the email address in the Folio tile style', () => {
  assert.deepEqual(avatarFor('Clara <Clara@Example.test>'), avatarFor('Someone else <clara@example.test>'), 'one address, one tile');
  assert.deepEqual(avatarFor('clara@example.test'), avatarFor('Clara <clara@example.test>'));
  const tiles = Array.from({ length: 400 }, (_, i) => avatarFor(`person${i}@example.test`));
  for (const tile of tiles) for (const layer of tile.layers) for (const op of layer.ops) {
    assert.ok(avatarPalettes.flat().includes(layer.color));
    for (const value of op.slice(1).filter(value => typeof value === 'number')) assert.ok(value >= 0 && value <= 64, `${value} leaves the tile`);
  }
  assert.equal(new Set(tiles.map(tile => tile.ground)).size, avatarPalettes.length, 'every palette is used');
  assert.equal(new Set(tiles.map(tile => tile.motif)).size, 7, 'every motif is used');
  // ~14,000 combinations: a hash cannot promise uniqueness, but repeats stay rare.
  assert.ok(new Set(tiles.map(tile => JSON.stringify(tile))).size >= 385, 'repeats stay rare across 400 addresses');
  const inbox = ['notifications@github.com', 'no-reply@accounts.google.com', 'sunli@example.com', 'clara@example.test', 'owen@stillhouse.example', 'nina@softassembly.example'];
  assert.equal(new Set(inbox.map(address => JSON.stringify(avatarFor(address)))).size, inbox.length);
});
