import { NextResponse } from "next/server";
import { getRepository, persistenceMode } from "@/lib/server/container";
import { handleUnexpected } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PING_TIMEOUT_MS = 3000;

/**
 * Readiness: configuration is valid and storage answers a trivial query within the timeout.
 * 200 → ready; 503 → CONFIG_INVALID or STORAGE_UNAVAILABLE. Safe to expose: no secrets or hostnames.
 */
export async function GET() {
  try {
    const repo = getRepository();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("ping timeout"), { code: "ETIMEDOUT" })), PING_TIMEOUT_MS);
    });
    try {
      await Promise.race([repo.ping(), timeout]);
    } finally {
      clearTimeout(timer);
    }
    return NextResponse.json(
      { status: "ready", persistence: persistenceMode() },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    return handleUnexpected(error, "GET /api/ready");
  }
}
