import type { ReactNode } from 'react';
import type { JSONContent } from '@tiptap/core';
import type { Message, User } from '../../types';
import MentionText from '../mentions/MentionText';
import { getUserDisplayName } from '../../utils/userDisplay';

function parseContent(value?: string): JSONContent | null {
  if (!value) return null;
  try { const parsed = JSON.parse(value) as JSONContent; return parsed?.type === 'doc' ? parsed : null; } catch { return null; }
}

function inlineNode(node: JSONContent, key: string, message: Message, members: User[]): ReactNode {
  if (node.type === 'hardBreak') return <br key={key} />;
  let result: ReactNode;
  if (node.type === 'mention') {
    const user = members.find((member) => member._id === node.attrs?.id);
    const storedLabel = typeof node.attrs?.label === 'string' && /^[a-f\d]{24}$/i.test(node.attrs.label) ? 'Unknown user' : node.attrs?.label;
    const label = user ? getUserDisplayName(user) : (storedLabel || 'Unknown user');
    result = <span className="mention-chip mention-chip-message">@{label}</span>;
  } else if (node.type === 'text') {
    result = <MentionText content={node.text || ''} mentions={message.mentions} members={members} />;
  } else {
    return blockNode(node, key, message, members);
  }
  (node.marks || []).forEach((mark) => {
    if (mark.type === 'bold') result = <strong key={`${key}-b`}>{result}</strong>;
    if (mark.type === 'italic') result = <em key={`${key}-i`}>{result}</em>;
    if (mark.type === 'strike') result = <s key={`${key}-s`}>{result}</s>;
    if (mark.type === 'code') result = <code key={`${key}-c`} className="rounded bg-[var(--bg-surface-secondary)] px-1 font-mono text-[0.9em]">{result}</code>;
    if (mark.type === 'link' && typeof mark.attrs?.href === 'string') result = <a key={`${key}-l`} href={mark.attrs.href} target="_blank" rel="noreferrer" className="text-[var(--accent)] underline">{result}</a>;
  });
  return <span key={key}>{result}</span>;
}

function blockNode(node: JSONContent, key: string, message: Message, members: User[]): ReactNode {
  const children = (node.content || []).map((child, index) => inlineNode(child, `${key}-${index}`, message, members));
  if (node.type === 'paragraph') return <p key={key} className="mb-1 last:mb-0">{children}</p>;
  if (node.type === 'blockquote') return <blockquote key={key} className="my-1 border-l-2 border-[var(--border-color)] pl-3 text-[var(--text-secondary)]">{children}</blockquote>;
  if (node.type === 'bulletList') return <ul key={key} className="my-1 list-disc pl-5">{children}</ul>;
  if (node.type === 'orderedList') return <ol key={key} className="my-1 list-decimal pl-5">{children}</ol>;
  if (node.type === 'listItem') return <li key={key}>{children}</li>;
  if (node.type === 'codeBlock') return <pre key={key} className="my-1 overflow-x-auto rounded bg-slate-900 p-2 font-mono text-xs text-slate-100">{children}</pre>;
  return <span key={key}>{children}</span>;
}

export default function RichMessageContent({ message, members }: { message: Message; members: User[] }) {
  const document = parseContent(message.formattedContent);
  if (!document) return <p className="whitespace-pre-wrap break-words text-sm leading-5 text-[var(--text-primary)]"><MentionText content={message.content} mentions={message.mentions} members={members} /></p>;
  return <div className="break-words text-sm leading-5 text-[var(--text-primary)]">{(document.content || []).map((node, index) => blockNode(node, String(index), message, members))}</div>;
}
