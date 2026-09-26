/** @type {import("next").NextConfig} */
const nextConfig = {
  // The viewer wires itself onto the DOM once; dev-mode double effects would double its listeners.
  reactStrictMode: false,
  // Route handlers read decks and specs from disk; ship them with the functions.
  outputFileTracingIncludes: {
    "/api/decks": ["./decks/**/*.slidra", "./examples/**/*.slidra"],
    "/decks/**": ["./decks/**/*.slidra", "./examples/**/*.slidra"],
    "/spec/**": ["./spec/**/*.md"],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
      },
    ];
  },
};

export default nextConfig;
