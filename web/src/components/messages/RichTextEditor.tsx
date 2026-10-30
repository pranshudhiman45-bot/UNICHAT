import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import Placeholder from '@tiptap/extension-placeholder';
import type { JSONContent } from '@tiptap/core';
import type { User } from '../../types';
import MentionAutocomplete, { type MentionAnchor } from '../mentions/MentionAutocomplete';
import { MentionChip } from './MentionChip';
import { getUserDisplayName } from '../../utils/userDisplay';

export interface RichTextValue {
  text: string;
  json: JSONContent;
}

interface MentionTriggerRequest {
  id: number;
  range: { from: number; to: number };
}

interface EmojiInsertRequest {
  id: number;
  range: { from: number; to: number };
  emoji: string;
}

interface Props {
  initialContent?: string;
  placeholder: string;
  disabled?: boolean;
  members?: User[];
  toolbarOpen?: boolean;
  autoFocus?: boolean;
  contextMemberIds?: string[];
  contextType?: 'channel' | 'dm';
  mentionTriggerRequest?: MentionTriggerRequest | null;
  emojiInsertRequest?: EmojiInsertRequest | null;
  onChange: (value: RichTextValue) => void;
  onSubmit?: () => void;
  onTyping?: (typing: boolean) => void;
  onEditorReady?: (editor: Editor) => void;
  onCancel?: () => void;
}

function hydrateMentionText(node: JSONContent, members: User[]): JSONContent | JSONContent[] {
  if (node.type !== 'text' || !node.text) return node;
  const tokenRegex = /<@([a-f\d]{24})>/gi;
  const result: JSONContent[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(node.text))) {
    if (match.index > cursor) result.push({ type: 'text', text: node.text.slice(cursor, match.index), marks: node.marks });
    const user = members.find((member) => member._id.toLowerCase() === match?.[1].toLowerCase());
    if (!user) {
      result.push({ type: 'text', text: match[0], marks: node.marks });
    } else {
      result.push({ type: 'mention', attrs: { id: user._id, label: getUserDisplayName(user), username: user.username } });
    }
    cursor = match.index + match[0].length;
  }
  if (!result.length) return node;
  if (cursor < node.text.length) result.push({ type: 'text', text: node.text.slice(cursor), marks: node.marks });
  return result;
}

function hydrateMentions(node: JSONContent, members: User[]): JSONContent {
  if (node.type === 'mention') {
    const user = members.find((member) => member._id.toLowerCase() === String(node.attrs?.id || '').toLowerCase());
    const storedLabel = typeof node.attrs?.label === 'string' && /^[a-f\d]{24}$/i.test(node.attrs.label) ? 'Unknown user' : node.attrs?.label;
    return { ...node, attrs: { ...node.attrs, label: user ? getUserDisplayName(user) : (storedLabel || 'Unknown user') } };
  }
  const content = node.content?.flatMap((child) => {
    const hydrated = hydrateMentions(child, members);
    return Array.isArray(hydrated) ? hydrated : [hydrated];
  });
  if (node.type === 'text') return hydrateMentionText(node, members) as JSONContent;
  return { ...node, ...(content ? { content } : {}) };
}

function parseInitialContent(initialContent: string | undefined, members: User[]): JSONContent | string | undefined {
  if (!initialContent) return undefined;
  try {
    const parsed = JSON.parse(initialContent) as JSONContent;
    return parsed?.type === 'doc' ? hydrateMentions(parsed, members) : initialContent;
  } catch {
    return initialContent;
  }
}

function mentionContext(editor: Editor) {
  const { $from } = editor.state.selection;
  const before = $from.parent.textBetween(0, $from.parentOffset, '\n');
  const match = before.match(/(?:^|\s)@([a-zA-Z0-9_.-]*)$/);
  if (!match) return null;
  const localStart = (match.index ?? 0) + (match[0].startsWith(' ') ? 1 : 0);
  return { from: $from.pos - (before.length - localStart), to: $from.pos, query: match[1] };
}

