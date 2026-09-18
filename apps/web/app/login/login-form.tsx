"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { authClient } from "@/lib/auth/client";

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const { error: failure } = await authClient.signIn.username({ username: username.trim(), password });
    if (failure) {
      setBusy(false);
      setError(failure.status === 429 ? "Too many attempts. Wait a minute and try again." : "That username and password don't match.");
      return;
    }
    router.replace(next);
    router.refresh();
  }

  return (
    <form onSubmit={submit}>
      <FieldGroup className="gap-4">
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor="username">Username</FieldLabel>
          <Input id="username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} required aria-invalid={error ? true : undefined} />
        </Field>
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required aria-invalid={error ? true : undefined} />
          {error ? <FieldError>{error}</FieldError> : null}
        </Field>
        <Button type="submit" size="xl" disabled={busy} className="mt-2">
          {busy ? <Spinner data-icon="inline-start" /> : null}
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </FieldGroup>
    </form>
  );
}
