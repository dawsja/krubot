"use client";

import { BellOff, BellRing } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import { post } from "@/lib/api";
import { currentSubscription, disablePush, enablePush, pushPermission, pushSupported } from "@/lib/push";
import { mobileShell, useNativeShell } from "@/lib/shell";

type State = "checking" | "unsupported" | "off" | "on" | "blocked";

/**
 * Settings → Account → Notifications: turn browser push on or off for this
 * browser. In the Android app there is no Web Push; the phone's own
 * notifications are asked for instead, and the app shows what the API
 * announces while it is open or in the background.
 */
export function NotificationsCard() {
  const shell = useNativeShell();
  const [state, setState] = useState<State>("checking");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const read = async () => {
      const mobile = mobileShell();
      if (mobile) {
        const permission = mobile.notificationsState();
        return setState(permission === "granted" ? "on" : permission === "denied" ? "blocked" : "off");
      }
      if (!pushSupported()) return setState("unsupported");
      if (pushPermission() === "denied") return setState("blocked");
      setState((await currentSubscription()) ? "on" : "off");
    };
    void Promise.resolve().then(read);
    // The Android app raises this once the person answered its permission prompt.
    const onChange = () => void read();
    window.addEventListener("kru:notifications", onChange);
    return () => window.removeEventListener("kru:notifications", onChange);
  }, []);

  async function turnOn() {
    const mobile = mobileShell();
    if (mobile) return mobile.requestNotifications();
    setBusy(true);
    try {
      await enablePush();
      setState("on");
      toast.add({ type: "success", title: "Notifications are on for this browser." });
    } catch (failure) {
      if (pushPermission() === "denied") setState("blocked");
      toast.add({ type: "error", title: failure instanceof Error ? failure.message : "Could not turn notifications on." });
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    const mobile = mobileShell();
    // The phone's own switch: the system settings for the app.
    if (mobile) return mobile.requestNotifications();
    setBusy(true);
    try {
      await disablePush();
      setState("off");
    } finally {
      setBusy(false);
    }
  }

  function sendTest() {
    const mobile = mobileShell();
    if (mobile) {
      mobile.notify("Kru Bot", "Notifications are on for this phone.", "/app/settings", "test");
      return;
    }
    void post<{ sent: number }>("/api/push/test").then((d) => toast.add({ type: "info", title: d.sent ? "Test sent." : "No subscribed browser answered." }));
  }

  const android = shell === "android";
  const where = android ? "this phone" : "this browser";
  return (
    <Card>
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>
          A notification on this device when a bot finishes a job for you or needs your input: an approval, a secret, a question. Quiet when that conversation is already in front of you. Each bot has its own switch in its profile.
          {android ? " On Android they arrive while Kru Bot is open or in the background." : ""}
        </CardDescription>
        <CardAction>
          {state === "on" ? (
            <Button variant="outline" size="sm" disabled={busy} onClick={() => void turnOff()}>
              {busy ? <Spinner data-icon="inline-start" /> : <BellOff data-icon="inline-start" aria-hidden="true" />}
              Turn off
            </Button>
          ) : (
            <Button size="sm" disabled={busy || state === "unsupported" || (state === "blocked" && !android) || state === "checking"} onClick={() => void turnOn()}>
              {busy ? <Spinner data-icon="inline-start" /> : <BellRing data-icon="inline-start" aria-hidden="true" />}
              Turn on
            </Button>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <Badge variant={state === "on" ? "default" : "outline"}>{state === "checking" ? "Checking…" : state === "on" ? "On" : state === "off" ? "Off" : state === "blocked" ? "Blocked" : "Unavailable"}</Badge>
          <span className="text-[13.5px] text-muted-foreground">
            {state === "on"
              ? android
                ? "This phone shows them."
                : "This browser is subscribed."
              : state === "off"
                ? `Not on for ${where} yet.`
                : state === "blocked"
                  ? android
                    ? "Notifications are off for Kru Bot in the phone's settings. Turn on opens them."
                    : "The browser blocks notifications for this site. Allow them in its site settings, then try again."
                  : state === "unsupported"
                    ? "Push needs a secure address (https, or localhost) and a browser that supports it."
                    : ""}
          </span>
        </div>
        {state === "on" ? (
          <div>
            <Button variant="ghost" size="sm" onClick={sendTest}>
              Send a test
            </Button>
          </div>
        ) : null}
        {state === "unsupported" ? (
          <Alert>
            <AlertTitle>Not available on this address</AlertTitle>
            <AlertDescription>Open Kru Bot over https (a reverse proxy with TLS, see the README) or on localhost to use push notifications.</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}
