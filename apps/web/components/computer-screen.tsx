"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { ComputerPanel } from "@/components/computer-panel";
import { useStore } from "@/components/store";

/** /app/computer: the desktop, full screen; closing it goes back to the conversations. The admin's only. */
export function ComputerScreen() {
  const router = useRouter();
  const { admin } = useStore();
  useEffect(() => {
    if (!admin) router.replace("/app");
  }, [admin, router]);
  if (!admin) return null;
  return <ComputerPanel onClose={() => router.push("/app")} />;
}
