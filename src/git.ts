import { TasksError } from "./errors.ts";

/**
 * Run a git command in the given directory. Returns exit code.
 */
export async function git(args: string[], cwd: string): Promise<number> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return proc.exited;
}

/** Built-in committer identity used only when the environment has none. */
const FALLBACK_NAME = "tasks";
const FALLBACK_EMAIL = "tasks@localhost";

/**
 * Git `-c` flags that inject the built-in committer identity, but ONLY when
 * the store has no `user.name`/`user.email` resolvable from config. Humans
 * with a configured git identity keep their attribution; CI runners,
 * containers, and fresh agent shells (which routinely have neither a global
 * identity nor gecos auto-detection) get a deterministic identity so commits
 * never fail. Prepend before any git subcommand that writes a commit.
 */
export async function identityArgs(dir: string): Promise<string[]> {
  const configured = async (key: string): Promise<boolean> => {
    const proc = Bun.spawn(["git", "-C", dir, "config", key], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    const value = (await new Response(proc.stdout).text()).trim();
    return code === 0 && value.length > 0;
  };
  if ((await configured("user.name")) && (await configured("user.email"))) {
    return [];
  }
  return ["-c", `user.name=${FALLBACK_NAME}`, "-c", `user.email=${FALLBACK_EMAIL}`];
}

/**
 * Commit staged changes in `dir`. Injects the fallback identity when none is
 * configured, and throws GIT_ERROR on a non-zero exit so a failed commit can
 * never masquerade as a successful mutation (the store's core invariant is
 * that every mutation lands as a commit). `extraArgs` follow `-m <message>`.
 */
export async function gitCommit(
  dir: string,
  message: string,
  extraArgs: string[] = []
): Promise<void> {
  const ident = await identityArgs(dir);
  const code = await git([...ident, "commit", "-m", message, ...extraArgs], dir);
  if (code !== 0) {
    throw new TasksError("GIT_ERROR", `git commit failed in ${dir}`, { dir });
  }
}

/**
 * Run `git -C <dir> <args>` capturing stdout/stderr. Returns trimmed stdout
 * when exit code is 0; throws otherwise with the combined stderr.
 */
export async function gitCapture(dir: string, args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", "-C", dir, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`);
  }
  return stdout.trim();
}
