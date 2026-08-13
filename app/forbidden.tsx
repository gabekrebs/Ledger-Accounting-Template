import Link from "next/link";

/**
 * Rendered when `forbidden()` (403) is triggered — a read-only user attempting a
 * write, or any other access-level denial. Deliberately generic: it confirms the
 * thing exists (the user already had read access) but not what they tried to do.
 */
export default function Forbidden() {
  return (
    <main className="flex-1 flex flex-col items-center justify-center px-6 py-24 text-center">
      <h1 className="text-lg font-medium">Not permitted</h1>
      <p className="mt-2 max-w-sm text-sm text-faint">
        You have read-only access here, so this change isn&rsquo;t available on
        your account. Contact the account owner if you need edit access.
      </p>
      <Link
        href="/"
        className="mt-6 text-sm text-evergreen underline underline-offset-4"
      >
        ← Back to home
      </Link>
    </main>
  );
}
