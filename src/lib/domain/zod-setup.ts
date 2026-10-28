import { z } from "zod";

/**
 * Zod's fast path probes for eval support with `new Function`. The probe is caught, but under the
 * app's Content-Security-Policy (no 'unsafe-eval'; M8 F3) the browser still reports a violation.
 * Imported for its side effect by every domain module that defines schemas, before any parse.
 */
z.config({ jitless: true });
