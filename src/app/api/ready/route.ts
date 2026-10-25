import { NextResponse } from "next/server";
import { getStore } from "@/lib/server/container";
import { handleUnexpected } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PING_TIMEOUT_MS = 3000;

/**
 * Readiness: configuration is valid and the database answers a trivial query within the
 * timeout. 200 → ready; 503 → CONFIG_INVALID or STORAGE_UNAVAILABLE. Unauthenticated
 * by design and safe to expose: no secrets, hostnames or user data.
 */
export async function GET() {
  try {
    const store = getStore();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("ping timeout"), { code: "ETIMEDOUT" })), PING_TIMEOUT_MS);
    });
    try {
      await Promise.race([store.ping(), timeout]);
    } finally {
      clearTimeout(timer);
    }
    return NextResponse.json({ status: "ready" }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return handleUnexpected(error, "GET /api/ready");
  }
}
