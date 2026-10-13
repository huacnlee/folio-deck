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

export const CACHE_PREFIX = 'folio-gmail-cache-v1';
const CACHE_LISTS = 24, CACHE_BODIES = 60, CACHE_BODY_CHARS = 256 * 1024;
const memoryStorage = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; };

// Per-account mail cache. Metadata and labels stay trustworthy only while a
// Gmail historyId baseline exists; bodies are immutable and keyed separately
// so one letter never forces the whole index to be rewritten.
export class MailCache {
  constructor(storage, email) {
    this.storage = storage;
    this.key = `${CACHE_PREFIX}:${email}`;
    let saved = null;
    try { saved = JSON.parse(storage.getItem(this.key) || 'null'); } catch { /* A broken cache is rebuilt from Gmail. */ }
    this.historyId = String(saved?.historyId || '');
    this.lists = saved?.lists || {};
    this.meta = saved?.meta || {};
    this.bodies = Array.isArray(saved?.bodies) ? saved.bodies : [];
  }

  listKey(folder, query) { return `${folder}|${query}`; }
  list(folder, query) {
    const entry = this.lists[this.listKey(folder, query)];
    if (!entry || !this.historyId) return null;
    const messages = entry.ids.map(id => this.meta[id]).filter(m => m && (!folder || m.labels.includes(folder)));
    return { messages, nextPageToken: entry.nextPageToken, at: entry.at };
  }
  putList(folder, query, ids, nextPageToken, now) { this.lists[this.listKey(folder, query)] = { ids, nextPageToken, at: now }; }
  cachedMeta(id) { return this.historyId ? this.meta[id] : undefined; }
  putMeta(message) {
    const { body: _body, html: _html, attachments: _attachments, ...meta } = message;
    this.meta[message.id] = meta;
  }
  setLabels(id, labels) {
    const patch = m => m && Object.assign(m, { labels, unread: labels.includes('UNREAD'), starred: labels.includes('STARRED') });
    patch(this.meta[id]);
    const body = this.readBody(id);
    if (body) { patch(body); this.writeBody(body); }
  }
  remove(id) {
    delete this.meta[id];
    if (this.bodies.includes(id)) { this.bodies = this.bodies.filter(other => other !== id); this.storage.removeItem(`${this.key}:body:${id}`); }
  }
  resetMeta() { this.meta = {}; this.lists = {}; this.historyId = ''; }

  readBody(id) {
    if (!this.bodies.includes(id)) return null;
    try { return JSON.parse(this.storage.getItem(`${this.key}:body:${id}`) || 'null'); } catch { return null; }
  }
  body(id) {
    const message = this.readBody(id);
    if (!message) return null;
    this.bodies = [id, ...this.bodies.filter(other => other !== id)];
    const meta = this.cachedMeta(id);
    return meta ? { ...message, labels: meta.labels, unread: meta.unread, starred: meta.starred } : message;
  }
  writeBody(message) {
    try { this.storage.setItem(`${this.key}:body:${message.id}`, JSON.stringify(message)); return true; } catch { return false; }
  }
  putBody(message) {
    if (String(message.body || '').length + String(message.html || '').length > CACHE_BODY_CHARS) return;
    this.bodies = [message.id, ...this.bodies.filter(other => other !== message.id)];
    if (!this.writeBody(message)) this.bodies.shift();
  }

  save() {
    for (const id of this.bodies.slice(CACHE_BODIES)) this.storage.removeItem(`${this.key}:body:${id}`);
    this.bodies = this.bodies.slice(0, CACHE_BODIES);
    const lists = Object.entries(this.lists).sort(([, a], [, b]) => b.at - a.at).slice(0, CACHE_LISTS);
    this.lists = Object.fromEntries(lists);
    const kept = new Set([...lists.flatMap(([, entry]) => entry.ids), ...this.bodies]);
    this.meta = Object.fromEntries(Object.entries(this.meta).filter(([id]) => kept.has(id)));
    try { this.storage.setItem(this.key, JSON.stringify({ historyId: this.historyId, lists: this.lists, meta: this.meta, bodies: this.bodies })); }
    catch { /* Storage is full: the cache stays in memory for this session. */ }
  }
  clear() {
    for (const id of this.bodies) this.storage.removeItem(`${this.key}:body:${id}`);
    this.storage.removeItem(this.key);
    this.bodies = []; this.resetMeta();
  }
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
    this.mailCache = null;
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

