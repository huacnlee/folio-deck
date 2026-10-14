// Conversations: the model, its grouping for the sidebar, and the file format
// they are saved in. Pure functions; the view owns reading and writing.

import { providerIds } from './providers.js';

const DAY = 86400000;

/** @param {string} provider @param {string} model @param {number} now @param {string} id */
export function newConversation(provider, model, now, id) {
  return { id, title: '', provider, model, sessions: {}, messages: [], createdAt: now, updatedAt: now };
}

/** A short title from the first message: its first line, cut at a word. */
export function titleFrom(text, max = 48) {
  const line = String(text).split('\n').map((part) => part.trim()).find(Boolean) ?? '';
  if (line.length <= max) return line || 'New chat';
  const cut = line.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The sidebar's title for a conversation. */
export const displayTitle = (conversation) => conversation.title || titleFrom(conversation.messages.find((message) => message.role === 'user')?.text ?? '');

/**
 * Conversations newest first, in the date groups chat applications use.
 * @param {{ updatedAt: number }[]} conversations
 * @param {number} now
 */
export function groupByDate(conversations, now) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const start = today.getTime();
  const groups = [
    { label: 'Today', items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'Previous 7 days', items: [] },
    { label: 'Older', items: [] },
  ];
  for (const conversation of [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const at = conversation.updatedAt;
    const group = at >= start ? 0 : at >= start - DAY ? 1 : at >= start - 7 * DAY ? 2 : 3;
    groups[group].items.push(conversation);
  }
  return groups.filter((group) => group.items.length);
}

/** Conversations whose title or messages contain every word of `query`. */
export function filterConversations(conversations, query) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return conversations;
  return conversations.filter((conversation) => {
    const haystack = `${displayTitle(conversation)}\n${conversation.messages.map((message) => message.text).join('\n')}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

export const FORMAT = 1;

/** @param {object[]} conversations */
export function serialize(conversations) {
  return JSON.stringify({ format: FORMAT, conversations }, null, 1);
}

const isText = (value) => typeof value === 'string';
const isTime = (value) => Number.isFinite(value) && value >= 0;

/**
 * Reads a saved file, keeping every well-formed conversation and message and
 * dropping the rest, so one damaged entry does not cost the whole history.
 * @param {string} text
 */
export function parseStore(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('The conversation file is not valid JSON.'); }
  if (!data || data.format !== FORMAT || !Array.isArray(data.conversations)) throw new Error('The conversation file has an unknown format.');
  const conversations = [];
  for (const item of data.conversations) {
    if (!item || !isText(item.id) || !providerIds.includes(item.provider) || !Array.isArray(item.messages)) continue;
    const messages = item.messages.filter((message) => message && isText(message.id) && (message.role === 'user' || message.role === 'assistant') && isText(message.text))
      .map((message) => ({
        id: message.id,
        role: message.role,
        text: message.text,
        ...(isText(message.thinking) && message.thinking ? { thinking: message.thinking } : {}),
        ...(providerIds.includes(message.provider) ? { provider: message.provider } : {}),
        ...(isText(message.model) && message.model ? { model: message.model } : {}),
        ...(isText(message.error) && message.error ? { error: message.error } : {}),
        ...(Number.isFinite(message.cost) ? { cost: message.cost } : {}),
        ...(isTime(message.durationMs) ? { durationMs: message.durationMs } : {}),
        ...(message.pending === true ? { pending: true } : {}),
        ...(message.interrupted === true ? { interrupted: true } : {}),
        ...(Number.isInteger(message.resumes) && message.resumes > 0 ? { resumes: message.resumes } : {}),
        ...(isTime(message.savedAt) ? { savedAt: message.savedAt } : {}),
        at: isTime(message.at) ? message.at : 0,
      }));
    const sessions = {};
    for (const provider of providerIds) if (isText(item.sessions?.[provider])) sessions[provider] = item.sessions[provider];
    conversations.push({
      id: item.id,
      title: isText(item.title) ? item.title : '',
      provider: item.provider,
      model: isText(item.model) ? item.model : '',
      sessions,
      messages,
      createdAt: isTime(item.createdAt) ? item.createdAt : 0,
      updatedAt: isTime(item.updatedAt) ? item.updatedAt : 0,
    });
  }
  return conversations;
}

export const RESUME_WINDOW = 120000;
export const MAX_RESUMES = 2;

/**
 * Marks the replies that were still being written when the app last stopped
 * (a reload, a crash, a quit) as interrupted, keeping what they had written.
 * Returns the conversation to continue on its own: the one whose reply was
 * saved moments ago, which is a reload rather than a chat left days ago.
 * @param {object[]} conversations
 * @param {number} now
 * @returns {string | null}
 */
export function markInterrupted(conversations, now) {
  let resume = null, newest = 0;
  for (const conversation of conversations) {
    const last = conversation.messages[conversation.messages.length - 1];
    for (const message of conversation.messages) {
      if (message.role !== 'assistant' || !(message.pending || (!message.text && !message.error))) continue;
      delete message.pending;
      message.interrupted = true;
      message.error = 'The reply was interrupted.';
      const at = message.savedAt ?? message.at ?? 0;
      if (message === last && now - at < RESUME_WINDOW && (message.resumes ?? 0) < MAX_RESUMES && at > newest) { resume = conversation.id; newest = at; }
    }
  }
  return resume;
}

/** "3.2 s", "1 min 4 s" */
export function formatDuration(ms) {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
}

/** "$0.021" */
export const formatCost = (usd) => `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(3)}`;
