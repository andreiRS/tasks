export const COLUMNS = ["backlog", "ready", "doing", "blocked", "review", "done"];

/**
 * Sibling directory holding archived tasks. NOT a Column: transitions never
 * target it, list/board/next skip it by default, and the only way in is the
 * dedicated `tasks archive` command. See `docs/adr/0010-archive-as-sibling-directory.md`.
 */
export const ARCHIVE_DIR = "archive";

/**
 * Allowed enum values for the M8 frontmatter fields.
 */
export const ATTENDANCE_VALUES = ["attended", "unattended"] as const;
export const EFFORT_VALUES = ["low", "medium", "high"] as const;
export const DEFAULT_ATTENDANCE: "attended" = "attended";
export const DEFAULT_EFFORT: "medium" = "medium";
