"use client";

import { OIDC_PROVIDER_ID } from "@krubot/shared";
import { LogIn } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth/client";
import { shellSignIn } from "@/lib/shell";

/** "Sign in with <provider>": the provider's page, then back to `next` when done. */
export function OidcButton({ name, next }: { name: string; next: string }) {
  const [busy, setBusy] = useState(false);
  async function go() {
    if (busy) return;
    // In the apps the provider's page opens in the computer's or the phone's own
    // browser, which has passkeys and which providers trust; going there in the app
    // would sign that browser in instead and leave the app waiting. It comes back
    // here signed in.
    if (shellSignIn(next)) return;
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
