// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

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
