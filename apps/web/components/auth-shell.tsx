import Image from "next/image";
import type { ReactNode } from "react";

export function BrandMark({ size = 28 }: { size?: number }) {
  return <Image src="/logo.png" alt="" width={size} height={size} className="rounded-full" style={{ width: size, height: size }} priority />;
}

/** Layout for the sign-in and first-run pages. */
export function AuthShell({ eyebrow, title, description, children }: { eyebrow: string; title: string; description: string; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="flex items-center gap-2 px-4 py-4 sm:px-8">
        <BrandMark />
        <span className="text-[14px] font-medium">Kru Bot</span>
      </header>
      <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-4 pb-24">
        <p className="text-[12px] font-medium uppercase tracking-[-0.32px] text-ash">{eyebrow}</p>
        <h1 className="mt-3 text-[28px] font-semibold tracking-[-0.56px]">{title}</h1>
        <p className="mt-2 mb-6 text-[14px] leading-6 text-muted-foreground">{description}</p>
        {children}
      </main>
    </div>
  );
}
