const ADDRESS =
  /^\s*(?:[^<>,]*<\s*[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+\s*>|[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+)\s*$/;

/** "a@x.com, Jane <j@y.com>" -> validated list, or null when any part is not an address. */
export function parseAddresses(value: string, max = 20): string[] | null {
  const parts = value
    .split(/[,;]/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length > max || parts.some((p) => !ADDRESS.test(p))) return null;
  return parts;
}