function getMentionAnchor(editor: Editor, nextMention: ReturnType<typeof mentionContext>): MentionAnchor | null {
  if (!nextMention) return null;
  try {
    const caret = editor.view.coordsAtPos(editor.state.selection.from);
    return { left: caret.left, right: caret.right, top: caret.top, bottom: caret.bottom };
  } catch {
    return null;
  }
}

function FormatButton({ label, title, active, onClick }: { label: string; title: string; active?: boolean; onClick: () => void }) {
  return <button type="button" onMouseDown={(event) => { event.preventDefault(); onClick(); }} className={`h-7 min-w-7 px-1.5 text-xs font-semibold ${active ? 'bg-indigo-50 text-[var(--accent)]' : 'text-slate-500 hover:bg-slate-50 hover:text-[var(--accent)]'}`} aria-label={title} title={title}>{label}</button>;
}

export function FormattingToolbar({ editor }: { editor: Editor }) {
  return <div className="composer-formatting-toolbar flex flex-wrap items-center gap-0.5 border-b border-slate-100 bg-slate-50 px-2 py-1" role="toolbar" aria-label="Text formatting">
    <FormatButton label="B" title="Bold" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} />
    <FormatButton label="I" title="Italic" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} />
    <FormatButton label="S" title="Strikethrough" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()} />
    <FormatButton label="</>" title="Inline code" active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()} />
    <FormatButton label="• list" title="Bulleted list" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()} />
    <FormatButton label="1. list" title="Numbered list" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()} />
    <FormatButton label="❝" title="Blockquote" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()} />
    <FormatButton label="Code" title="Code block" active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()} />
    <FormatButton label="Link" title="Add link" active={editor.isActive('link')} onClick={() => { const href = window.prompt('Paste a safe http(s) link'); if (href) editor.chain().focus().setLink({ href }).run(); }} />
    {editor.isActive('link') && <FormatButton label="Unlink" title="Remove link" onClick={() => editor.chain().focus().unsetLink().run()} />}
  </div>;
}

