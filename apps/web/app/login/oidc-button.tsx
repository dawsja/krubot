"use client";

import { OIDC_PROVIDER_ID } from "@krubot/shared";
import { LogIn } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth/client";

/** "Sign in with <provider>": the provider's page, then back to `next` when done. */
export function OidcButton({ name, next }: { name: string; next: string }) {
  const [busy, setBusy] = useState(false);
  async function go() {
    if (busy) return;
    setBusy(true);
    // The generic OAuth plugin registers the provider under this id as a social provider.
    const { error } = await authClient.signIn.social({ provider: OIDC_PROVIDER_ID as "github", callbackURL: next, errorCallbackURL: "/login?error=oidc", newUserCallbackURL: next });
    if (error) setBusy(false);
  }
  return (
    <Button type="button" variant="outline" size="xl" disabled={busy} onClick={() => void go()} className="w-full">
      {busy ? <Spinner data-icon="inline-start" /> : <LogIn data-icon="inline-start" aria-hidden="true" />}
      {busy ? "Taking you there…" : `Sign in with ${name}`}
    </Button>
  );
}
