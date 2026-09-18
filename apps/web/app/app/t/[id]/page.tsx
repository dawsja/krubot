import { Conversation } from "@/components/conversation";

export default async function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Conversation key={id} threadId={id} />;
}
