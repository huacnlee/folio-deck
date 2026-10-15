// Web links in a reply's Markdown, for the bar under the transcript. Pure
// functions; the view owns opening them.

const FENCE = /^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm;
const CODE = /`[^`\n]*`/g;
const MARKDOWN = /\[([^\]\n]*)\]\(\s*<?(https?:\/\/[^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/gi;
const BARE = /<?\bhttps?:\/\/[^\s<>"'`]+/gi;

/** Whether a URL can open in the link pane: http or https with a host. */
export function isWebUrl(url) {
  return /^https?:\/\/[^/\s?#]+/i.test(String(url));
}

// A bare URL ends before closing punctuation, and before a `)` it did not open.
function trimBare(url) {
  let end = url.replace(/[.,;:!?'"*_~]+$/, '');
  while (end.endsWith(')') && (end.match(/\(/g) ?? []).length < (end.match(/\)/g) ?? []).length) end = end.slice(0, -1).replace(/[.,;:!?'"*_~]+$/, '');
  return end;
}

/**
 * The http(s) links in Markdown, in order and each URL once. `label` is the
 * link text, or the host and path of a bare URL. Code is skipped.
 * @param {string} markdown
 * @returns {{ url: string, label: string }[]}
 */
export function extractLinks(markdown) {
  const text = String(markdown ?? '').replace(FENCE, ' ').replace(CODE, ' ');
  const found = [];
  const rest = text.replace(MARKDOWN, (_match, label, url, offset) => {
    found.push({ offset, url, label: label.replace(/[*_`]/g, '').trim() });
    return ' '.repeat(_match.length);
  });
  for (const match of rest.matchAll(BARE)) found.push({ offset: match.index, url: trimBare(match[0].replace(/^</, '')), label: '' });
  const seen = new Set();
  return found.sort((a, b) => a.offset - b.offset).filter(({ url }) => isWebUrl(url) && !seen.has(url) && seen.add(url))
    .map(({ url, label }) => ({ url, label: label || shortUrl(url) }));
}

/** `host/path` without the scheme, `www.` or a trailing slash. */
export function shortUrl(url) {
  return String(url).replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
}
