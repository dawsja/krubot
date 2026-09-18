"use client";

import type { McpServer } from "@krubot/shared";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { post } from "@/lib/api";
import { mobileShell, useNativeShell } from "@/lib/shell";

/*
 * Signing in to an MCP server. Most return to this app; a server set to
 * localhost (Robinhood's Trading MCP only lets local tools in) opens its
 * sign-in in another tab and lands on http://localhost. The desktop app
 * listens there and finishes it; the Android app catches the address and
 * finishes it on the server; in a browser that page won't load, and the
 * person pastes its address here.
 */

/**
 * Starts the sign-in. Call it straight from the click: a localhost sign-in
 * opens its tab before the request so the browser doesn't block it.
 * Returns true when the person stays here to finish (localhost).
 */
export async function startMcpSignIn(server: Pick<McpServer, "id" | "oauthRedirect">, threadId?: string): Promise<boolean> {
  const loopback = server.oauthRedirect === "localhost";
  // In the desktop app this comes back null and the address opens in the browser
  // instead. The Android app keeps the sign-in in its own window, where it can
  // catch the localhost address at the end, so no tab is opened there.
  const tab = loopback && !mobileShell() ? window.open("about:blank", "_blank") : null;
  try {
    const { url } = await post<{ url: string }>(`/api/mcp-servers/${server.id}/login`, threadId ? { threadId } : {});
    if (tab) tab.location.href = url;
    else window.location.assign(url);
    return loopback;
  } catch (error) {
    tab?.close();
    throw error;
  }
}

/** Where the person finishes a localhost sign-in: the address the sign-in tab ended on. */
export function McpPasteSignIn({ name, onDone }: { name: string; onDone?: (name: string) => void }) {
  const shell = useNativeShell();
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !address.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const done = await post<{ name: string }>("/api/mcp-servers/oauth/complete", { url: address.trim() });
      onDone?.(done.name);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The sign-in didn't complete.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <FieldGroup className="gap-3">
        <Field>
          <FieldLabel htmlFor="mcp-paste">Address the sign-in ended on</FieldLabel>
          <Input id="mcp-paste" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="http://localhost:47651/callback?code=…" className="font-mono text-[13px]" autoComplete="off" spellCheck={false} />
          <FieldDescription>
            {shell
              ? `Kru Bot finishes the ${name} sign-in on its own when you're done. If it doesn't, copy the address of the page the sign-in ended on and paste it here.`
              : `${name} only sends sign-ins back to localhost, so the page it ends on won't load. That's expected: copy that page's whole address and paste it here.`}
          </FieldDescription>
          {error ? <FieldError>{error}</FieldError> : null}
        </Field>
        <div>
          <Button type="submit" size="sm" disabled={busy || !address.trim()}>
            {busy ? <Spinner data-icon="inline-start" /> : null}
            Finish sign-in
          </Button>
        </div>
      </FieldGroup>
    </form>
  );
}
