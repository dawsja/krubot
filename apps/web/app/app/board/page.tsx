import type { Metadata } from "next";
import { BoardScreen } from "@/components/board";

export const metadata: Metadata = { title: "Board" };

export default function BoardPage() {
  return <BoardScreen />;
}
