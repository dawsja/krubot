"use client";

import { BOX_UPDATE_PHASE_LABELS, type BoxStatus, type BoxUpdate } from "@krubot/shared";
import { RefreshCw, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { openShellDialog } from "@/components/shell";
import { useStore } from "@/components/store";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { api, post } from "@/lib/api";
import { settingsHref } from "@/lib/settings-sections";
import { cn } from "@/lib/utils";

/*
 * Settings → Computer: whether the box is up, what's installed on it, and
 * the Update and Reset buttons. Which engine the bots use and its sign-in
 * live in the Engine card. Update pauses the computer, pulls the newest box
 * image from GHCR when the API can reach Docker, patches Debian, Bun and
 * the engines' CLIs in place, and brings the computer back; the phases and
 * the log show here as they happen.
 */

const ORDER = ["pausing", "pulling", "restarting", "resetting", "patching", "resuming", "done"] as const;

/** "2.1.276 (Claude Code)", "codex-cli 0.155.0", "grok 1.0.34 (3736acbc8658) [stable]" → the version number. */
function versionOf(text: string | null | undefined): string | null {
  return text ? (/\d+(?:\.\d+)+/.exec(text)?.[0] ?? text) : null;
}

function progressOf(update: BoxUpdate | null): number {
  if (!update) return 0;
  if (update.phase === "failed") return 100;
  const at = ORDER.indexOf(update.phase as (typeof ORDER)[number]);
  return at < 0 ? 0 : Math.round(((at + 1) / ORDER.length) * 100);
}

export function ComputerCard({ status, onCheck }: { status: BoxStatus | null; onCheck: () => Promise<void> | void }) {
  const { boxUpdate, boxUpdating } = useStore();
  const [docker, setDocker] = useState<{ available: boolean; reason: string | null } | null>(null);
  const [confirming, setConfirming] = useState<"update" | "reset" | null>(null);
  const [showLog, setShowLog] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    void Promise.resolve().then(() =>
      api<{ docker: { available: boolean; reason: string | null } }>("/api/box/update")
        .then((d) => setDocker(d.docker))
        .catch(() => undefined),
    );
  }, []);
  useEffect(() => {
    const node = logRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [boxUpdate?.log.length]);

  async function start(kind: "update" | "reset") {
    setConfirming(null);
    setShowLog(true);
    try {
      await post(kind === "update" ? "/api/box/update" : "/api/box/reset", kind === "update" ? { pull: true } : {});
    } catch (failure) {
      toast.add({ type: "error", title: failure instanceof Error ? failure.message : `Could not start the ${kind}.` });
    }
  }

  const versions = status?.versions;
  const installed = versions
    ? [
        { name: "Node", version: versionOf(versions.node) },
        { name: "Bun", version: versionOf(versions.bun) },
        { name: "Claude Code", version: versionOf(versions.claude) },
        { name: "Codex", version: versionOf(versions.codex) },
        { name: "Grok", version: versionOf(versions.grok) },
      ].filter((tool) => tool.version)
    : [];
  const liveSessions = status?.agents.filter((a) => a.running).length ?? 0;
  const state: { text: string; tone: "ok" | "busy" | "problem" | "unknown"; detail: string } = boxUpdating
    ? { text: "Updating", tone: "busy", detail: "The computer is paused while it updates. Messages wait and are answered after." }
    : !status
      ? { text: "Checking…", tone: "unknown", detail: "" }
      : !status.configured
        ? { text: "Not set up", tone: "problem", detail: "No computer is configured. Set KRU_BOX_URL on the API." }
        : !status.reachable
          ? { text: "Unreachable", tone: "problem", detail: "The computer isn't answering. Is the box container running?" }
          : { text: "Running", tone: "ok", detail: liveSessions ? (liveSessions === 1 ? "1 bot session is live on it." : `${liveSessions} bot sessions are live on it.`) : "No bot is working on it right now." };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Computer</CardTitle>
        <CardDescription>
          The machine every bot works on, with its own terminal, browser and desktop. Its home folder, the bots&apos; files and the engines&apos; sign-ins last through restarts, updates and resets. Which engine the bots run on, and its sign-in, is under{" "}
          <Link href={settingsHref("ai")} className="text-brand-ink underline underline-offset-2">
            Settings → AI
          </Link>
          .
        </CardDescription>
        <CardAction className="flex gap-1.5">
          <Button variant="ghost" size="sm" disabled={boxUpdating || !status?.reachable} onClick={() => setConfirming("reset")}>
            <RotateCcw data-icon="inline-start" aria-hidden="true" />
            Reset
          </Button>
          <Button variant="outline" size="sm" disabled={boxUpdating || !status?.reachable} onClick={() => setConfirming("update")}>
            {boxUpdating ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" aria-hidden="true" />}
            {boxUpdating ? (boxUpdate?.kind === "reset" ? "Resetting…" : "Updating…") : "Update"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant="outline" className="h-6 gap-1.5">
            <span className={cn("size-2 rounded-full", state.tone === "ok" ? "bg-mint" : state.tone === "busy" ? "bg-amber" : state.tone === "problem" ? "bg-destructive" : "bg-ash")} aria-hidden="true" />
            {state.text}
          </Badge>
          <span className="flex-1 text-[13.5px]">{state.detail}</span>
        </div>
        {installed.length ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-muted-foreground">Installed</span>
            <div className="flex flex-wrap gap-1.5">
              {installed.map((tool) => (
                <Badge key={tool.name} variant="secondary">
                  {tool.name} {tool.version}
                </Badge>
              ))}
            </div>
          </div>
        ) : null}

        {boxUpdate ? (
          <div className="flex flex-col gap-2 rounded-xl border bg-muted/40 p-3">
            <Progress value={progressOf(boxUpdate)} aria-label="Update progress" className={cn(boxUpdate.phase === "failed" && "[&_[data-slot=progress-indicator]]:bg-destructive")}>
              <span className="flex w-full items-center gap-2 text-[13px] font-medium">
                {boxUpdating ? <Spinner /> : null}
                {BOX_UPDATE_PHASE_LABELS[boxUpdate.phase]}
                <button type="button" onClick={() => setShowLog((v) => !v)} className="ml-auto text-xs font-normal text-muted-foreground underline underline-offset-3 hover:text-foreground">
                  {showLog ? "Hide the log" : "Show the log"}
                </button>
              </span>
            </Progress>
            {boxUpdate.error ? <p className="text-[12.5px] text-destructive">{boxUpdate.error}</p> : null}
            {showLog ? (
              <pre ref={logRef} className="max-h-56 overflow-y-auto rounded-lg bg-foreground/90 p-3 font-mono text-[11.5px] leading-5 whitespace-pre-wrap text-background dark:bg-black/40">
                {boxUpdate.log.join("\n") || "…"}
              </pre>
            ) : null}
          </div>
        ) : null}
      </CardContent>
      <CardFooter className="gap-2">
        <Button variant="outline" size="sm" disabled={boxUpdating} onClick={() => openShellDialog({ kind: "computer" })}>
          Open the computer
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void onCheck()}>
          Check again
        </Button>
      </CardFooter>

      <AlertDialog open={confirming === "reset"} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset the computer?</AlertDialogTitle>
            <AlertDialogDescription>
              Like a fresh install. <strong>Kept:</strong> every bot&apos;s home with its memory and files, the team&apos;s shared files, the skills, and the sign-ins for Claude Code, Codex and Grok. <strong>Gone:</strong> everything else in the home folder: global packages and tools the bots installed, dotfiles, browser profiles and sessions, caches{docker?.available ? ", and the container itself is rebuilt from its image" : ""}. Running work stops and messages wait until it&apos;s back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Not now</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void start("reset")}>
              Reset
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirming === "update"} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Update the computer?</AlertDialogTitle>
            <AlertDialogDescription>
              The computer pauses: running work stops, the desktop closes, and new messages wait. {docker?.available ? "The newest box image is pulled from GHCR and the box restarts on it, keeping every bot's files." : "Then it's patched in place (Debian, Bun, Claude Code, Codex and Grok)."}
              {docker && !docker.available ? ` Image pulls are off: ${docker.reason}` : docker?.available ? " Then Debian, Bun, Claude Code, Codex and Grok are patched." : ""} A few minutes, usually.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Not now</AlertDialogCancel>
            <AlertDialogAction onClick={() => void start("update")}>
              Update
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
