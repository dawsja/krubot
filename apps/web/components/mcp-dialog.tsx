"use client";

import { defaultOAuthRedirect, MCP_OAUTH_REDIRECTS, MCP_TRANSPORTS, type McpOAuthRedirect, type McpServer, type McpTransport } from "@krubot/shared";
import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { api, patch } from "@/lib/api";

const TRANSPORT_LABELS: Record<McpTransport, string> = { http: "HTTP (remote)", stdio: "Command (on the computer)" };
const REDIRECT_LABELS: Record<McpOAuthRedirect, string> = { app: "This Kru Bot", localhost: "localhost" };

/** KEY=value lines to a record; blank lines and comments are skipped. */
function parseLines(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf("=");
    if (at <= 0) continue;
    out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
  }
  return out;
}

function toLines(record: Record<string, string>): string {
  return Object.entries(record)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

/** Add or edit one of your MCP servers. */
export function McpDialog({ server, onClose, onSaved }: { server: McpServer | null; onClose: () => void; onSaved: () => void | Promise<void> }) {
  const [name, setName] = useState(server?.name ?? "");
  const [transport, setTransport] = useState<McpTransport>(server?.transport ?? "http");
  const [url, setUrl] = useState(server?.url ?? "");
  const [headers, setHeaders] = useState(toLines(server?.headers ?? {}));
  /** Null until chosen: a new server follows its URL's default. */
  const [redirect, setRedirect] = useState<McpOAuthRedirect | null>(server?.oauthRedirect ?? null);
  const oauthRedirect = redirect ?? defaultOAuthRedirect(url.trim());
  const [command, setCommand] = useState(server ? [server.command ?? "", ...server.args].join(" ").trim() : "");
  const [env, setEnv] = useState(toLines(server?.env ?? {}));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const [cmd, ...args] = command.trim().split(/\s+/).filter(Boolean);
      const body = transport === "http" ? { name: name.trim(), transport, url: url.trim(), headers: parseLines(headers), oauthRedirect, enabled: server?.enabled ?? true } : { name: name.trim(), transport, command: cmd ?? "", args, env: parseLines(env), enabled: server?.enabled ?? true };
      if (server) await patch(`/api/mcp-servers/${server.id}`, body);
      else await api("/api/mcp-servers", { method: "POST", body: JSON.stringify(body) });
      await onSaved();
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save.");
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{server ? `Edit ${server.name}` : "Add an MCP server"}</DialogTitle>
          <DialogDescription>Its tools reach the bots you give it to, in each bot&apos;s profile under Connected apps. Its writes go through approval like anything else.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <FieldGroup className="gap-4">
            <Field>
              <FieldLabel htmlFor="mcp-name">Name</FieldLabel>
              <Input id="mcp-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={40} placeholder="linear" pattern="[A-Za-z0-9][A-Za-z0-9_-]*" />
              <FieldDescription>Letters, digits, dashes. Its tools appear to the bots as mcp__{name || "name"}__…</FieldDescription>
            </Field>
            <Field>
              <FieldLabel>How to reach it</FieldLabel>
              <ToggleGroup variant="pill" size="sm" value={[transport]} onValueChange={(v) => v[0] && setTransport(v[0] as McpTransport)}>
                {MCP_TRANSPORTS.map((t) => (
                  <ToggleGroupItem key={t} value={t}>
                    {TRANSPORT_LABELS[t]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </Field>
            {transport === "http" ? (
              <>
                <Field>
                  <FieldLabel htmlFor="mcp-url">URL</FieldLabel>
                  <Input id="mcp-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="https://mcp.example.com/mcp" />
                  <FieldDescription>The bots reach it through Kru&apos;s API, which adds the headers below. If the server asks for a sign-in (Robinhood&apos;s https://agent.robinhood.com/mcp/trading does), a Sign in button appears on its row once it&apos;s added.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="mcp-headers">Headers</FieldLabel>
                  <Textarea id="mcp-headers" value={headers} onChange={(e) => setHeaders(e.target.value)} rows={3} className="font-mono text-[13px]" placeholder={"Authorization=Bearer {{secret:LINEAR_API_KEY}}"} />
                  <FieldDescription>One per line, Name=value. Write {"{{secret:NAME}}"} for a stored secret; it is filled in on the way and the bots never see it.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel>Sign-in returns to</FieldLabel>
                  <ToggleGroup variant="pill" size="sm" value={[oauthRedirect]} onValueChange={(v) => v[0] && setRedirect(v[0] as McpOAuthRedirect)}>
                    {MCP_OAUTH_REDIRECTS.map((r) => (
                      <ToggleGroupItem key={r} value={r}>
                        {REDIRECT_LABELS[r]}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                  <FieldDescription>Only matters when the server asks for a sign-in. Pick localhost when it only lets local tools sign in (Robinhood&apos;s Trading MCP does): the desktop app finishes the sign-in on its own, and in a browser you paste the address the sign-in ends on.</FieldDescription>
                </Field>
              </>
            ) : (
              <>
                <Field>
                  <FieldLabel htmlFor="mcp-command">Command</FieldLabel>
                  <Input id="mcp-command" value={command} onChange={(e) => setCommand(e.target.value)} required className="font-mono" placeholder="npx -y @modelcontextprotocol/server-filesystem /home/agent/.team" />
                  <FieldDescription>Runs on the computer as the bots&apos; user, in their home.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="mcp-env">Environment</FieldLabel>
                  <Textarea id="mcp-env" value={env} onChange={(e) => setEnv(e.target.value)} rows={3} className="font-mono text-[13px]" placeholder={"LOG_LEVEL=info"} />
                  <FieldDescription>One per line, NAME=value. Visible on the computer, so no secrets here: use an HTTP server with a {"{{secret:NAME}}"} header for those.</FieldDescription>
                </Field>
              </>
            )}
            {error ? <FieldError>{error}</FieldError> : null}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? <Spinner data-icon="inline-start" /> : null}
                {busy ? "Saving…" : server ? "Save" : "Add server"}
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
