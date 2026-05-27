import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePath } from "../src/store.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "tasks-store-path-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("path resolver walks up to the nearest .git ancestor for store key", async () => {
  // Create a project root with a .git dir (empty dir is enough to satisfy existsSync check)
  const projRoot = join(tmp, "proj");
  mkdirSync(join(projRoot, ".git"), { recursive: true });

  // Create a nested subdir to run the command from
  const subDir = join(projRoot, "a", "b", "c");
  mkdirSync(subDir, { recursive: true });

  const tasksHome = join(tmp, "home");
  mkdirSync(tasksHome, { recursive: true });

  const cliPath = join(import.meta.dir, "..", "src", "cli.ts");

  const proc = Bun.spawn(["bun", "run", cliPath, "new", "hello"], {
    env: { ...process.env, TASKS_HOME: tasksHome },
    stdout: "pipe",
    stderr: "pipe",
    cwd: subDir,
  });

  const exitCode = await proc.exited;
  expect(exitCode).toBe(0);

  // The store should be keyed on the project root (where .git lives), NOT on subDir.
  const realProjRoot = realpathSync(projRoot);
  const expectedEncoded = encodePath(realProjRoot);
  const expectedStoreDir = join(tasksHome, "projects", expectedEncoded);

  // Exactly one store directory should exist under TASKS_HOME/projects/
  const projectsDir = join(tasksHome, "projects");
  const storeDirs = readdirSync(projectsDir);
  expect(storeDirs).toHaveLength(1);
  expect(storeDirs[0]).toBe(expectedEncoded);

  // That directory must be the one encoding projRoot, not subDir
  const realSubDir = realpathSync(subDir);
  const subDirEncoded = encodePath(realSubDir);
  expect(storeDirs[0]).not.toBe(subDirEncoded);

  // The store dir itself must exist (sanity check)
  const { existsSync } = await import("node:fs");
  expect(existsSync(expectedStoreDir)).toBe(true);
});
