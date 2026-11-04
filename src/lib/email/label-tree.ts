import type { MailLabel } from '@/lib/email/inbox-actions';

/**
 * Gmail nests a label under another by its name: "Clients/Acme" sits under
 * "Clients". This turns the flat label list into that tree for the left nav,
 * where each row shows only its own part of the name ("Acme"). A parent that
 * is not itself a label (Gmail normally makes one, but a mailbox can lack it)
 * still appears, so its children have somewhere to sit; it just can't be
 * opened as a folder.
 */
export interface LabelNode {
  /** The full name up to this row ("Clients/Acme"): unique, used as the key. */
  path: string;
  /** This row's own part of the name ("Acme"). */
  name: string;
  /** The Gmail label at this path, or null for a parent that isn't one. */
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
  const sort = (list: LabelNode[]) => {
    list.sort(byName);
    for (const n of list) sort(n.children);
  };
  sort(roots);
  return roots;
}

/** The paths above a label ("a", "a/b" for "a/b/c"), opened so the current folder is in view. */
export function ancestorPaths(name: string): string[] {
  const parts = name.split('/').filter((p) => p !== '');
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
}

/** Label name -> its Gmail colour, for the chips on rows and in a conversation. */
export function colorsByName(
  labels: readonly MailLabel[],
): ReadonlyMap<string, { bg: string; fg: string }> {
  const map = new Map<string, { bg: string; fg: string }>();
  for (const l of labels) if (l.color) map.set(l.name, l.color);
  return map;
}
