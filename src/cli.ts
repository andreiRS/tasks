#!/usr/bin/env bun
const args = process.argv.slice(2);
const [command, ...rest] = args;

if (command === "new") {
  const title = rest[0];
  if (!title || title.trim() === "") {
    process.stderr.write("tasks: INVALID_TITLE: title is required\n");
    process.exit(1);
  }
}

process.exit(0);
