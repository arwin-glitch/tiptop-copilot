/**
 * One value per server process. Next builds pages and route handlers into
 * separate bundles, each with its own copy of a module, so a module-level Map
 * would give /tasks and /api/tasks/version separate throttles and statuses.
 */
export function processWide<T>(name: string, create: () => T): T {
  const shared = globalThis as typeof globalThis & Record<symbol, T | undefined>;
  const key = Symbol.for(`tiptop-copilot:${name}`);
  return (shared[key] ??= create());
}
