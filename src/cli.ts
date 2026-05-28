#!/usr/bin/env bun
import { USAGE } from "./cli/usage.ts";
import { run as newCmd } from "./commands/new.ts";
import { run as showCmd } from "./commands/show.ts";
import { run as listCmd } from "./commands/list.ts";
import { run as boardCmd } from "./commands/board.ts";
import { run as mvCmd } from "./commands/mv.ts";
import { run as rmCmd } from "./commands/rm.ts";
import { run as editCmd } from "./commands/edit.ts";
import { run as linkCmd } from "./commands/link.ts";
import { run as unlinkCmd } from "./commands/unlink.ts";
import { run as setCmd } from "./commands/set.ts";
import { run as nextCmd } from "./commands/next.ts";
import { run as initCmd } from "./commands/init.ts";
import { run as undoCmd } from "./commands/undo.ts";
import { run as doctorCmd } from "./commands/doctor.ts";

const COMMANDS: Record<string, (rest: string[]) => Promise<void>> = {
  new: newCmd,
  show: showCmd,
  list: listCmd,
  board: boardCmd,
  mv: mvCmd,
  rm: rmCmd,
  edit: editCmd,
  link: linkCmd,
  unlink: unlinkCmd,
  set: setCmd,
  next: nextCmd,
  init: initCmd,
  undo: undoCmd,
  doctor: doctorCmd,
};

const [command, ...rest] = process.argv.slice(2);

if (command === "help" || command === "--help" || command === "-h") {
  process.stdout.write(USAGE);
  process.exit(0);
}

if (command === undefined) {
  process.stderr.write(USAGE);
  process.exit(1);
}

const handler = COMMANDS[command];
if (!handler) {
  process.stderr.write(`tasks: unknown command: ${command}\n\n${USAGE}`);
  process.exit(1);
}

await handler(rest);
process.exit(0);
