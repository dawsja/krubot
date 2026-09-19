import type { ReactNode } from "react";
import { Bubble, BubbleContent } from "@/components/ui/bubble";
import { cn } from "@/lib/utils";

/**
 * The shell every card a bot puts in a conversation shares: an approval, a
 * secret, a sign-in, a connected app. One shape, in the same grey with the
 * same edge as a button or a field, so a thing you have to answer always
 * looks the same. What is waiting is said by the buttons inside it, not by
 * a colour.
 */
export function ActionCard({ icon, title, children, className }: { icon: ReactNode; title: ReactNode; children: ReactNode; className?: string }) {
  return (
    <Bubble variant="outline" className={cn("max-w-[80%]", className)}>
      <BubbleContent className="flex flex-col gap-2 rounded-2xl border-primary-edge p-3">
        <p className="flex items-start gap-1.5 text-[12px] font-medium tracking-wide text-muted-foreground uppercase">
          {/* On the first line, not centred between two, when the title wraps. */}
          <span className="mt-px shrink-0">{icon}</span>
          <span>{title}</span>
        </p>
        {children}
      </BubbleContent>
    </Bubble>
  );
}
