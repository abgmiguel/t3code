import { describe, expect, it } from "vitest";

import { resolveWindowUrlForNewWindow } from "./windowUrl";

describe("resolveWindowUrlForNewWindow", () => {
  it("reuses a valid source URL to clone route + search", () => {
    const sourceUrl = "t3://app/index.html#/chat/thread-123?diff=1";
    const fallbackUrl = "t3://app/index.html";

    expect(resolveWindowUrlForNewWindow(sourceUrl, fallbackUrl)).toBe(sourceUrl);
  });

  it("falls back when source URL is invalid", () => {
    const fallbackUrl = "t3://app/index.html";

    expect(resolveWindowUrlForNewWindow("not-a-url", fallbackUrl)).toBe(fallbackUrl);
  });

  it("falls back when source URL is not from the desktop app origin", () => {
    const sourceUrl = "https://example.com/#/chat/thread-123";
    const fallbackUrl = "t3://app/index.html";

    expect(resolveWindowUrlForNewWindow(sourceUrl, fallbackUrl)).toBe(fallbackUrl);
  });
});
