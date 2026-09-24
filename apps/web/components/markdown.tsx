import { CircleAlert, Info, Lightbulb, OctagonAlert, Square, SquareCheck, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";
import { Separator } from "@/components/ui/separator";
import { parseInline, parseMarkdown, type Align, type Block, type Callout, type Inline, type ListItem } from "@/lib/markdown";
import { cn } from "@/lib/utils";

/*
 * A bot's message as light Markdown. Every block is spaced by the column it
 * sits in, a heading gets a little more room above it than below, and
 * nothing is coloured but by the theme's tokens: inline code, a table's
 * head and a callout are `bg-bubble-inset`, a step off either bubble in both
 * themes (never `bg-muted`, which is the bot bubble's own grey in the light
 * one), tables sit in their own
 * rounded, scrolling frame, and lists draw their own markers so nested,
 * numbered and task lists line up however the agent indented them.
 */

function Inlines({ inlines }: { inlines: Inline[] }) {
  return (
    <>
      {inlines.map((inline, i) => {
        switch (inline.kind) {
          case "text":
            return <span key={i}>{inline.text}</span>;
          case "code":
            return (
              <code key={i} className="rounded-md bg-bubble-inset px-1.5 py-0.5 font-mono text-[0.875em] text-foreground [overflow-wrap:anywhere]">
                {inline.text}
              </code>
            );
          case "bold":
            return (
              <strong key={i} className="font-semibold">
                <Inlines inlines={inline.children} />
              </strong>
            );
          case "italic":
            return (
              <em key={i}>
                <Inlines inlines={inline.children} />
              </em>
            );
          case "strike":
            return (
              <s key={i} className="text-muted-foreground">
                <Inlines inlines={inline.children} />
              </s>
            );
          case "link":
            return (
              <a key={i} href={inline.href} target="_blank" rel="noreferrer noopener" className="font-medium underline decoration-muted-foreground/50 underline-offset-2 [overflow-wrap:anywhere] hover:decoration-foreground">
                {inline.text}
              </a>
            );
          default:
            return null;
        }
      })}
    </>
  );
}

const ALIGN: Record<Align, string> = { left: "text-left", center: "text-center", right: "text-right" };

const HEADING: Record<number, string> = {
  1: "text-[1.2em] leading-snug font-semibold tracking-tight",
  2: "text-[1.1em] leading-snug font-semibold tracking-tight",
  3: "font-semibold",
};

/** Bullets change with depth, as they do in any editor. */
const BULLETS = ["•", "◦", "▪"];

function Marker({ item }: { item: ListItem }) {
  if (item.task !== null) {
    const Icon = item.task ? SquareCheck : Square;
    return <Icon aria-label={item.task ? "Done" : "Not done"} className="mt-[0.3em] size-[1em] shrink-0 text-muted-foreground" />;
  }
  return (
    <span aria-hidden="true" className="shrink-0 text-right text-muted-foreground tabular-nums select-none" style={{ minWidth: item.ordered ? "1.4em" : "0.8em" }}>
      {item.ordered ? item.marker : BULLETS[item.depth % BULLETS.length]}
    </span>
  );
}

function List({ block }: { block: Extract<Block, { kind: "list" }> }) {
  const Tag = block.ordered ? "ol" : "ul";
  return (
    <Tag className="flex list-none flex-col gap-1">
      {block.items.map((item, i) => (
        <li key={i} value={item.ordered ? parseInt(item.marker, 10) : undefined} className="flex gap-2" style={{ paddingLeft: `${item.depth * 1.25}em` }}>
          <Marker item={item} />
          <span className="min-w-0 flex-1 whitespace-pre-wrap">
            <Inlines inlines={item.inlines} />
          </span>
        </li>
      ))}
    </Tag>
  );
}

const CALLOUTS: Record<Callout, { label: string; icon: ReactNode }> = {
  note: { label: "Note", icon: <Info aria-hidden="true" className="size-3.5" /> },
  tip: { label: "Tip", icon: <Lightbulb aria-hidden="true" className="size-3.5" /> },
  important: { label: "Important", icon: <CircleAlert aria-hidden="true" className="size-3.5" /> },
  warning: { label: "Warning", icon: <TriangleAlert aria-hidden="true" className="size-3.5" /> },
  caution: { label: "Caution", icon: <OctagonAlert aria-hidden="true" className="size-3.5" /> },
};

function Blocks({ blocks }: { blocks: Block[] }) {
  return blocks.map((block, i) => <BlockView key={i} block={block} />);
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "paragraph":
      return (
        <p className="whitespace-pre-wrap">
          <Inlines inlines={block.inlines} />
        </p>
      );
    case "heading": {
      // Headings are part of a message, not the page's outline, so they are styled text, not h1–h6.
      return (
        <p role="heading" aria-level={Math.min(block.level + 2, 6)} className={cn("[&:not(:first-child)]:mt-1.5", HEADING[block.level] ?? "font-semibold text-muted-foreground")}>
          <Inlines inlines={block.inlines} />
        </p>
      );
    }
    case "list":
      return <List block={block} />;
    case "quote":
      if (block.callout) {
        const callout = CALLOUTS[block.callout];
        return (
          <div className="flex flex-col gap-1.5 rounded-xl bg-bubble-inset px-3 py-2.5">
            <p className="flex items-center gap-1.5 text-[12px] font-medium tracking-wide text-muted-foreground uppercase">
              {callout.icon}
              {callout.label}
            </p>
            <Blocks blocks={block.blocks} />
          </div>
        );
      }
      return (
        <blockquote className="flex flex-col gap-2 border-l-2 border-foreground/15 pl-3 text-muted-foreground">
          <Blocks blocks={block.blocks} />
        </blockquote>
      );
    case "code":
      // Its language and Copy in a header when it says what it is; otherwise Copy sits in the corner.
      return (
        <div className="group/code relative overflow-hidden rounded-xl border bg-background">
          {block.lang ? (
            <div className="flex h-8 items-center justify-between border-b pr-1 pl-3 font-mono text-[11px] text-muted-foreground pointer-coarse:h-11">
              <span>{block.lang}</span>
              <CopyButton text={block.text} label="Copy code" className="size-7 pointer-coarse:size-10" />
            </div>
          ) : (
            <CopyButton text={block.text} label="Copy code" className="absolute top-1.5 right-1.5 opacity-0 group-hover/code:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100" />
          )}
          <pre className={cn("scroll-fade-x overflow-x-auto p-3 font-mono text-[12px] leading-5 text-foreground", !block.lang && "pr-10")}>
            <code className="bg-transparent p-0">{block.text}</code>
          </pre>
        </div>
      );
    case "table":
      // Its own scroller: a wide table shouldn't stretch the bubble.
      return (
        <div className="scroll-fade-x overflow-x-auto rounded-xl border bg-background">
          <table className="w-full border-collapse text-[13px] leading-5 tabular-nums">
            <thead className="bg-bubble-inset">
              <tr>
                {block.head.map((cell, i) => (
                  <th key={i} className={cn("border-b px-3 py-2 font-medium whitespace-nowrap", ALIGN[block.align[i] ?? "left"])}>
                    <Inlines inlines={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r} className="border-b last:border-b-0">
                  {row.map((cell, c) => (
                    <td key={c} className={cn("px-3 py-2 align-top whitespace-pre-wrap", ALIGN[block.align[c] ?? "left"])}>
                      <Inlines inlines={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "rule":
      return <Separator className="my-1 bg-foreground/10" />;
    default:
      return null;
  }
}

/** A message body as light Markdown: paragraphs, lists, code, tables, links. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={className ?? "flex flex-col gap-2 text-[14px] leading-6"}>
      <Blocks blocks={parseMarkdown(text)} />
    </div>
  );
}

export function InlineMarkdown({ text }: { text: string }) {
  return <Inlines inlines={parseInline(text)} />;
}
