"use client";
// Error boundary for signed-in screens: a rendering failure shows a calm recovery path instead of a blank page.
// The error itself is not displayed (it may contain internal detail); Next logs it in the browser console.
import Link from "next/link";
import { SUPPORT } from "@/lib/domain/site";
import { EmptyState } from "../ui/primitives";

export default function AppError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <EmptyState title="Something went wrong on this page"
      action={<div className="row"><button type="button" className="btn btn-primary" onClick={reset}>Try again</button>
        <Link href="/" className="btn btn-ghost">Go to the overview</Link></div>}>
      Your data is safe: nothing was changed by this error. Try again, and if it keeps happening, contact {SUPPORT.email}.
    </EmptyState>
  );
}
