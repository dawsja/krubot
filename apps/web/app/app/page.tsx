import { ChatsScreen } from "@/components/chats-screen";
import { EmptyState } from "@/components/empty-state";

/** A phone opens on the conversations; a desktop has them in the sidebar and shows the lineup. */
export default function AppHome() {
  return (
    <>
      <ChatsScreen className="wide:hidden" />
      <EmptyState className="hidden wide:flex" />
    </>
  );
}
