import { Separator } from "@/components/ui/separator";
import { parseInline, parseMarkdown, type Block, type Inline } from "@/lib/markdown";

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
      return (
        <pre className="overflow-x-auto rounded-lg bg-foreground/90 p-3 font-mono text-[12px] leading-5 text-background dark:bg-black/40">
          <code>{block.text}</code>
        </pre>
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
