#!/usr/bin/env bun
import { storeDir, ensureStore, createTask } from "./store.ts";

const args = process.argv.slice(2);
const [command, ...rest] = args;

if (command === "new") {
  const title = rest[0];
  if (!title || title.trim() === "") {
    process.stderr.write("tasks: INVALID_TITLE: title is required\n");
    process.exit(1);
  }

  const dir = storeDir(process.cwd());
  await ensureStore(dir);
  const id = await createTask(dir, title);
  process.stdout.write(`task: new #${id} — ${title}\n`);
}

process.exit(0);
