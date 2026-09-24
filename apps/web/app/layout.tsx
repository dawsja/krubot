import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { THEME_INIT_SCRIPT } from "@/lib/theme/theme";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"], weight: ["400", "500", "600", "700"] });
const jetbrains = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"], weight: ["400", "500", "600"] });

export const metadata: Metadata = {
  title: { default: "Kru Bot", template: "%s · Kru Bot" },
  description: "Your team of always-on AI bots, each with its own computer. Self-hosted and open source.",
  applicationName: "Kru Bot",
  robots: { index: false, follow: false },
  icons: { icon: "/favicon.ico", apple: "/logo.png" },
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Kru Bot", statusBarStyle: "default" },
};

/*
 * A phone: the page reaches under the bars (viewport-fit), the composer
 * moves up with the keyboard (interactive-widget), and the bars take the
 * page's colour in either theme. It is an app, not a page, so it doesn't
 * pinch zoom (the phone's own font size still applies); the Android app
 * says the same to its WebView.
 */
export const viewport: Viewport = {
  colorScheme: "light dark",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f3ee" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0c0e" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrains.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="flex min-h-full flex-col bg-background font-sans text-foreground">
        <ThemeProvider>
          <TooltipProvider>
            <Toaster>{children}</Toaster>
          </TooltipProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