export default function RichTextEditor({ initialContent, placeholder, disabled = false, members = [], toolbarOpen = false, autoFocus = false, contextMemberIds = [], contextType, mentionTriggerRequest, emojiInsertRequest, onChange, onSubmit, onTyping, onEditorReady, onCancel }: Props) {
  const [mention, setMention] = useState<{ from: number; to: number; query: string } | null>(null);
  const [mentionAnchor, setMentionAnchor] = useState<MentionAnchor | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const handledMentionTriggerId = useRef(0);
  const handledEmojiInsertId = useRef(0);
  const initial = useMemo(() => parseInitialContent(initialContent, members), [initialContent, members]);
  const editor = useEditor({
    extensions: [
      MentionChip,
      StarterKit.configure({ heading: false }),
      Underline,
      Link.configure({ openOnClick: false, autolink: true, protocols: ['http', 'https', 'mailto'] }),
      Placeholder.configure({ placeholder }),
    ],
    content: initial,
    autofocus: autoFocus ? 'end' : false,
    editable: !disabled,
    onCreate: ({ editor: created }) => onEditorReady?.(created),
    onUpdate: ({ editor: updated }) => {
      onChange({ text: updated.getText({ blockSeparator: '\n' }), json: updated.getJSON() });
      const nextMention = mentionContext(updated);
      setMention(nextMention);
      setMentionAnchor(getMentionAnchor(updated, nextMention));
      setMentionIndex(0);
      onTyping?.(!updated.isEmpty);
    },
    onSelectionUpdate: ({ editor: updated }) => { const nextMention = mentionContext(updated); setMention(nextMention); setMentionAnchor(getMentionAnchor(updated, nextMention)); },
  });

  useEffect(() => { if (editor) editor.setEditable(!disabled); }, [editor, disabled]);
  useEffect(() => {
    if (!editor || !mentionTriggerRequest || mentionTriggerRequest.id <= handledMentionTriggerId.current) return;
    handledMentionTriggerId.current = mentionTriggerRequest.id;

    const { from, to } = mentionTriggerRequest.range;
    const safeFrom = Math.max(1, Math.min(from, editor.state.doc.content.size));
    const safeTo = Math.max(safeFrom, Math.min(to, editor.state.doc.content.size));
    const $from = editor.state.doc.resolve(safeFrom);
    const textBeforeCaret = $from.parent.textBetween(0, $from.parentOffset, '\n');
    const trigger = textBeforeCaret && !/\s$/.test(textBeforeCaret) ? ' @' : '@';

    editor.chain()
      .focus()
      .insertContentAt({ from: safeFrom, to: safeTo }, trigger)
      .setTextSelection(safeFrom + trigger.length)
      .run();

    const nextMention = mentionContext(editor);
    setMention(nextMention);
    setMentionAnchor(getMentionAnchor(editor, nextMention));
    setMentionIndex(0);
  }, [editor, mentionTriggerRequest]);
  useEffect(() => {
    if (!editor || !emojiInsertRequest || emojiInsertRequest.id <= handledEmojiInsertId.current) return;
    handledEmojiInsertId.current = emojiInsertRequest.id;

    const { from, to } = emojiInsertRequest.range;
    const safeFrom = Math.max(1, Math.min(from, editor.state.doc.content.size));
    const safeTo = Math.max(safeFrom, Math.min(to, editor.state.doc.content.size));
    editor.chain()
      .focus()
      .insertContentAt({ from: safeFrom, to: safeTo }, { type: 'text', text: emojiInsertRequest.emoji })
      .setTextSelection(safeFrom + emojiInsertRequest.emoji.length)
      .run();
  }, [editor, emojiInsertRequest]);
  useEffect(() => () => onTyping?.(false), []);

  const mentionUsers = useMemo(() => {
    if (!mention) return [];
    const query = mention.query.toLowerCase();
    const contextIds = new Set(contextMemberIds.map(String));
    return members
      .filter((user) => `${getUserDisplayName(user)} ${user.username}`.toLowerCase().includes(query))
      .sort((left, right) => Number(contextIds.has(right._id)) - Number(contextIds.has(left._id)) || getUserDisplayName(left).localeCompare(getUserDisplayName(right)))
      .slice(0, 20);
  }, [contextMemberIds, members, mention]);
  const selectMention = (user: User) => {
    if (!editor || !mention) return;
    editor.chain().focus().deleteRange({ from: mention.from, to: mention.to }).insertContent([
      { type: 'mention', attrs: { id: user._id, label: getUserDisplayName(user), username: user.username } },
      { type: 'text', text: ' ' },
    ]).run();
    setMention(null); setMentionAnchor(null);
  };

  if (!editor) return <div className="min-h-16" aria-label={placeholder} />;
  return <div className="relative">
    {toolbarOpen && <FormattingToolbar editor={editor} />}
    {mention && mentionAnchor && <MentionAutocomplete users={mentionUsers} activeIndex={mentionIndex} anchor={mentionAnchor} contextMemberIds={contextMemberIds} contextType={contextType} onSelect={selectMention} onDismiss={() => { setMention(null); setMentionAnchor(null); }} />}
    <EditorContent editor={editor} className="rich-editor-content" onKeyDownCapture={(event) => {
      if (mentionUsers.length > 0 && event.key === 'ArrowDown') { event.preventDefault(); setMentionIndex((index) => (index + 1) % mentionUsers.length); return; }
      if (mentionUsers.length > 0 && event.key === 'ArrowUp') { event.preventDefault(); setMentionIndex((index) => (index - 1 + mentionUsers.length) % mentionUsers.length); return; }
      if (mentionUsers.length > 0 && event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); selectMention(mentionUsers[mentionIndex]); return; }
      if (mentionUsers.length > 0 && event.key === 'Escape') { event.preventDefault(); setMention(null); setMentionAnchor(null); return; }
      if (event.key === 'Escape' && onCancel) { event.preventDefault(); onCancel(); return; }
      if (event.key === 'Enter' && !event.shiftKey && onSubmit) { event.preventDefault(); onSubmit(); }
    }} />
  </div>;
}
