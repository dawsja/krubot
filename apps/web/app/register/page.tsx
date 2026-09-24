import { redirect } from "next/navigation";
import { connection } from "next/server";
import { AuthShell } from "@/components/auth-shell";
import { countAccounts } from "@/lib/session";
import { RegisterForm } from "./register-form";

export default async function RegisterPage() {
  await connection();
  const accounts = await countAccounts();
  if (accounts !== null && accounts > 0) redirect("/login");
  return (
    <AuthShell eyebrow="First run" title="Create your account" description="Kru Bot has one account: yours. Enter the setup token from the API's logs to prove you run this server.">
      <RegisterForm />
    </AuthShell>
  );
}
