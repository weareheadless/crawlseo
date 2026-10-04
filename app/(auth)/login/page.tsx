import { getUserIdFromCookies } from "@/lib/session-helper";
import { signInWithPassword } from "@/lib/local-auth";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";

export default async function LoginPage() {
  const userId = await getUserIdFromCookies();
  if (userId) {
    redirect("/dashboard");
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4">
      <div className="noise-overlay pointer-events-none absolute inset-0" />

      <div className="relative w-full max-w-md">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-5 flex size-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground shadow-[var(--shadow-3)]">
            <svg viewBox="0 0 24 24" className="size-6" fill="none" aria-hidden>
              <path
                d="M4 18 L12 5 L20 18"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinejoin="round"
              />
              <circle cx="12" cy="15.5" r="1.6" fill="currentColor" />
            </svg>
          </div>
          <h1 className="font-heading text-atom-display1 font-semibold tracking-tight text-foreground">
            CrawlSEO
          </h1>
          <p className="mt-2 text-atom-body text-muted-foreground">
            Self-hosted search ops for founders
          </p>
        </div>

        <div className="panel-elevated p-8">
          <h2 className="font-heading text-atom-title font-semibold text-foreground">
            Sign in
          </h2>
          <p className="mt-2 text-atom-body text-muted-foreground">
            Sign in to manage your SEO workspace.
          </p>

          <form
            className="mt-6"
            action={signInWithPassword}
          >
            <label className="block text-sm font-medium text-foreground" htmlFor="email">Email</label>
            <input id="email" name="email" type="email" autoComplete="username" required className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2 text-foreground outline-none focus:border-primary" />
            <label className="mt-4 block text-sm font-medium text-foreground" htmlFor="password">Password</label>
            <input id="password" name="password" type="password" autoComplete="current-password" required className="mt-2 w-full rounded-lg border border-border bg-background px-3 py-2 text-foreground outline-none focus:border-primary" />
            <Button type="submit" size="lg" className="mt-6 w-full">
              Sign in
            </Button>
          </form>

          <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
            <div className="h-px flex-1 bg-border" />
            <span>or</span>
            <div className="h-px flex-1 bg-border" />
          </div>

          <a
            href="/crawlseo/api/auth/google/sign-in"
            className="flex w-full items-center justify-center rounded-lg border border-border bg-secondary/60 px-4 py-2.5 text-sm font-medium text-foreground transition hover:bg-secondary"
          >
            Continue with Google
          </a>

          <div className="mt-6 space-y-2 border-t border-border pt-5 text-atom-caption text-muted-foreground">
            <p>· Keywords, positions, CTR from GSC</p>
            <p>· Technical crawl & Core Web Vitals</p>
            <p>· Data stays on your server</p>
          </div>
        </div>

        <p className="mt-8 text-center text-atom-caption text-muted-foreground">
          UI inspired by{" "}
          <a
            href="https://atomizedesign.com/"
            className="font-medium text-primary hover:underline"
            target="_blank"
            rel="noreferrer"
          >
            Atomize PRO
          </a>
        </p>
      </div>
    </div>
  );
}