  cache() {
    const session = this.session;
    if (!session) return null;
    // A session that is not remembered must not leave mail on disk either.
    if (this.mailCache?.email !== session.email) {
      this.mailCache = new MailCache(session.remember ? this.storage : memoryStorage(), session.email);
      this.mailCache.email = session.email;
    }
    return this.mailCache;
  }
  cached({ folder = 'INBOX', query = '' } = {}) { return this.cache()?.list(folder, query) || null; }

  // Bring cached labels up to date through Gmail's history feed. Returns false
  // when no baseline exists or Google expired it, so callers start a new one.
  async sync(cache) {
    if (!cache.historyId) return false;
    const revision = this.revision;
    let pageToken = '', latest = cache.historyId;
    try {
      do {
        const page = await this.request('/history', { query: { startHistoryId: cache.historyId, maxResults: 500, ...(pageToken ? { pageToken } : {}) } });
        if (revision !== this.revision) throw new GmailError('This account is no longer connected.', 'reconnect');
        for (const entry of page.history || []) {
          for (const { message } of entry.messagesDeleted || []) cache.remove(message.id);
          for (const kind of ['labelsAdded', 'labelsRemoved']) for (const change of entry[kind] || []) {
            const current = cache.meta[change.message.id];
            if (!current) continue;
            const labels = change.message.labelIds || (kind === 'labelsAdded' ? [...new Set([...current.labels, ...change.labelIds])] : current.labels.filter(label => !change.labelIds.includes(label)));
            cache.setLabels(change.message.id, labels);
          }
        }
        latest = String(page.historyId || latest);
        pageToken = page.nextPageToken || '';
      } while (pageToken);
    } catch (error) {
      if (error.code !== 'not_found') throw error;
      cache.resetMeta();
      return false;
    }
    cache.historyId = latest;
    return true;
  }

