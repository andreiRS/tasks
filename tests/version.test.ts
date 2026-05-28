import { test, expect } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";

const ROOT = join(import.meta.dir, "..");
const CLI = join(ROOT, "src", "cli.ts");
const PKG_VERSION = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { version: string }).version;

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return { exitCode, stdout, stderr };
}

test("--version prints package version on stdout and exits 0", async () => {
  const { exitCode, stdout, stderr } = await runCli(["--version"]);
  expect(exitCode).toBe(0);
  expect(stdout.trim()).toBe(PKG_VERSION);
  expect(stderr).toBe("");
});

test("-V is an alias for --version", async () => {
  const { exitCode, stdout } = await runCli(["-V"]);
  expect(exitCode).toBe(0);
  expect(stdout.trim()).toBe(PKG_VERSION);
});

test("version subcommand also prints the version", async () => {
  const { exitCode, stdout } = await runCli(["version"]);
  expect(exitCode).toBe(0);
  expect(stdout.trim()).toBe(PKG_VERSION);
});
