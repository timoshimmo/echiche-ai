import type { PersistenceMode } from "@/lib/domain/types";
import { getServerConfig } from "./config";
import { MemoryRepository } from "./memory-repository";
import { PostgresRepository } from "./postgres-repository";
import type { EchicheRepository } from "./repository";

let memoryRepository: MemoryRepository | undefined;

/** Returns the configured repository. Throws ConfigError if configuration is invalid; never falls back silently. */
export function getRepository(): EchicheRepository {
  const config = getServerConfig();
  if (config.persistence === "postgres" && config.databaseUrl) return new PostgresRepository(config.databaseUrl);
  memoryRepository ??= new MemoryRepository();
  return memoryRepository;
}

/** Reflects validated configuration. Use /api/ready to learn whether storage is actually reachable. */
export function persistenceMode(): PersistenceMode {
  return getServerConfig().persistence;
}

/** Test helper: drop the in-memory store. */
export function resetRepositoryForTests(): void {
  memoryRepository = undefined;
}
