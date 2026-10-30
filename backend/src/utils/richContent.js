const MAX_RICH_CONTENT_LENGTH = 120000;

const allowedNodes = new Set(['doc', 'paragraph', 'text', 'mention', 'hardBreak', 'bulletList', 'orderedList', 'listItem', 'blockquote', 'codeBlock']);
const allowedMarks = new Set(['bold', 'italic', 'strike', 'code', 'link']);

function safeLink(href) {
  if (typeof href !== 'string' || href.length > 2048) return null;
  try {
    const url = new URL(href);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? href : null;
  } catch {
    return null;
  }
}

function normalizeMarks(marks) {
  if (!Array.isArray(marks)) return undefined;
  const normalized = marks.flatMap((mark) => {
    if (!mark || !allowedMarks.has(mark.type)) return [];
    if (mark.type === 'link') {
      const href = safeLink(mark.attrs?.href);
      return href ? [{ type: 'link', attrs: { href } }] : [];
    }
    return [{ type: mark.type }];
  });
  return normalized.length ? normalized : undefined;
}

function normalizeNode(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40 || !allowedNodes.has(node.type)) return null;
  if (node.type === 'mention') {
    const id = typeof node.attrs?.id === 'string' && /^[a-f\d]{24}$/i.test(node.attrs.id) ? node.attrs.id.toLowerCase() : null;
    const label = typeof node.attrs?.label === 'string' ? node.attrs.label.trim().slice(0, 120) : '';
    const username = typeof node.attrs?.username === 'string' ? node.attrs.username.trim().slice(0, 80) : null;
    if (!id || !label) return null;
    const marks = normalizeMarks(node.marks);
    return { type: 'mention', attrs: { id, label, ...(username ? { username } : {}) }, ...(marks ? { marks } : {}) };
  }
  if (node.type === 'text') {
    if (typeof node.text !== 'string' || !node.text) return null;
    const marks = normalizeMarks(node.marks);
    return { type: 'text', text: node.text.slice(0, 40000), ...(marks?.length ? { marks } : {}) };
  }
  const content = Array.isArray(node.content) ? node.content.map((child) => normalizeNode(child, depth + 1)).filter(Boolean) : [];
  if (node.type === 'hardBreak') return { type: 'hardBreak' };
  if (node.type === 'codeBlock') return { type: 'codeBlock', content };
  if (node.type === 'orderedList') return { type: 'orderedList', content };
  return { type: node.type, ...(content.length ? { content } : {}) };
}

function normalizeRichContent(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > MAX_RICH_CONTENT_LENGTH) return null;
  let parsed;
  try { parsed = JSON.parse(value); } catch { return null; }
  const normalized = normalizeNode(parsed);
  return normalized?.type === 'doc' ? normalized : null;
}

function richContentToText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text || '';
  if (node.type === 'mention') return `<@${node.attrs?.id}>`;
  if (node.type === 'hardBreak') return '\n';
  const text = (node.content || []).map(richContentToText).join('');
  return ['paragraph', 'listItem', 'blockquote', 'codeBlock'].includes(node.type) ? `${text}\n` : text;
}

module.exports = { MAX_RICH_CONTENT_LENGTH, normalizeRichContent, richContentToText };
