// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

const description =
  "One presentation, with native interfaces for humans and agents. Drag slides in the editor or drive the same commands from a shell.";

export const metadata: Metadata = {
  title: "Slidra — The slide harness for coding agents",
  description,
  openGraph: {
    type: "website",
    siteName: "Slidra",
    title: "Slidra — The slide harness for coding agents",
    description,
    url: "https://slidra.vercel.app",
  },
  twitter: {
    card: "summary_large_image",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
