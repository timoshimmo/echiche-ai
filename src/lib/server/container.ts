import type { EchicheRepository } from "./repository";
import { MemoryRepository } from "./memory-repository";
import { PostgresRepository } from "./postgres-repository";

let memoryRepository: MemoryRepository | undefined;
export function getRepository(): EchicheRepository {
  if (process.env.DATABASE_URL) return new PostgresRepository();
  if (process.env.ALLOW_IN_MEMORY_DEMO === "false") {
    throw new Error("DATABASE_URL is required when ALLOW_IN_MEMORY_DEMO=false");
  }
  memoryRepository ??= new MemoryRepository();
  return memoryRepository;
}
export const persistenceMode = () => process.env.DATABASE_URL ? "postgres" : "in-memory-demo";
