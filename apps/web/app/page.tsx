import { redirect } from "next/navigation";

/** Kru Bot is a self-hosted app, so the root goes straight to your bots. */
export default function Home() {
  redirect("/app");
}
