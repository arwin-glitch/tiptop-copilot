import { describe, expect, it } from 'vitest';
import { ancestorPaths, chipText, colorsByName, labelTree } from '@/lib/email/label-tree';

const L = (id: string, name: string, color?: { bg: string; fg: string }) =>
  color ? { id, name, color } : { id, name };

describe('labelTree', () => {
  it('nests by "/" and shows only each row its own part of the name', () => {
    const tree = labelTree([
      L('Label_1', '@'),
      L('Label_2', '@/@For Team'),
      L('Label_3', '@/@For Team/Acme'),
      L('Label_4', '@/@For Team/Beta/no'),
      L('Label_5', '@/@Jobs'),
    ]);
    expect(tree).toHaveLength(1);
    const root = tree[0]!;
    expect(root.name).toBe('@');
    expect(root.children.map((c) => c.name)).toEqual(['@For Team', '@Jobs']);
    const team = root.children[0]!;
    expect(team.depth).toBe(1);
    expect(team.children.map((c) => c.name)).toEqual(['Acme', 'Beta']);
    // "Beta" is not a label itself: a parent row so "no" has somewhere to sit.
    const beta = team.children[1]!;
    expect(beta.label).toBeNull();
    expect(beta.children[0]).toMatchObject({ name: 'no', depth: 3, path: '@/@For Team/Beta/no' });
    expect(beta.children[0]!.label?.id).toBe('Label_4');
  });

  it('sorts siblings the way Gmail does, numbers in order', () => {
    const tree = labelTree([
      L('a', '10: Later'),
      L('b', '2: Week'),
      L('c', 'alpha'),
      L('d', 'Beta'),
    ]);
    expect(tree.map((n) => n.name)).toEqual(['2: Week', '10: Later', 'alpha', 'Beta']);
  });

  it('ignores empty parts of a name', () => {
    const tree = labelTree([L('a', 'x//y/'), L('b', '/')]);
    expect(tree.map((n) => n.path)).toEqual(['x']);
    expect(tree[0]!.children[0]!.path).toBe('x/y');
  });
});

describe('ancestorPaths and colorsByName', () => {
  it('lists the parents of a nested label', () => {
    expect(ancestorPaths('a/b/c')).toEqual(['a', 'a/b']);
    expect(ancestorPaths('solo')).toEqual([]);
  });

  it('maps names to Gmail colours, skipping labels without one', () => {
    const map = colorsByName([L('a', 'Red', { bg: '#fb4c2f', fg: '#ffffff' }), L('b', 'Plain')]);
    expect(map.get('Red')).toEqual({ bg: '#fb4c2f', fg: '#ffffff' });
    expect(map.has('Plain')).toBe(false);
  });
});

describe('chipText', () => {
  it('shortens a deep label the way Gmail does', () => {
    expect(chipText('@/@Deals to Review/Intro Requests')).toBe('@/…/Intro Requests');
    expect(chipText('@/@Follow up')).toBe('@/@Follow up');
    expect(chipText('Portfolio')).toBe('Portfolio');
  });
});
