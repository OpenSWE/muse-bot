// Read-only commands against the real account (DECISIONS.md Q10). Run with MUSE_LIVE=1
// after `muse-bot auth export`; write commands are checked by hand before a release.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const cli = async (...args: string[]) => {
  const { stdout } = await run("node", ["src/cli.ts", "--no-auto-login", ...args], {
    timeout: 60_000,
  });
  return JSON.parse(stdout);
};

describe.runIf(process.env.MUSE_LIVE === "1")("live, read-only", { timeout: 60_000 }, () => {
  it("status", async () => {
    const s = await cli("status");
    expect(s.vm_id).toMatch(/\S/);
    expect(typeof s.sessions).toBe("number");
  });

  it.each([
    ["threads"],
    ["history", "--limit", "2"],
    ["feed", "--limit", "2"],
    ["goals"],
    ["ideas"],
  ])("%s lists rows", async (...args) => {
    expect(Array.isArray(await cli(...args))).toBe(true);
  });

  it.each([["unread"], ["feed-status"], ["raw", "sessions.list"]])(
    "%s returns an object",
    async (...args) => {
      expect(typeof (await cli(...args))).toBe("object");
    },
  );
});
