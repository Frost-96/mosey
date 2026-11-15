// Longest-first assignment uses timing only for placement, never selection.
// Stable ties make every shard derive the same partition, even when discovery
// order differs. Unknown/new tests remain in the discovered input inventory.
// `reserved` seconds account for non-test work a shard performs (packaging).
export function balance<T>(
  items: readonly T[],
  count: number,
  seconds: (item: T) => number,
  identity: (item: T) => string,
  reserved: readonly number[] = [],
): T[][] {
  if (!Number.isInteger(count) || count < 1)
    throw new Error("Shard count must be a positive integer");
  const buckets = Array.from({ length: count }, (_, index) => ({
    items: [] as T[],
    seconds: reserved[index] ?? 0,
  }));
  const ordered = [...items].sort(
    (a, b) =>
      seconds(b) - seconds(a) || identity(a).localeCompare(identity(b), "en"),
  );
  for (const item of ordered) {
    const bucket = buckets.reduce((least, next) =>
      next.seconds < least.seconds ? next : least,
    );
    bucket.items.push(item);
    bucket.seconds += seconds(item);
  }
  return buckets.map((bucket) => bucket.items);
}
