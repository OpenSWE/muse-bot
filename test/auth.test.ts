import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cookieHeader, importCookies, parseCookies, saveJar } from "../src/auth.ts";
import { AuthError } from "../src/gateway.ts";

describe("parseCookies", () => {
  const want = [
    ["hatch_sess", "abc=="],
    ["datr", "xyz"],
  ];

  it("reads a header line", () => {
    expect(parseCookies("hatch_sess=abc==; datr=xyz\n")).toEqual(want);
  });

  it("reads a Netscape jar", () => {
    const jar =
      "# Netscape HTTP Cookie File\n.muse.ai\tTRUE\t/\tTRUE\t0\thatch_sess\tabc==\nmuse.ai\tFALSE\t/\tTRUE\t0\tdatr\txyz\n";
    expect(parseCookies(jar)).toEqual(want);
  });

  it("reads flat and nested JSON", () => {
    expect(parseCookies('{"hatch_sess":"abc==","datr":"xyz"}')).toEqual(want);
    expect(parseCookies('{"cookies":{"hatch_sess":"abc==","datr":"xyz"}}')).toEqual(want);
  });

  it("builds a header back", () => {
    expect(cookieHeader(parseCookies("hatch_sess=abc==; datr=xyz"))).toBe(
      "hatch_sess=abc==; datr=xyz",
    );
  });
});

describe("saveJar", () => {
  it("writes mode 600 and keeps a backup", () => {
    const path = join(mkdtempSync(join(tmpdir(), "muse-bot-")), "cookies.txt");
    writeFileSync(path, "old");
    importCookies("hatch_sess=abc; datr=xyz", path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(`${path}.bak`, "utf8")).toBe("old");
    expect(parseCookies(readFileSync(path, "utf8"))).toEqual([
      ["hatch_sess", "abc"],
      ["datr", "xyz"],
    ]);
  });

  it("never replaces a jar with a logged-out one", () => {
    const path = join(mkdtempSync(join(tmpdir(), "muse-bot-")), "cookies.txt");
    writeFileSync(path, "hatch_sess=keep");
    expect(() => saveJar([{ name: "datr", value: "x", domain: ".muse.ai" }], path)).toThrow(
      AuthError,
    );
    expect(readFileSync(path, "utf8")).toBe("hatch_sess=keep");
  });
});
