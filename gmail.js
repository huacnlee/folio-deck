import { Buffer } from 'buffer';
import { createHash, randomBytes } from 'crypto';

// Gmail REST/OAuth and MIME rules follow omamail's OAuth.js, GmailApi.js and
// Message.js. This module talks directly to Google; there is no native backend.
export const SCOPES = ['https://www.googleapis.com/auth/gmail.modify', 'https://www.googleapis.com/auth/gmail.send'];
export const REDIRECT_URI = 'http://127.0.0.1:9481/oauth2callback';
export const SESSION_KEY = 'folio-gmail-session-v1';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const TOKEN = 'https://oauth2.googleapis.com/token';
const base64url = bytes => Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const form = values => Object.entries(values).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
const clean = value => String(value ?? '').replace(/[\r\n\0]/g, ' ').trim();

export class GmailError extends Error {
  constructor(message, code = 'request_failed') { super(message); this.name = 'GmailError'; this.code = code; }
}

export function parseCredentials(value) {
  let raw;
  try { raw = typeof value === 'string' ? JSON.parse(value) : value; } catch { throw new GmailError('Paste the Desktop app OAuth client JSON from Google Cloud.', 'credentials_invalid'); }
  if (!raw || raw.web) throw new GmailError('Use a Desktop app OAuth client, rather than a Web application client.', 'credentials_invalid');
  const client = raw.installed || raw;
  const clientId = String(client.client_id || client.clientId || '').trim();
  const clientSecret = String(client.client_secret || client.clientSecret || '').trim();
  if (!/^\d+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId) || !clientSecret || /[\r\n\0]/.test(clientSecret))
    throw new GmailError('The JSON must contain a valid client_id and client_secret.', 'credentials_invalid');
  return { clientId, clientSecret };
}

export function beginAuthorization(credentials, now = Date.now()) {
  const config = parseCredentials(credentials);
  const verifier = base64url(randomBytes(32));
  const state = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  const pending = { ...config, verifier, state, createdAt: now };
  return { pending, url: `https://accounts.google.com/o/oauth2/v2/auth?${form({ client_id: config.clientId, redirect_uri: REDIRECT_URI, response_type: 'code', scope: SCOPES.join(' '), code_challenge: challenge, code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent' })}` };
}

export function callbackCode(value, pending, now = Date.now()) {
  if (!pending || now - pending.createdAt > 10 * 60 * 1000) throw new GmailError('This sign-in expired. Start again.', 'auth_expired');
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new GmailError('Paste the complete localhost address from the browser.', 'callback_invalid'); }
  const expected = new URL(REDIRECT_URI);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.hash || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== pending.state)
    throw new GmailError('This callback does not match the current sign-in. Start again.', 'callback_invalid');
  if (url.searchParams.get('error')) throw new GmailError('Google sign-in was cancelled. You can start again.', 'auth_cancelled');
  const codes = url.searchParams.getAll('code');
  if (codes.length !== 1 || !codes[0]) throw new GmailError('The callback address contains no authorization code.', 'callback_invalid');
  return codes[0];
}

function errorFor(status, payload) {
  if (payload?.error === 'invalid_grant' || status === 401) return new GmailError('Your Gmail session expired. Connect Gmail again.', 'reconnect');
  if (status === 429 || payload?.error?.errors?.some(e => e.reason === 'rateLimitExceeded')) return new GmailError('Gmail is busy. Wait a moment, then retry.', 'rate_limit');
  if (status === 403) return new GmailError('Google refused access. Enable the Gmail API and grant the requested Gmail permissions.', 'permission_denied');
  if (status === 404) return new GmailError('This message is no longer available.', 'not_found');
  if (status >= 500) return new GmailError('Gmail is temporarily unavailable. Try again.', 'unavailable');
  // Server error text can echo credentials. Expose known status only.
  return new GmailError('Google could not complete this request. Check your OAuth client and try again.');
}

export class GmailClient {
  constructor({ fetch: request = globalThis.fetch, storage = globalThis.localStorage, now = () => Date.now() } = {}) {
    this.fetch = request;
    this.storage = storage;
    this.now = now;
    this.session = null;
    this.refreshing = null;
    this.revision = 0;
    try {
      const saved = JSON.parse(storage.getItem(SESSION_KEY) || 'null');
      if (saved?.email && saved?.refreshToken) this.session = { ...parseCredentials(saved), email: saved.email, refreshToken: saved.refreshToken, remember: true };
    } catch { /* Invalid local state is replaced only after a successful login. */ }
  }

  async transport(url, options) {
    let response;
    try { response = await this.fetch(url, options); } catch { throw new GmailError('Couldn’t reach Google. Check your connection, then retry.', 'offline'); }
    let data;
    try { data = await response.json(); } catch { throw new GmailError('Google returned an unreadable response. Try again.', 'invalid_response'); }
    return { response, data };
  }

  save() {
    const s = this.session;
    if (s?.remember) this.storage.setItem(SESSION_KEY, JSON.stringify({ clientId: s.clientId, clientSecret: s.clientSecret, refreshToken: s.refreshToken, email: s.email }));
    else this.storage.removeItem(SESSION_KEY);
  }

