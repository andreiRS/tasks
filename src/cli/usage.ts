export const USAGE = `Usage: tasks <command> [options]

Commands:
  new <title> [--effort <low|medium|high>] [--deps <id|uuid>]... [--unattended]
              [--body -] [--edit] [--json]
                          Create a new task in backlog.
  show <id|uuid> [--json] [--no-color]
                          Print a task with its dependency edges.
  list [--column <col>]... [--attendance <attended|unattended>]
       [--effort <low|medium|high>] [--all] [--since <Nd>] [--archived]
       [--json] [--no-color]
                          List tasks (done items older than 7d hidden by default;
                          --archived shows only archive/).
  board [--all] [--since <Nd>] [--json] [--no-color]
                          Render the kanban board grouped by column.
  mv <id|uuid> <column> [--json]
                          Move a task to another column.
  rm <id|uuid> [--force] [--json]
                          Delete a task (--force strips dependents).
  edit <id|uuid> [--json] | edit --abort
                          Open the task in \$EDITOR; --abort discards pending edits.
  link <id|uuid> --depends-on <id|uuid>... [--json]
                          Add dependencies to a task.
  unlink <id|uuid> --depends-on <id|uuid>... [--json]
                          Remove dependencies from a task.
  set <id|uuid> [--title <title>] [--attendance <attended|unattended>]
                [--effort <low|medium|high>] [--json]
                          Update task fields in-place.
  next [--attendance <attended|unattended>] [--unattended] [--json] [--no-color]
                          Print the oldest ready task whose deps are all done.
  init [--json]           Create the per-project store (idempotent).
  undo [--json]           Revert the most recent store commit.
  doctor                  Report store path, git status, and stash count.
  archive [<id|uuid>] [--before <Nd>] [--json]
                          Retire done/ tasks into archive/ (no-arg = all).
  export --json [--include-archived] [--columns <col,col,...>]
                          Whole-Store JSON dump for agents (live tasks + dep graph).
  summary --json [--recent <N>] [--stale <Nd>]
                          Compact Store digest: per-column counts, recent tasks,
                          and stale tasks in doing/blocked/review.
  help                    Show this message.
  version                 Print the CLI version.

Global flags:
  --json                  Emit machine-readable JSON instead of human output.
  -h, --help              Show this message.
  -V, --version           Print the CLI version.

Store location: \$TASKS_HOME/projects/<encoded-cwd>/ (default \$HOME/.tasks).
`;