  profile() { return this.request('/profile'); }
  async list({ folder = 'INBOX', query = '', pageToken = '' } = {}) {
    const cache = this.cache();
    // Take the history baseline before reading metadata so no change is missed.
    if (!(await this.sync(cache))) cache.historyId = String((await this.profile()).historyId || '');
    const page = await this.request('/messages', { query: { maxResults: 25, ...(folder ? { labelIds: folder } : {}), q: query, ...(pageToken ? { pageToken } : {}) } });
    const ids = (page.messages || []).map(m => m.id);
    const missing = ids.filter(id => !cache.cachedMeta(id));
    // Keep small metadata requests bounded; no eager full-body downloads.
    for (let i = 0; i < missing.length; i += 5) {
      const batch = await Promise.all(missing.slice(i, i + 5).map(id => this.request(`/messages/${id}`, { query: { format: 'metadata' } }).then(parseMessage)));
      batch.forEach(message => cache.putMeta(message));
    }
    const messages = ids.map(id => cache.meta[id]).filter(Boolean).map(message => ({ ...message, body: '', html: '', attachments: [] }));
    if (!pageToken) cache.putList(folder, query, ids, page.nextPageToken || '', this.now());
    cache.save();
    return { messages, nextPageToken: page.nextPageToken || '', estimate: page.resultSizeEstimate || 0 };
  }
  async read(id) {
    const cache = this.cache();
    const cached = cache?.body(id);
    if (cached) return cached;
    const message = parseMessage(await this.request(`/messages/${id}`, { query: { format: 'full' } }));
    cache?.putMeta(message); cache?.putBody(message); cache?.save();
    return message;
  }
  // Mutations answer with the message's new labels; mirror them into the cache.
  async labelled(path, body = {}) {
    const result = await this.request(path, { method: 'POST', body });
    if (result?.id && Array.isArray(result.labelIds)) { const cache = this.cache(); cache?.setLabels(result.id, result.labelIds); cache?.save(); }
    return result;
  }
  modify(id, addLabelIds = [], removeLabelIds = []) { return this.labelled(`/messages/${id}/modify`, { addLabelIds, removeLabelIds }); }
  trash(id) { return this.labelled(`/messages/${id}/trash`); }
  untrash(id) { return this.labelled(`/messages/${id}/untrash`); }
  send(fields) {
    const raw = buildRawMessage({ ...fields, from: this.session?.email });
    return this.request('/messages/send', { method: 'POST', body: { raw, ...(fields.threadId ? { threadId: fields.threadId } : {}) } });
  }
  disconnect() { this.cache()?.clear(); this.mailCache = null; ++this.revision; this.session = null; this.refreshing = null; this.save(); }
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
const escapeHtml = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// TextView (gpui-base 0.7) drops <br> inside a paragraph and collapses
// newlines everywhere but <pre>, where a <pre> without <code> renders as plain
// wrapping text with links and emphasis intact. Carry each line break through
// a <pre> in the innermost block that has one. (Inside <pre> TextView keeps
// links but not bold or italic.)
const LINE_BLOCKS = 'p|div|td|th|h[1-6]';
const BLOCK_TAG = `<\\/?(?:${LINE_BLOCKS}|li|ul|ol|table|tr|tbody|thead|tfoot|blockquote|pre)\\b`;
// Matches only innermost blocks: the body may not open or close another block.
const INNERMOST = new RegExp(`<(${LINE_BLOCKS})\\b([^>]*)>((?:(?!${BLOCK_TAG})[\\s\\S])*?)<\\/\\1\\s*>`, 'gi');
export function keepLineBreaks(html) {
  return html.replace(INNERMOST, (whole, tag, attrs, inner) => {
    if (!/<br\b/i.test(inner)) return whole;
    const lines = inner.replace(/\s+/g, ' ').split(/<br\b[^>]*>/i).map(line => line.trim());
    while (lines.length && !lines.at(-1)) lines.pop();
    // A table cell clips a <pre> to its first line; keep its words apart instead.
    return /^t[dh]$/i.test(tag) ? `<${tag}${attrs}>${lines.join(' ')}</${tag}>` : `<pre>${lines.join('\n')}</pre>`;
  });
}

// TextView renders HTML natively without CSS or scripts. Drop what cannot
// render (or would render wrongly: hidden preheaders), and never load remote
// images, which senders use to track when a letter is opened.
export function emailHtml(value) {
  return keepLineBreaks(String(value || '')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/<!doctype[^>]*>/gi, '')
    .replace(/<(script|style|head|title|noscript|template|iframe|object|svg)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(script|style|link|meta|base|iframe|object|embed|input|button|form|source|video|audio)\b[^>]*>/gi, '')
    .replace(/<(\w+)\b[^>]*style\s*=\s*["'][^"']*(display\s*:\s*none|max-height\s*:\s*0|opacity\s*:\s*0)[^"']*["'][^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<img\b[^>]*>/gi, tag => { const alt = tag.match(/\balt\s*=\s*("([^"]*)"|'([^']*)')/i); const label = (alt?.[2] ?? alt?.[3] ?? '').trim(); return label ? `[${label}]` : ''; })
    .replace(/\s(on\w+|style|class|id|bgcolor|background)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/\shref\s*=\s*("\s*(?!https?:|mailto:)[^"]*"|'\s*(?!https?:|mailto:)[^']*'|(?!["']|https?:|mailto:)[^\s>]+)/gi, '')
    .trim());
}
// Plain-text letters keep their lines and indentation and gain clickable
// links; multi-line paragraphs go through <pre> for the reason above.
export function textHtml(value) {
  return String(value || '').replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/).map(paragraph => {
    const html = escapeHtml(paragraph.replace(/\s+$/gm, '')).replace(/\bhttps?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/g, url => `<a href="${url}">${url}</a>`);
    return html.includes('\n') ? `<pre>${html}</pre>` : `<p>${html}</p>`;
  }).join('');
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
      if (part.mimeType === 'text/html') html.push(decode64(part.body.data, charset));
    }
    (part.parts || []).forEach(walk);
  }
  walk(raw.payload);
  return { id: raw.id, threadId: raw.threadId, from, sender: from.replace(/\s*<[^>]+>/, '').replace(/^"|"$/g, '') || from, to: header('To'), replyTo: header('Reply-To') || from, subject: header('Subject') || '(No subject)', messageId: header('Message-ID'), references: header('References'), date: Number(raw.internalDate) || Date.parse(header('Date')) || 0, snippet: htmlToText(raw.snippet || ''), body: (plain.length ? plain : html.map(htmlToText)).join('\n\n'), html: html.length ? emailHtml(html.join('\n')) : plain.length ? textHtml(plain.join('\n\n')) : '', labels: raw.labelIds || [], unread: (raw.labelIds || []).includes('UNREAD'), starred: (raw.labelIds || []).includes('STARRED'), attachments };
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
