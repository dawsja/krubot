"use client";

import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { changeServer, useNativeShell } from "@/lib/shell";

const never = () => () => {};

/** Settings → Account, in the desktop and Android apps only: which Kru Bot the app is pointed at. */
export function ServerCard() {
  const shell = useNativeShell();
  const origin = useSyncExternalStore(never, () => window.location.origin, () => "");
  if (!shell) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>This app</CardTitle>
        <CardDescription>Kru Bot {shell === "android" ? "for Android" : "for the desktop"} is connected to {origin}.</CardDescription>
        <CardAction>
          <Button variant="outline" size="sm" onClick={changeServer}>
            Change server
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="text-[13.5px] text-muted-foreground">Changing the server takes you back to Connect; your sign-in here stays until you sign out.</CardContent>
    </Card>
  );
}
