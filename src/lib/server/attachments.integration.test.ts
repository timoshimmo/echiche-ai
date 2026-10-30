import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { PreparedAttachment, RunBudget } from "@/lib/domain/types";
import { adminSql, createTestUser, resetData } from "@/test/db";
import { prepareFile, prepareLink } from "./attachments";
import { closePostgresClients, PostgresStore } from "./postgres-repository";
import { IdempotencyConflictError } from "./repository";

const admin = adminSql();
const store = new PostgresStore(process.env.DATABASE_URL!);
const BUDGET: RunBudget = { maxSteps: 18, maxActiveSeconds: 600, maxResearchCalls: 8, maxCostUsd: 0.5 };
const OPTS = { maxPerHour: 100, budget: BUDGET, spend: { userDailyUsd: 1000, globalDailyUsd: 10000 } };
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4e00000000049454e44ae426082", "hex");
let alice: string;
let bob: string;

beforeEach(async () => {
  await resetData(admin);
  alice = await createTestUser(admin);
  bob = await createTestUser(admin);
});
afterAll(async () => {
  await resetData(admin);
  await admin.end({ timeout: 5 });
  await closePostgresClients();
});

async function attachments(): Promise<PreparedAttachment[]> {
  return [
    await prepareFile("plan.md", Buffer.from("Confidential: runway is 14 months."), 1),
    await prepareFile("board.png", PNG, 2),
    prepareLink("https://example.org/market", 3)
  ];
}

describe("run attachments on real Postgres (ADR-012, RLS as echiche_web)", () => {
  it("stores attachments with the run, returns only names and status, and exports the extracted text", async () => {
    const repo = store.forOwner(alice);
    const project = await repo.createProject({ title: "Office", problemStatement: "Open a second office or not?" }, 100);
    const { run } = (await repo.createRun(project.id, { prompt: "Should we open a second office?", depth: "quick", attachments: await attachments() }, OPTS))!;
    expect(run.attachments.map(a => [a.position, a.kind, a.name, a.status])).toEqual([
      [1, "text", "plan.md", "ready"], [2, "image", "board.png", "pending"], [3, "link", "example.org/market", "pending"]
    ]);
    expect(JSON.stringify(await repo.getRun(run.id))).not.toContain("runway is 14 months");
    expect(run.route.tier).toBe("medium");
    const [image] = await admin`select octet_length(image_data) as n from echiche.run_attachments where run_id = ${run.id} and kind = 'image'`;
    expect(image.n).toBe(PNG.length);
    const exported = (await repo.exportProject(project.id))!;
    const runs = exported.runs as { attachments: { name: string; extractedText: string | null }[] }[];
    expect(runs[0].attachments[0]).toMatchObject({ name: "plan.md", extractedText: "Confidential: runway is 14 months." });
    expect(JSON.stringify(exported)).not.toMatch(/image_data|iVBOR/);
  });

  it("gives other owners nothing, and an end user cannot add attachments to a run that has started", async () => {
    const repo = store.forOwner(alice);
    const project = await repo.createProject({ title: "Office", problemStatement: "Open a second office or not?" }, 100);
    const { run } = (await repo.createRun(project.id, { prompt: "Should we open a second office?", attachments: await attachments() }, OPTS))!;
    expect(await store.forOwner(bob).getRun(run.id)).toBeNull();
    await admin`update echiche.thought_runs set status = 'planning' where id = ${run.id}`;
    const claims = JSON.stringify({ sub: alice, role: "authenticated" });
    const web = (await import("postgres")).default(process.env.DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
    try {
      await expect(web.begin(async tx => {
        await tx`select set_config('request.jwt.claims', ${claims}, true)`;
        await tx.unsafe("set local role echiche_end_user");
        await tx`insert into echiche.run_attachments (owner_user_id, run_id, position, kind, name, content_sha256, status, extracted_text)
                 values (${alice}, ${run.id}, 4, 'text', 'late.txt', ${"b".repeat(64)}, 'ready', 'late')`;
      })).rejects.toThrow(/row-level security/);
      await expect(web.begin(async tx => {
        await tx`select set_config('request.jwt.claims', ${claims}, true)`;
        await tx.unsafe("set local role echiche_end_user");
        await tx`update echiche.run_attachments set name = 'renamed' where run_id = ${run.id}`;
      })).rejects.toThrow(/permission denied/);
    } finally {
      await web.end({ timeout: 5 });
    }
  });

  it("treats a retry with the same key but different attachments as a conflict", async () => {
    const repo = store.forOwner(alice);
    const project = await repo.createProject({ title: "Office", problemStatement: "Open a second office or not?" }, 100);
    const options = { ...OPTS, idempotencyKey: "attach-retry-0001" };
    const one = [await prepareFile("a.txt", Buffer.from("one"), 1)];
    const first = (await repo.createRun(project.id, { prompt: "Same question again", attachments: one }, options))!;
    const replay = (await repo.createRun(project.id, { prompt: "Same question again", attachments: one }, options))!;
    expect(replay).toMatchObject({ created: false, run: { id: first.run.id } });
    const two = [await prepareFile("a.txt", Buffer.from("two"), 1)];
    await expect(repo.createRun(project.id, { prompt: "Same question again", attachments: two }, options)).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("deletes attachments with their project", async () => {
    const repo = store.forOwner(alice);
    const project = await repo.createProject({ title: "Office", problemStatement: "Open a second office or not?" }, 100);
    await repo.createRun(project.id, { prompt: "Should we open a second office?", attachments: await attachments() }, OPTS);
    expect(await repo.deleteProject(project.id)).toBe(true);
    const [{ n }] = await admin`select count(*)::int as n from echiche.run_attachments`;
    expect(n).toBe(0);
  });
});
