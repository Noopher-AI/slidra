// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: Copyright contributors to the Slidra project

import { describe, expect, it } from "vitest";
import { workbenchPageUrl } from "../src/workbench-navigation.js";

describe("workbench navigation", () => {
  it("builds a full-page editor URL carrying only the non-secret workbench id", () => {
    const url = new URL(workbenchPageUrl("http://editor.test/current?old=1", "wb B/7"));

    expect(url.origin).toBe("http://editor.test");
    expect(url.pathname).toBe("/");
    expect(url.searchParams.get("workbench")).toBe("wb B/7");
    expect([...url.searchParams.keys()]).toEqual(["workbench"]);
    expect(url.href).not.toContain("credential");
    expect(url.href).not.toContain("token");
  });
});
