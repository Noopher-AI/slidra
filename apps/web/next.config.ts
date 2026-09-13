// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Slidra's resident CLI and its export worker serve the generated files
  // directly. A static export keeps that architecture intact while letting
  // Vercel recognize and optimize the frontend as a Next.js application.
  output: "export",
  distDir: "dist",
  // The browser modules use TypeScript's standard ESM convention: source
  // imports end in .js so the specifiers stay valid if TypeScript emits them.
  // Webpack's extension aliases let Next resolve those specifiers to their
  // .ts/.tsx sources without rewriting the application module graph.
  webpack(config) {
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    config.module.rules.push({
      resourceQuery: /raw/,
      type: "asset/source",
    });
    return config;
  },
};

export default nextConfig;
