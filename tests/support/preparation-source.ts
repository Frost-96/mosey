import { AsyncLocalStorage } from "node:async_hooks";
import type { PreparedApplication } from "./preparation";

const sources = new AsyncLocalStorage<PreparedApplication>();

// Producer callbacks retain their existing scoped operation API. Their native
// source must follow the lease even after an await or a checkout edit.
export function withPreparationSource<T>(
  source: PreparedApplication,
  action: () => T,
): T {
  return sources.run(source, action);
}

export function preparationSource() {
  const source = sources.getStore();
  if (!source)
    throw new Error("Native fixture requires a borrowed preparation source");
  return source;
}
