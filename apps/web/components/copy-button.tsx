"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";
import { copyToClipboard } from "@/components/hq/clipboard";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";

/** A small copy button that says it worked with a tick for a moment. */
export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={copied ? "Copied" : label}
      className={className}
      onClick={() =>
        void copyToClipboard(text).then((ok) => {
          if (ok) setCopied(true);
          else toast.add({ type: "error", title: "Couldn't copy it." });
        })
      }
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
    </Button>
  );
}
