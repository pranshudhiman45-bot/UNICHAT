import assert from 'node:assert/strict';
import test from 'node:test';
import { getWorkspaceInitials, getWorkspaceAvatarColor, getWorkspaceAvatarDesign, getWorkspaceImageUrl, WORKSPACE_AVATAR_COLORS } from './workspaceAvatar.ts';

test('workspace initials handle one, two, and many words', () => {
  for (const [name, expected] of [
    ['Testing', 'T'], ['Unichat', 'U'], ['Marketing Team', 'MT'],
    ['The Spanish Group', 'TG'], ['New Product Development Team', 'NT'],
    ['  Marketing   Team  ', 'MT'], ['A', 'A'], ['123 Company', '1C'],
    ['#Développement  東京!', 'D東'], ['🧪 Testing', 'T'], ['🤝✨', ''], ['', ''],
    ['ß Team', 'ST'],
  ]) assert.equal(getWorkspaceInitials(name), expected, name);
  assert.equal(getWorkspaceInitials(null), '');
});

test('workspace color is stable, normalized, and from approved palette', () => {
  for (const name of ['Testing', 'Unichat', 'Marketing Team', '東京', '🤝✨', '']) {
    const color = getWorkspaceAvatarColor(name);
    assert.ok(WORKSPACE_AVATAR_COLORS.includes(color), name);
    assert.equal(getWorkspaceAvatarColor(name), color);
  }
  assert.equal(getWorkspaceAvatarColor('  Marketing   Team  '), getWorkspaceAvatarColor('marketing team'));
});

test('custom icon image URL detection keeps legacy text icons and rejects unsafe schemes', () => {
  assert.equal(getWorkspaceImageUrl('https://example.com/logo.png'), 'https://example.com/logo.png');
  assert.equal(getWorkspaceImageUrl('🎨'), null);
  assert.equal(getWorkspaceImageUrl('javascript:alert(1)'), null);
  assert.equal(getWorkspaceImageUrl(null), null);
});

test('workspace-related motifs and gradients are stable', () => {
  for (const [name, expected] of [
    ['Unichat', 'chat'], ['Marketing Team', 'megaphone'],
    ['Development Team', 'code'], ['Testing', 'check'],
    ['The Spanish Group', 'people'], ['Design Studio', 'palette'],
    ['Finance', 'chart'], ['Learning Center', 'book'],
    ['Health Team', 'leaf'], ['Acme', 'initials'],
  ]) {
    const design = getWorkspaceAvatarDesign(name);
    assert.equal(design.motif, expected, name);
    assert.equal(design.startColor, getWorkspaceAvatarColor(name));
    assert.match(design.endColor, /^#[0-9A-F]{6}$/);
    assert.deepEqual(getWorkspaceAvatarDesign(name), design);
  }
  assert.deepEqual(getWorkspaceAvatarDesign('  Marketing   Team '), getWorkspaceAvatarDesign('marketing team'));
});
