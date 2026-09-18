"use client";

import type { UserSummary } from "@krubot/shared";
import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { PersonAvatar } from "@/components/bot-avatar";
import { useLiveEvents } from "@/components/hq/live-events";
import { useStore } from "@/components/store";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, del } from "@/lib/api";

/** Settings → Authentication → People: everyone who has signed in, and a way to remove them and their bots. */
export function UsersCard() {
  const { me } = useStore();
  const [users, setUsers] = useState<UserSummary[] | null>(null);
  const [removing, setRemoving] = useState<UserSummary | null>(null);

  const load = useCallback(async () => {
    const data = await api<{ users: UserSummary[] }>("/api/users").catch(() => null);
    if (data) setUsers(data.users);
  }, []);
  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  useLiveEvents((event) => {
    if (event.topic === "settings" || event.topic === "bots") void load();
  });

  async function remove(user: UserSummary) {
    try {
      await del(`/api/users/${user.id}`);
      toast.add({ type: "success", title: `${user.name} removed.`, description: "Their bots, conversations and files on the computer are gone." });
    } catch (failure) {
      toast.add({ type: "error", title: failure instanceof Error ? failure.message : "Could not remove them." });
    }
    await load();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>People</CardTitle>
        <CardDescription>Everyone who has signed in. Removing someone deletes their bots, conversations and the bots&apos; files on the computer; their account at the provider is untouched, and they can sign in again as new.</CardDescription>
      </CardHeader>
      <CardContent>
        {!users ? (
          <div className="flex flex-col gap-2">
            {Array.from({ length: 2 }, (_, i) => (
              <Skeleton key={i} className="h-14 rounded-xl" />
            ))}
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {users.map((user) => (
              <li key={user.id} className="group flex items-center gap-3 rounded-xl border px-3 py-2">
                <PersonAvatar name={user.name} avatar={user.avatar} size={32} />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-[13.5px] font-medium">{user.name}</span>
                    {user.role === "admin" ? <Badge variant="secondary">Admin</Badge> : null}
                    <Badge variant="outline">{user.provider === "local" ? "password" : "provider"}</Badge>
                    {user.id === me.id ? <span className="text-[12px] text-muted-foreground">(you)</span> : null}
                  </span>
                  <span className="block truncate text-[12px] text-muted-foreground">
                    {user.provider === "local" ? user.name : user.email} · {user.bots} {user.bots === 1 ? "bot" : "bots"} · since {new Date(user.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                  </span>
                </span>
                {user.role !== "admin" ? (
                  <Tooltip>
                    <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`Remove ${user.name}`} onClick={() => setRemoving(user)} className="text-destructive opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 focus-visible:opacity-100" />}>
                      <Trash2 aria-hidden="true" />
                    </TooltipTrigger>
                    <TooltipContent>Remove</TooltipContent>
                  </Tooltip>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <AlertDialog open={Boolean(removing)} onOpenChange={(open) => !open && setRemoving(null)}>
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>Their {removing?.bots ?? 0} {removing?.bots === 1 ? "bot" : "bots"}, every conversation and the bots&apos; files on the computer are deleted. This can&apos;t be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep them</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => removing && void remove(removing)}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
