"use client";

import { useRouter } from "next/navigation";
import { ComputerPanel } from "@/components/computer-panel";

/** /app/computer: your desktop on the computer, full screen; closing it goes back to the conversations. */
export function ComputerScreen() {
  const router = useRouter();
  return <ComputerPanel onClose={() => router.push("/app")} />;
}
