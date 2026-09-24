"use client";

import { USAGE_RANGES, type UsageSummary, type UsageTotals } from "@krubot/shared";
import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, XAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useSwipeBack } from "@/hooks/use-swipe-back";
import { api } from "@/lib/api";

type Range = (typeof USAGE_RANGES)[number];

const chartConfig = {
  input: { label: "In", color: "var(--chart-2)" },
  output: { label: "Out", color: "var(--chart-1)" },
} satisfies ChartConfig;

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en");

/** Tokens the short way: 12.4K, 3.1M. */
function tokens(n: number) {
  return n < 1000 ? whole.format(n) : compact.format(n);
}

/** Dollars, with cents down to a cent and a "<" below it. */
function dollars(cost: number | null) {
  if (cost === null) return "—";
  if (cost > 0 && cost < 0.01) return "<$0.01";
  return `$${cost.toFixed(2)}`;
}

/** `2026-09-22` as "Sep 22", without the clock's time zone moving it a day. */
function shortDay(day: string) {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card size="sm" className="gap-1">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-[22px] tabular-nums">{value}</CardTitle>
      </CardHeader>
      {hint ? <CardContent className="text-[12.5px] text-muted-foreground">{hint}</CardContent> : null}
    </Card>
  );
}

function Breakdown({ title, rows }: { title: string; rows: (UsageTotals & { key: string; label: string; detail?: string })[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="scroll-fade-x overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{title === "By bot" ? "Bot" : "Model"}</TableHead>
              <TableHead className="text-right">Turns</TableHead>
              <TableHead className="text-right">In</TableHead>
              <TableHead className="text-right">Out</TableHead>
              <TableHead className="text-right">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.key}>
                <TableCell className="max-w-48 truncate font-medium">
                  {row.label}
                  {row.detail ? <span className="ml-1.5 font-normal text-muted-foreground">{row.detail}</span> : null}
                </TableCell>
                <TableCell className="text-right tabular-nums">{whole.format(row.turns)}</TableCell>
                <TableCell className="text-right tabular-nums">{tokens(row.input)}</TableCell>
                <TableCell className="text-right tabular-nums">{tokens(row.output)}</TableCell>
                <TableCell className="text-right tabular-nums">{dollars(row.cost)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/**
 * Usage: what your bots used over a week, a month or a quarter. Your own
 * turns only; reached from the menu behind your picture, or the Settings
 * list on a phone.
 */
export function UsageScreen() {
  useSwipeBack("/app");
  const [range, setRange] = useState<Range>(30);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (days: Range) => {
    try {
      const data = await api<UsageSummary>(`/api/usage?days=${days}`);
      setSummary(data);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(() => load(range));
  }, [load, range]);

  const shown = summary?.days === range ? summary : null;
  const totals = shown?.totals;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-3 px-4 pt-[max(16px,env(safe-area-inset-top))] pb-3 wide:px-6 wide:pt-8 wide:pb-5">
        <Button size="icon-xl" aria-label="Back to chats" render={<Link href="/app" />} nativeButton={false} className="wide:hidden">
          <ChevronLeft aria-hidden="true" />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="text-[22px] font-semibold tracking-[-0.4px]">Usage</h1>
          <p className="hidden text-[13.5px] text-muted-foreground wide:block">What your bots used, as their engines reported it.</p>
        </div>
      </header>

      <div className="scroll-fade-y min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(16px+env(safe-area-inset-bottom))] wide:px-6">
        <div className="mx-auto flex max-w-4xl flex-col gap-4">
          <ToggleGroup variant="pill" value={[String(range)]} onValueChange={(v) => v[0] && setRange(Number(v[0]) as Range)} aria-label="Range">
            {USAGE_RANGES.map((days) => (
              <ToggleGroupItem key={days} value={String(days)} className="h-11 px-4">
                {days} days
              </ToggleGroupItem>
            ))}
          </ToggleGroup>

          {failed && !shown ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Couldn&apos;t load your usage.</EmptyTitle>
                <EmptyDescription>Check the connection and try again.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button variant="outline" onClick={() => void load(range)}>
                  Try again
                </Button>
              </EmptyContent>
            </Empty>
          ) : !shown ? (
            <div className="grid grid-cols-2 gap-3 wide:grid-cols-4">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-24 rounded-2xl" />
              ))}
            </div>
          ) : totals && totals.turns === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>Nothing used in the last {range} days.</EmptyTitle>
                <EmptyDescription>Each reply a bot gives is counted here from now on.</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : totals ? (
            <>
              <div className="grid grid-cols-2 gap-3 wide:grid-cols-4">
                <Stat label="Turns" value={whole.format(totals.turns)} />
                <Stat label="Tokens in" value={tokens(totals.input)} hint={totals.cachedInput ? `${tokens(totals.cachedInput)} from cache` : undefined} />
                <Stat label="Tokens out" value={tokens(totals.output)} />
                <Stat label="Estimated cost" value={dollars(totals.cost)} hint={totals.cost === null ? "No engine reported one" : "On a plan, what the API would charge"} />
              </div>

              <Card>
                <CardHeader>
                  <CardTitle>Tokens per day</CardTitle>
                  <CardDescription>In the team&apos;s time zone, {shown.timezone}.</CardDescription>
                </CardHeader>
                <CardContent>
                  <ChartContainer config={chartConfig} className="aspect-auto h-56 w-full">
                    <BarChart data={shown.daily} margin={{ left: 0, right: 0 }}>
                      <CartesianGrid vertical={false} />
                      <XAxis dataKey="day" tickLine={false} axisLine={false} tickMargin={8} minTickGap={24} tickFormatter={shortDay} />
                      <ChartTooltip cursor={false} content={<ChartTooltipContent labelFormatter={(value) => shortDay(String(value))} />} />
                      <Bar dataKey="input" stackId="tokens" fill="var(--color-input)" radius={[0, 0, 4, 4]} />
                      <Bar dataKey="output" stackId="tokens" fill="var(--color-output)" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ChartContainer>
                </CardContent>
              </Card>

              <Breakdown title="By bot" rows={shown.bots.map((b) => ({ ...b, key: b.botId, label: b.name }))} />
              <Breakdown title="By model" rows={shown.models.map((m) => ({ ...m, key: `${m.engine}:${m.model}`, label: m.model || "Default", detail: m.engine }))} />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
