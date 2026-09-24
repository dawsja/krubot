"use client";

import { ENGINE_LABELS, type Engine, type EngineSignIn } from "@krubot/shared";
import { Check, Copy, ExternalLink } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { api, del, post } from "@/lib/api";
import { useNativeShell } from "@/lib/shell";

/*
 * Signing a CLI in to your plan without a terminal. The computer runs the
 * CLI's own login inside your account there and hands back what you need
 * to finish it in a browser: a link, and a code to enter (Codex and Grok)
 * or to paste back (Claude Code). The sign-in itself never leaves your
 * account on the computer.
 */

/** How often the sheet asks the computer how the sign-in is going. */
const POLL_MS = 2_000;

async function readSignIn(engine: Engine) {
  return (await api<{ signIn: EngineSignIn | null }>(`/api/box/engines/${engine}/sign-in`)).signIn;
}

/** The code to enter on the sign-in page, big enough to read off a phone. */
function CodeToEnter({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      /* a phone without the clipboard: the code is selectable anyway */
    }
  };
  return (
    <div className="flex flex-col items-center gap-2">
      <span className="w-full rounded-xl border bg-muted px-4 py-3 text-center font-mono text-2xl tracking-[0.2em] select-all">{code}</span>
      <Button type="button" variant="ghost" size="sm" onClick={() => void copy()} className="pointer-coarse:min-h-11">
        {copied ? <Check data-icon="inline-start" className="text-mint" /> : <Copy data-icon="inline-start" />}
        {copied ? "Copied" : "Copy the code"}
      </Button>
    </div>
  );
}

/** Claude Code hands the code back on its page instead of waiting itself. */
function PasteCode({ engine, onSent }: { engine: Engine; onSent: (signIn: EngineSignIn) => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { signIn } = await post<{ signIn: EngineSignIn }>(`/api/box/engines/${engine}/sign-in/code`, { code: code.trim() });
      setCode("");
      onSent(signIn);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The computer wouldn't take that code.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <FieldGroup className="gap-3">
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor="engine-code">Code from that page</FieldLabel>
          <Input id="engine-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste it here" autoComplete="off" autoCapitalize="none" spellCheck={false} className="font-mono text-[13px]" aria-invalid={error ? true : undefined} />
          <FieldDescription>Approve there, then paste the code it shows.</FieldDescription>
          {error ? <FieldError>{error}</FieldError> : null}
        </Field>
        <Button type="submit" disabled={busy || !code.trim()}>
          {busy ? <Spinner data-icon="inline-start" /> : null}
          Finish sign-in
        </Button>
      </FieldGroup>
    </form>
  );
}

/**
 * The sheet that runs a sign-in. Closing it leaves the sign-in running, so
 * an approval already open in the browser still lands; Cancel stops it.
 */
export function EngineSignInDialog({ engine, onOpenChange, onDone }: { engine: Engine | null; onOpenChange: (open: boolean) => void; onDone?: () => void }) {
  const shell = useNativeShell();
  const [signIn, setSignIn] = useState<EngineSignIn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const done = useRef(false);
  // What the last poll saw, so polling stops the moment the sign-in ends.
  const live = useRef(true);

  const start = useCallback(async (which: Engine) => {
    setError(null);
    setSignIn(null);
    try {
      const { signIn: started } = await post<{ signIn: EngineSignIn }>(`/api/box/engines/${which}/sign-in`, {});
      done.current = false;
      live.current = true;
      setSignIn(started);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The computer couldn't start the sign-in.");
    }
  }, []);

  // Open on a sign-in already running, or start one; then follow it until it ends.
  useEffect(() => {
    if (!engine) return;
    let alive = true;
    done.current = false;
    live.current = true;
    void Promise.resolve()
      .then(() => readSignIn(engine).catch(() => null))
      .then((current) => {
        if (!alive) return;
        if (current && current.state !== "done" && current.state !== "failed") setSignIn(current);
        else void start(engine);
      });
    const timer = window.setInterval(() => {
      if (!live.current) return;
      void readSignIn(engine)
        .then((current) => {
          if (!alive || !current) return;
          if (current.state === "done" || current.state === "failed") live.current = false;
          setSignIn(current);
        })
        .catch(() => undefined);
    }, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [engine, start]);

  // Telling the rest of the app once is enough; the card reloads its status then.
  useEffect(() => {
    if (signIn?.state !== "done" || done.current) return;
    done.current = true;
    onDone?.();
  }, [signIn?.state, onDone]);

  if (!engine) return null;
  const info = ENGINE_LABELS[engine];
  const state = signIn?.state ?? "starting";
  const cancel = () => {
    void del(`/api/box/engines/${engine}/sign-in`).catch(() => undefined);
    onOpenChange(false);
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Sign in to {info.name}</DialogTitle>
          <DialogDescription>
            {shell === "android" ? "Opens in your phone's browser. Come back when you're done." : "Opens in your browser. Come back when you're done."}
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <Alert variant="destructive">
            <AlertTitle>The sign-in couldn&apos;t start</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        {!error && (state === "starting" || !signIn) ? (
          <p className="flex items-center gap-2 text-[13.5px] text-muted-foreground">
            <Spinner />
            Asking the computer for a sign-in link…
          </p>
        ) : null}

        {signIn && (state === "waiting" || state === "finishing") ? (
          <div className="flex flex-col gap-4">
            {signIn.code ? <CodeToEnter code={signIn.code} /> : null}
            {signIn.url ? (
              <Button size="lg" className="w-full max-sm:h-12" render={<a href={signIn.url} target="_blank" rel="noreferrer noopener" />} nativeButton={false}>
                <ExternalLink data-icon="inline-start" />
                Open {info.signInAt}
              </Button>
            ) : null}
            {state === "finishing" ? (
              <p className="flex items-center gap-2 text-[13.5px] text-muted-foreground">
                <Spinner />
                Checking the sign-in…
              </p>
            ) : signIn.needsCode ? (
              <PasteCode engine={engine} onSent={setSignIn} />
            ) : (
              <p className="text-[13.5px] text-muted-foreground">Enter the code there. This page finishes on its own.</p>
            )}
          </div>
        ) : null}

        {signIn && state === "done" ? (
          <p className="flex items-start gap-2 text-[13.5px]">
            <Check className="mt-0.5 size-4 shrink-0 text-mint" aria-hidden="true" />
            Signed in. Your bots use {info.name} from their next reply.
          </p>
        ) : null}

        {signIn && state === "failed" ? (
          <Alert variant="destructive">
            <AlertTitle>That didn&apos;t finish</AlertTitle>
            <AlertDescription>
              {signIn.error ?? "The sign-in ended early."}
              {engine === "codex" ? " If OpenAI refused it, turn on device code sign-in under your ChatGPT security settings." : ""}
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="flex gap-2">
          {state === "done" ? (
            <Button className="flex-1" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          ) : state === "failed" ? (
            <>
              <Button className="flex-1" onClick={() => void start(engine)}>
                Try again
              </Button>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </>
          ) : (
            <Button variant="outline" className="flex-1" onClick={cancel}>
              Cancel
            </Button>
          )}
        </div>
        <p className="text-[12px] text-muted-foreground">
          The sign-in stays in your account on the computer. You can also run <code className="rounded bg-muted px-1 font-mono text-[11.5px]">{info.signIn}</code> in a terminal there.
        </p>
      </DialogContent>
    </Dialog>
  );
}
