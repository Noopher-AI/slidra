/** @type {import("next").NextConfig} */
const nextConfig = {
  // The viewer wires itself onto the DOM once; dev-mode double effects would double its listeners.
  reactStrictMode: false,
  // Route handlers read decks and specs from disk; ship them with the functions.
  outputFileTracingIncludes: {
    "/api/decks": ["./decks/**/*.slidra", "./examples/**/*.slidra"],
    "/decks/**": ["./decks/**/*.slidra", "./examples/**/*.slidra"],
    "/api/og": ["./decks/**/*.slidra", "./examples/**/*.slidra"],
    "/": ["./decks/**/*.slidra", "./examples/**/*.slidra"],
    "/spec/**": ["./spec/**/*.md", "./spec/**/*.json"],
  },
  async headers() {
    // /embed may be framed by other sites (SLIDRA_EMBED_ORIGINS narrows which, space-separated); every other page only by this one.
    const embedAncestors = (process.env.SLIDRA_EMBED_ORIGINS ?? "").trim() || "*";
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
      {
        source: "/((?!embed$|embed/).*)",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
        ],
      },
      {
        source: "/embed",
        headers: [{ key: "Content-Security-Policy", value: `frame-ancestors ${embedAncestors}` }],
      },
    ];
  },
};

export default nextConfig;
