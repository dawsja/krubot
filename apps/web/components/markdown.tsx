import { CopyButton } from "@/components/copy-button";
import { Separator } from "@/components/ui/separator";
import { parseInline, parseMarkdown, type Align, type Block, type Inline } from "@/lib/markdown";
import { cn } from "@/lib/utils";

function Inlines({ inlines }: { inlines: Inline[] }) {
  return (
    <>
      {inlines.map((inline, i) => {
        switch (inline.kind) {
          case "text":
            return <span key={i}>{inline.text}</span>;
          case "code":
            return (
              <code key={i} className="rounded bg-muted px-1 py-0.5 font-mono text-[12.5px] text-foreground">
                {inline.text}
              </code>
            );
          case "bold":
            return (
              <strong key={i}>
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
              <a key={i} href={inline.href} target="_blank" rel="noreferrer noopener" className="underline decoration-ash underline-offset-2 hover:decoration-foreground">
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

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "paragraph":
      return (
        <p className="whitespace-pre-wrap">
          <Inlines inlines={block.inlines} />
        </p>
      );
    case "heading":
      return (
        <p className={block.level <= 2 ? "text-[14px] font-semibold" : "font-semibold"}>
          <Inlines inlines={block.inlines} />
        </p>
      );
    case "list":
      return (
        <ul className={block.ordered ? "list-decimal pl-5" : "list-disc pl-5"}>
          {block.items.map((item, i) => (
            <li key={i} style={{ marginLeft: item.depth * 12 }}>
              <Inlines inlines={item.inlines} />
            </li>
          ))}
        </ul>
      );
    case "quote":
      return (
        <blockquote className="border-l-2 pl-3 text-muted-foreground">
          <Inlines inlines={block.inlines} />
        </blockquote>
      );
    case "code":
      // Copy sits in the corner, shown on hover and always on a touch screen.
      return (
        <div className="group/code relative">
          <pre className="overflow-x-auto rounded-lg border bg-background p-3 pr-10 font-mono text-[12px] leading-5 text-foreground">
            <code>{block.text}</code>
          </pre>
          <CopyButton text={block.text} label="Copy code" className="absolute top-1.5 right-1.5 opacity-0 group-hover/code:opacity-100 pointer-coarse:opacity-100 focus-visible:opacity-100" />
        </div>
      );
    case "table":
      // Its own scroller: a wide table shouldn't stretch the bubble.
      return (
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                {block.head.map((cell, i) => (
                  <th key={i} className={cn("border-b border-primary-edge px-2 py-1.5 font-medium whitespace-nowrap", ALIGN[block.align[i] ?? "left"])}>
                    <Inlines inlines={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td key={c} className={cn("border-b border-primary-edge/60 px-2 py-1.5 align-top last:border-b-0", ALIGN[block.align[c] ?? "left"])}>
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
      return <Separator />;
    default:
      return null;
  }
}

/** A message body as light Markdown: paragraphs, lists, code, links. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseMarkdown(text);
  return (
    <div className={className ?? "flex flex-col gap-2 text-[14px] leading-6"}>
      {blocks.map((block, i) => (
        <BlockView key={i} block={block} />
      ))}
    </div>
  );
}

export function InlineMarkdown({ text }: { text: string }) {
  return <Inlines inlines={parseInline(text)} />;
}
