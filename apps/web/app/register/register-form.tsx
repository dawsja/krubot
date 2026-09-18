"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { post } from "@/lib/api";

export function RegisterForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await post("/api/register", {
        token: String(form.get("token") ?? ""),
        username: String(form.get("username") ?? ""),
        password: String(form.get("password") ?? ""),
        confirm: String(form.get("confirm") ?? ""),
      });
      router.replace("/onboarding");
      router.refresh();
    } catch (failure) {
      setBusy(false);
      setError(failure instanceof Error ? failure.message : "Could not create the account.");
    }
  }

  return (
    <form onSubmit={submit}>
      <FieldGroup className="gap-4">
        <Field>
          <FieldLabel htmlFor="token">Setup token</FieldLabel>
          <Input id="token" name="token" autoComplete="off" spellCheck={false} required className="font-mono" />
          <FieldDescription className="text-xs">
            Printed in the API&apos;s logs when it starts. With Docker: <code className="font-mono">docker compose logs api | grep &quot;setup token&quot;</code>
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="username">Username</FieldLabel>
          <Input id="username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} minLength={3} maxLength={30} required />
        </Field>
        <Field>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input id="password" name="password" type="password" autoComplete="new-password" minLength={12} required />
          <FieldDescription className="text-xs">At least 12 characters.</FieldDescription>
        </Field>
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor="confirm">Confirm password</FieldLabel>
          <Input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={12} required aria-invalid={error ? true : undefined} />
          {error ? <FieldError>{error}</FieldError> : null}
        </Field>
        <Button type="submit" size="xl" disabled={busy} className="mt-2">
          {busy ? <Spinner data-icon="inline-start" /> : null}
          {busy ? "Creating account…" : "Create account"}
        </Button>
      </FieldGroup>
    </form>
  );
}
