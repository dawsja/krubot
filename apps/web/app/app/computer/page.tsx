import type { Metadata } from "next";
import { ComputerScreen } from "@/components/computer-screen";

export const metadata: Metadata = { title: "Computer" };

/** The bots' computer as a screen of its own: the Computer tab on a phone. */
export default function ComputerPage() {
  return <ComputerScreen />;
}
