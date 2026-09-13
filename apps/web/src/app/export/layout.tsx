// Copyright 2026 Noopher AI
// SPDX-License-Identifier: Apache-2.0

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Slidra Export",
  description: null,
  openGraph: null,
  twitter: null,
};

export default function ExportLayout({ children }: Readonly<{ children: ReactNode }>) {
  return children;
}