  async connect(pending, callback, remember = true) {
    const code = callbackCode(callback, pending, this.now());
    const revision = this.revision;
    const { response, data } = await this.transport(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ client_id: pending.clientId, client_secret: pending.clientSecret, redirect_uri: REDIRECT_URI, grant_type: 'authorization_code', code_verifier: pending.verifier, code }) });
    if (!response.ok) throw errorFor(response.status, data);
    if (!data.access_token || !data.refresh_token) throw new GmailError('Google did not grant offline access. Start sign-in again.', 'offline_access_missing');
    if (!SCOPES.every(scope => String(data.scope || '').split(/\s+/).includes(scope))) throw new GmailError('Grant both reading and sending permissions, then reconnect.', 'missing_scope');
    const temporary = { clientId: pending.clientId, clientSecret: pending.clientSecret, accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: this.now() + Number(data.expires_in || 3600) * 1000, remember };
    const profile = await this.transport(`${API}/profile`, { headers: { Authorization: `Bearer ${temporary.accessToken}` } });
    if (!profile.response.ok) throw errorFor(profile.response.status, profile.data);
    if (!profile.data.emailAddress?.includes('@')) throw new GmailError('Google did not return a mailbox address.', 'invalid_profile');
    if (revision !== this.revision) throw new GmailError('Sign-in was cancelled.', 'auth_cancelled');
    this.session = { ...temporary, email: profile.data.emailAddress };
    ++this.revision;
    this.refreshing = null;
    this.save();
    return this.session.email;
  }

  async token(force = false) {
    const session = this.session;
    if (!session) throw new GmailError('Connect Gmail to open your mailbox.', 'reconnect');
    if (!force && session.accessToken && session.expiresAt > this.now() + 60000) return session.accessToken;
    if (this.refreshing) return this.refreshing;
    const revision = this.revision;
    const flight = (async () => {
      const { response, data } = await this.transport(TOKEN, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form({ client_id: session.clientId, client_secret: session.clientSecret, refresh_token: session.refreshToken, grant_type: 'refresh_token' }) });
      if (!response.ok) throw errorFor(response.status, data);
      if (!data.access_token) throw new GmailError('Google returned no access token.', 'invalid_response');
      if (revision !== this.revision) throw new GmailError('This account is no longer connected.', 'reconnect');
      session.accessToken = data.access_token;
      session.expiresAt = this.now() + Number(data.expires_in || 3600) * 1000;
      if (data.refresh_token) { session.refreshToken = data.refresh_token; this.save(); }
      return session.accessToken;
    })();
    this.refreshing = flight;
    try { return await flight; } finally { if (this.refreshing === flight) this.refreshing = null; }
  }

  async request(path, { method = 'GET', body, query = {} } = {}, retried = false) {
    if (!/^\/[A-Za-z0-9/_-]+$/.test(path) || path.includes('..')) throw new GmailError('Invalid Gmail resource.', 'invalid_resource');
    const bearer = await this.token();
    const revision = this.revision;
    const suffix = form(query);
    const { response, data } = await this.transport(`${API}${path}${suffix ? `?${suffix}` : ''}`, { method, headers: { Authorization: `Bearer ${bearer}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (revision !== this.revision) throw new GmailError('This account is no longer connected.', 'reconnect');
    // A 401 explicitly refused authorization. Never retry an ambiguous send.
    if (response.status === 401 && !retried) { await this.token(true); return this.request(path, { method, body, query }, true); }
    if (!response.ok) throw errorFor(response.status, data);
    return data;
  }

  profile() { return this.request('/profile'); }
  async list({ folder = 'INBOX', query = '', pageToken = '' } = {}) {
    const page = await this.request('/messages', { query: { maxResults: 25, ...(folder ? { labelIds: folder } : {}), q: query, ...(pageToken ? { pageToken } : {}) } });
    const ids = (page.messages || []).map(m => m.id);
    // Keep small metadata requests bounded; no eager full-body downloads.
    const messages = [];
    for (let i = 0; i < ids.length; i += 5) {
      const batch = await Promise.all(ids.slice(i, i + 5).map(id => this.request(`/messages/${id}`, { query: { format: 'metadata' } }).then(parseMessage)));
      messages.push(...batch);
    }
    return { messages, nextPageToken: page.nextPageToken || '', estimate: page.resultSizeEstimate || 0 };
  }
  async read(id) { return parseMessage(await this.request(`/messages/${id}`, { query: { format: 'full' } })); }
  modify(id, addLabelIds = [], removeLabelIds = []) { return this.request(`/messages/${id}/modify`, { method: 'POST', body: { addLabelIds, removeLabelIds } }); }
  trash(id) { return this.request(`/messages/${id}/trash`, { method: 'POST', body: {} }); }
  untrash(id) { return this.request(`/messages/${id}/untrash`, { method: 'POST', body: {} }); }
  send(fields) {
    const raw = buildRawMessage({ ...fields, from: this.session?.email });
    return this.request('/messages/send', { method: 'POST', body: { raw, ...(fields.threadId ? { threadId: fields.threadId } : {}) } });
  }
  disconnect() { ++this.revision; this.session = null; this.refreshing = null; this.save(); }
}

function decode64(value, charset = 'utf8') {
  return Buffer.from(String(value || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(/^(iso-8859-1|latin-?1|windows-1252)$/i.test(charset) ? 'latin1' : 'utf8');
}
export function decodeHeader(value) {
  return String(value || '').replace(/(\?=)\s+(?==\?)/g, '$1').replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_word, charset, kind, encoded) => {
    if (kind.toUpperCase() === 'B') return decode64(encoded, charset);
    const bytes = [];
    const source = encoded.replace(/_/g, ' ');
    for (let i = 0; i < source.length; i++) {
      if (source[i] === '=' && /^[0-9a-f]{2}$/i.test(source.slice(i + 1, i + 3))) { bytes.push(parseInt(source.slice(i + 1, i + 3), 16)); i += 2; }
      else bytes.push(source.charCodeAt(i));
    }
    return Buffer.from(bytes).toString(/^(iso-8859-1|latin-?1|windows-1252)$/i.test(charset) ? 'latin1' : 'utf8');
  });
}
export function htmlToText(value) {
  return String(value || '').replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '').replace(/<img\b[^>]*>/gi, '[Image]').replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n').replace(/<li[^>]*>/gi, '• ').replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&apos;|&#39;/gi, "'").replace(/&amp;/gi, '&').replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Math.min(Number(n), 0x10ffff))).replace(/&#x([0-9a-f]+);/gi, (_m, n) => String.fromCodePoint(Math.min(parseInt(n, 16), 0x10ffff))).replace(/\n{3,}/g, '\n\n').trim();
}
export function mailboxAddress(value) {
  const source = clean(value);
  const matched = source.match(/<([^<>]+)>/);
  return (matched ? matched[1] : source).trim();
}
export function parseMessage(raw) {
  const header = name => decodeHeader((raw.payload?.headers || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '');
  const from = header('From');
  const attachments = [], plain = [], html = [];
  function walk(part) {
    if (!part) return;
    if (part.filename) attachments.push({ name: part.filename, size: part.body?.size || 0, attachmentId: part.body?.attachmentId || '' });
    else if (part.body?.data) {
      const charset = (part.headers || []).find(h => h.name.toLowerCase() === 'content-type')?.value.match(/charset=["']?([^\s;"']+)/i)?.[1] || 'utf8';
      if (part.mimeType === 'text/plain') plain.push(decode64(part.body.data, charset));
      if (part.mimeType === 'text/html') html.push(htmlToText(decode64(part.body.data, charset)));
    }
    (part.parts || []).forEach(walk);
  }
  walk(raw.payload);
  return { id: raw.id, threadId: raw.threadId, from, sender: from.replace(/\s*<[^>]+>/, '').replace(/^"|"$/g, '') || from, to: header('To'), replyTo: header('Reply-To') || from, subject: header('Subject') || '(No subject)', messageId: header('Message-ID'), references: header('References'), date: Number(raw.internalDate) || Date.parse(header('Date')) || 0, snippet: htmlToText(raw.snippet || ''), body: (plain.length ? plain : html).join('\n\n'), labels: raw.labelIds || [], unread: (raw.labelIds || []).includes('UNREAD'), starred: (raw.labelIds || []).includes('STARRED'), attachments };
}

export function buildRawMessage(fields) {
  for (const key of ['from', 'to', 'subject', 'inReplyTo', 'references']) {
    if (/[\r\n\0]/.test(String(fields[key] || ''))) throw new GmailError(`The ${key} field contains an invalid line break.`, 'invalid_message');
  }
  const from = mailboxAddress(fields.from), to = String(fields.to || '').trim();
  if (!from.includes('@') || !to || !to.split(',').every(address => /^[^\s<>@,]+@[^\s<>@,]+\.[^\s<>@,]+$/.test(mailboxAddress(address)))) throw new GmailError('Enter a valid recipient email address.', 'invalid_recipient');
  if (!String(fields.body || '').trim()) throw new GmailError('Write a message before sending.', 'empty_body');
  const chunks = [];
  let chunk = '';
  for (const char of Array.from(fields.subject || '(No subject)')) {
    if (chunk && Buffer.from(chunk + char).length > 42) { chunks.push(chunk); chunk = ''; }
    chunk += char;
  }
  if (chunk) chunks.push(chunk);
  const encodedSubject = chunks.map(value => `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`).join('\r\n ');
  const body64 = Buffer.from(String(fields.body).replace(/\r?\n/g, '\r\n')).toString('base64').match(/.{1,76}/g).join('\r\n');
  const lines = [`From: ${from}`, `To: ${to}`, `Subject: ${encodedSubject}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64'];
  if (fields.inReplyTo) lines.push(`In-Reply-To: ${fields.inReplyTo}`);
  if (fields.references) lines.push(`References: ${fields.references}`);
  return base64url(Buffer.from(`${lines.join('\r\n')}\r\n\r\n${body64}\r\n`));
}
