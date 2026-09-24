import type { MetadataRoute } from "next";

/** Installable from a phone's browser too: Add to Home Screen opens on the conversations. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Kru Bot",
    short_name: "Kru Bot",
    description: "Your team of always-on AI bots, each with its own computer.",
    start_url: "/app",
    display: "standalone",
    background_color: "#f5f3ee",
    theme_color: "#f5f3ee",
    icons: [{ src: "/logo.png", sizes: "512x512", type: "image/png", purpose: "any" }],
  };
}
