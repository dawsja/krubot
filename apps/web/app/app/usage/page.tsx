import type { Metadata } from "next";
import { UsageScreen } from "@/components/usage-page";

export const metadata: Metadata = { title: "Usage" };

export default function UsagePage() {
  return <UsageScreen />;
}
