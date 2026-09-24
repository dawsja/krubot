import type { NextConfig } from "next";

const devOrigins = (process.env.KRU_DEV_ORIGINS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  // The Docker build sets KRU_STANDALONE=1 to get a self-contained server.
  output: process.env.KRU_STANDALONE ? "standalone" : undefined,
  allowedDevOrigins: devOrigins,
  poweredByHeader: false,
  transpilePackages: ["@krubot/shared"],
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
