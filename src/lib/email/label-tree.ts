import type { MailLabel } from '@/lib/email/inbox-actions';

/**
 * Gmail nests a label under another by its name: "Clients/Acme" sits under
 * "Clients". This turns the flat label list into that tree for the left nav,
 * where each row shows only its own part of the name ("Acme"). A level that
 * is not itself a label gets no row of its own, as in Gmail: it is folded
 * into its children, so "a/b/c" with no "a/b" label sits under "a" as "b/c".
 */
export interface LabelNode {
  /** The full name up to this row ("Clients/Acme"): unique, used as the key. */
  path: string;
  /** This row's own part of the name ("Acme"). */
  name: string;
  /** The Gmail label at this path (null only for a childless leftover, never shown). */
  label: MailLabel | null;
  depth: number;
  children: LabelNode[];
}

const byName = (a: LabelNode, b: LabelNode) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

export function labelTree(labels: readonly MailLabel[]): LabelNode[] {
  const nodes = new Map<string, LabelNode>();
  const roots: LabelNode[] = [];
  const nodeAt = (parts: string[]): LabelNode => {
    const path = parts.join('/');
    const known = nodes.get(path);
    if (known) return known;
    const node: LabelNode = {
      path,
      name: parts[parts.length - 1]!,
      label: null,
      depth: parts.length - 1,
      children: [],
    };
    nodes.set(path, node);
    if (parts.length === 1) roots.push(node);
    else nodeAt(parts.slice(0, -1)).children.push(node);
    return node;
  };
  for (const label of labels) {
    // Empty parts ("a//b", a trailing "/") are not levels in Gmail either.
    const parts = label.name.split('/').filter((p) => p !== '');
    if (parts.length === 0) continue;
    const node = nodeAt(parts);
    if (!node.label) node.label = label;
  }
  // Gmail shows no row for a level that isn't a label itself: "a/b/c" with no
  // "a/b" label sits under "a" as "b/c". Fold each such level into its children.
  const fold = (list: LabelNode[], depth: number): LabelNode[] =>
    list.flatMap((n) => {
      if (n.label || n.children.length === 0) {
        n.depth = depth;
        n.children = fold(n.children, depth + 1);
        return [n];
      }
      return fold(
        n.children.map((c) => ({ ...c, name: `${n.name}/${c.name}` })),
        depth,
      );
    });
  const tree = fold(roots, 0);
  const sort = (list: LabelNode[]) => {
    list.sort(byName);
    for (const n of list) sort(n.children);
  };
  sort(tree);
  return tree;
}

/** The paths above a label ("a", "a/b" for "a/b/c"), opened so the current folder is in view. */
export function ancestorPaths(name: string): string[] {
  const parts = name.split('/').filter((p) => p !== '');
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
}

/**
 * What a chip says, as Gmail shortens a deep label: "@/…/Intro Requests" for
 * "@/@Deals to Review/Intro Requests"; two levels or fewer stay whole.
 */
export function chipText(name: string): string {
  const parts = name.split('/').filter((p) => p !== '');
  return parts.length > 2 ? `${parts[0]}/…/${parts[parts.length - 1]}` : name;
}

/** Label name -> its Gmail colour, for the chips on rows and in a conversation. */
export function colorsByName(
  labels: readonly MailLabel[],
): ReadonlyMap<string, { bg: string; fg: string }> {
  const map = new Map<string, { bg: string; fg: string }>();
  for (const l of labels) if (l.color) map.set(l.name, l.color);
  return map;
}
