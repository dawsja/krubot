"use client";

import { CATALOG_PAGE_SIZE, type CatalogPage, type Connection } from "@krubot/shared";
import { Search, X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppIcon, appName } from "@/components/app-icons";
import { BotAccessMenu } from "@/components/bot-access";
import { useLiveEvents } from "@/components/hq/live-events";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Pagination, PaginationContent, PaginationEllipsis, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious } from "@/components/ui/pagination";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { api, del, post } from "@/lib/api";

/**
 * Settings → Apps → Connected apps: every app Composio can connect, which
 * is hundreds, so it is a search and a page at a time rather than a scroll.
 * What you have connected stays at the top, whatever you are looking at.
 * The search happens in the API over the list it already holds
 * (`/api/catalog?q=`), so a few letters in any order find the app.
 */
export function AppsCard({ refresh = 0 }: { refresh?: number }) {
  const params = useSearchParams();
  const connected = params.get("connected");
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [configured, setConfigured] = useState(false);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<CatalogPage | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const told = useRef(false);

  const loadConnections = useCallback(async () => {
    const data = await api<{ configured: boolean; connections: Connection[] }>("/api/connections").catch(() => null);
    if (!data) return null;
    setConnections(data.connections);
    setConfigured(data.configured);
    return data.connections;
  }, []);

  // Coming back from an app's sign-in, say so by the app's own name.
  useEffect(() => {
    void Promise.resolve().then(async () => {
      const list = await loadConnections();
      if (!connected || told.current) return;
      told.current = true;
      toast.add({ type: "success", title: `${list?.find((c) => c.toolkit === connected)?.name ?? appName(connected)} connected.` });
    });
  }, [connected, loadConnections, refresh]);
  useLiveEvents((event) => {
    if (event.topic === "settings") void loadConnections();
  });

  // The field waits for you to stop typing before it asks.
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let alive = true;
    void Promise.resolve().then(async () => {
      const data = await api<CatalogPage>(`/api/catalog?q=${encodeURIComponent(search)}&page=${page}&per=${CATALOG_PAGE_SIZE}`).catch(() => null);
      if (alive && data) setResult(data);
    });
    return () => {
      alive = false;
    };
  }, [search, page, refresh]);

  function typed(value: string) {
    setQuery(value);
    setPage(1);
  }

  async function connect(toolkit: string, name: string) {
    setConnecting(toolkit);
    try {
      const data = await post<{ redirectUrl: string | null }>(`/api/connections/${toolkit}/connect`);
      if (data.redirectUrl) window.location.assign(data.redirectUrl);
      else {
        toast.add({ type: "success", title: `${name} connected.` });
        await loadConnections();
      }
    } catch (failure) {
      toast.add({ type: "error", title: `Could not connect ${name}.`, description: failure instanceof Error ? failure.message : undefined });
    } finally {
      setConnecting(null);
    }
  }

  const mine = [...(connections ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const byToolkit = new Map(mine.map((c) => [c.toolkit, c]));
  const pages = result?.pages ?? 1;

  /**
   * A row in either list: the app, what it is for, and what you can do
   * about it. A connected app has a second line: which bots may use it,
   * changed right there for one bot or all of them.
   */
  function row(toolkit: string, name: string, logo: string | undefined, about: string) {
    const c = byToolkit.get(toolkit);
    const head = (
      <>
        <AppIcon toolkit={toolkit} logo={logo} size={22} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13.5px] font-medium">{name}</span>
          <span className="block truncate text-[11.5px] text-muted-foreground">{c ? (c.status === "active" ? "Connected" : c.status === "pending" ? "Finishing sign-in…" : "Failed") : about}</span>
        </span>
        {c ? (
          <span className="flex items-center gap-1.5">
            {c.status !== "active" ? (
              <Button variant="outline" size="xs" onClick={() => void post(`/api/connections/${toolkit}/refresh`).then(() => loadConnections())}>
                Check
              </Button>
            ) : null}
            <Button variant="destructive" size="xs" onClick={() => void del(`/api/connections/${toolkit}`).then(() => loadConnections())}>
              Disconnect
            </Button>
          </span>
        ) : (
          <Button size="xs" disabled={!configured || connecting === toolkit} onClick={() => void connect(toolkit, name)}>
            {connecting === toolkit ? <Spinner data-icon="inline-start" /> : null}
            Connect
          </Button>
        )}
      </>
    );
    if (c?.status !== "active") return <li key={toolkit} className="flex items-center gap-2.5 rounded-xl border px-3 py-2">{head}</li>;
    return (
      <li key={toolkit} className="flex flex-col gap-2 rounded-xl border px-3 py-2">
        <span className="flex items-center gap-2.5">{head}</span>
        <span className="flex items-center justify-between gap-2 border-t pt-2">
          <span className="text-[12px] text-muted-foreground">Used by</span>
          <BotAccessMenu toolkit={toolkit} name={name} />
        </span>
      </li>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connected apps</CardTitle>
        <CardDescription>Every app Composio supports is here: search for yours, connect it once, then pick which bots may use it right here. Writes wait for your approval.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!configured ? (
          <Alert>
            <AlertTitle>Add your Composio key to connect apps.</AlertTitle>
            <AlertDescription>Your bots can still use the browser, the shell and your MCP servers without it.</AlertDescription>
          </Alert>
        ) : null}

        {mine.length ? (
          <div className="flex flex-col gap-2">
            <p className="text-[12.5px] font-medium text-muted-foreground">Yours</p>
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">{mine.map((c) => row(c.toolkit, c.name, undefined, c.toolkit))}</ul>
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[12.5px] font-medium text-muted-foreground">{result ? `${result.total.toLocaleString()} ${result.total === 1 ? "app" : "apps"}${search ? " found" : " to connect"}` : "Apps"}</p>
            <InputGroup className="w-full rounded-full sm:w-64">
              <InputGroupInput value={query} onChange={(e) => typed(e.target.value)} placeholder="Search apps" aria-label="Search apps" autoComplete="off" spellCheck={false} />
              <InputGroupAddon>
                <Search aria-hidden="true" />
              </InputGroupAddon>
              {query ? (
                <InputGroupAddon align="inline-end">
                  <InputGroupButton variant="ghost" size="icon-xs" aria-label="Clear the search" onClick={() => typed("")}>
                    <X />
                  </InputGroupButton>
                </InputGroupAddon>
              ) : null}
            </InputGroup>
          </div>

          {!result ? (
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {Array.from({ length: CATALOG_PAGE_SIZE }, (_, i) => (
                <li key={i}>
                  <Skeleton className="h-14 rounded-xl" />
                </li>
              ))}
            </ul>
          ) : result.apps.length === 0 ? (
            <Empty className="border">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Search />
                </EmptyMedia>
                <EmptyTitle>No app called that</EmptyTitle>
                <EmptyDescription>Try fewer letters, or attach the app&apos;s own MCP server below.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">{result.apps.map((app) => row(app.toolkit, app.name, app.logo, app.category))}</ul>
          )}
        </div>

        {pages > 1 ? (
          <Pagination>
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))} />
              </PaginationItem>
              {pageWindow(page, pages).map((at, i) =>
                at === "gap" ? (
                  <PaginationItem key={`gap-${i}`}>
                    <PaginationEllipsis />
                  </PaginationItem>
                ) : (
                  <PaginationItem key={at}>
                    <PaginationLink isActive={at === page} aria-label={`Page ${at}`} onClick={() => setPage(at)}>
                      {at}
                    </PaginationLink>
                  </PaginationItem>
                ),
              )}
              <PaginationItem>
                <PaginationNext disabled={page >= pages} onClick={() => setPage((p) => Math.min(pages, p + 1))} />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** The pages to draw: the first, the last, and the ones around where you are. */
function pageWindow(page: number, pages: number): (number | "gap")[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const near = [page - 1, page, page + 1].filter((p) => p > 1 && p < pages);
  const out: (number | "gap")[] = [1];
  if ((near[0] ?? pages) > 2) out.push("gap");
  out.push(...near);
  if ((near[near.length - 1] ?? 1) < pages - 1) out.push("gap");
  out.push(pages);
  return out;
}
