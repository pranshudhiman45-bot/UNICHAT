import { Node, mergeAttributes } from '@tiptap/core';

export interface MentionChipAttributes {
  id: string;
  label: string;
  username?: string | null;
}

export const MentionChip = Node.create({
  name: 'mention',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      id: { default: null },
      label: { default: '' },
      username: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-mention-id]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    const label = typeof node.attrs.label === 'string' && /^[a-f\d]{24}$/i.test(node.attrs.label) ? 'Unknown user' : (node.attrs.label || 'Unknown user');
    return ['span', mergeAttributes(HTMLAttributes, {
      'data-mention-id': node.attrs.id,
      'data-mention-label': label,
      class: 'mention-chip',
    }), `@${label}`];
  },
  renderText({ node }) {
    return `<@${node.attrs.id}>`;
  },
});

