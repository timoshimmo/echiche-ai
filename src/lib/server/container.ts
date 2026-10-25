import { getServerConfig } from "./config";
import { PostgresStore } from "./postgres-repository";
import type { Store } from "./repository";

let override: Store | undefined;

/**
 * The configured Store. There is no in-memory runtime mode (removed in M2: it would
 * require an auth bypass). Throws ConfigError if configuration is invalid.
 * Routes call getStore().forOwner(user.id) with the ID from requireUser().
 */
export function getStore(): Store {
  return override ?? new PostgresStore(getServerConfig().databaseUrl);
}

/** Test helper: route tests inject a MemoryStore. Pass undefined to clear. */
export function setStoreForTests(store: Store | undefined): void {
  override = store;
}
