import { redirect } from "next/navigation";
import { connection } from "next/server";
import { AuthShell } from "@/components/auth-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { countAccounts, getAuthConfig, getSessionUser, safeNext } from "@/lib/session";
import { ChangeServer } from "./change-server";
import { LoginForm } from "./login-form";
import { OidcButton } from "./oidc-button";

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const { next, error } = await searchParams;
  const target = safeNext(typeof next === "string" ? next : null, "/app");
  const accounts = await countAccounts();
  if (accounts === 0) redirect("/register");
  if (await getSessionUser()) redirect(target);
  const config = await getAuthConfig();
  const oidc = config?.oidc ?? null;
  return (
    <AuthShell eyebrow="Sign in" title="Welcome back" description={oidc ? `Sign in with ${oidc.name}, or with the admin account.` : "Sign in to your bots."}>
      {accounts === null ? (
        <Alert className="mb-4">
          <AlertTitle>The API isn&apos;t answering.</AlertTitle>
          <AlertDescription>Is the api container running?</AlertDescription>
        </Alert>
      ) : null}
      {typeof error === "string" && error ? (
        <Alert className="mb-4">
          <AlertTitle>That sign-in didn&apos;t complete.</AlertTitle>
          <AlertDescription>{oidc ? `${oidc.name} sent you back without signing you in. Try again, or ask your admin.` : "Try again, or ask your admin."}</AlertDescription>
        </Alert>
      ) : null}
      {oidc ? (
        <>
          <OidcButton name={oidc.name} next={target} />
          <div className="my-5 flex items-center gap-3 text-[12px] text-ash">
            <Separator className="flex-1" />
            or the admin account
            <Separator className="flex-1" />
          </div>
        </>
      ) : null}
      <LoginForm next={target} />
      <ChangeServer />
    </AuthShell>
  );
}
