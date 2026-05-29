import { shouldColor } from "./color.ts";

/**
 * Output context resolved once per invocation. `json` selects the JSON-mode
 * contract (envelopes on stdout, the Error envelope on stderr); `color` is the
 * single colour decision (`--no-color` / `NO_COLOR` / TTY), handed to the text
 * renderer so no command computes colour itself.
 */
export type OutputContext = { json: boolean; color: boolean };

/**
 * What every command hands back instead of writing output itself.
 *
 * Success carries the two representations of "what happened": `json` is the
 * value placed verbatim on stdout in JSON mode; `text(ctx)` produces the human
 * form in text mode. Either may be absent (a silent mutation returns neither;
 * a JSON-only command may omit `text`).
 *
 * Failure carries a stable `code` + `message` (+ optional `details`). In JSON
 * mode it becomes the Error envelope; otherwise a plain line. `plainFormat`
 * preserves today's two text shapes:
 *   - "prefixed" (default): `tasks: CODE: message`
 *   - "raw": `message` verbatim (flock checks, whose message is already prefixed)
 */
export type CommandResult =
  | { ok: true; json?: unknown; text?: (ctx: OutputContext) => string }
  | {
      ok: false;
      code: string;
      message: string;
      details?: Record<string, unknown>;
      plainFormat?: "prefixed" | "raw";
    };

/**
 * Resolve the output context from raw args. Detects `--json` and folds the
 * `--no-color` flag into the central colour decision.
 */
export function outputContext(rest: string[]): OutputContext {
  return {
    json: rest.includes("--json"),
    color: shouldColor(rest.includes("--no-color")),
  };
}

/**
 * The one place that turns a CommandResult into output: the JSON envelope or
 * rendered text, the right stream, and the exit code. Always exits the process.
 */
export function emit(result: CommandResult, ctx: OutputContext): never {
  if (result.ok) {
    if (ctx.json) {
      if (result.json !== undefined) {
        process.stdout.write(JSON.stringify(result.json) + "\n");
      }
    } else if (result.text) {
      process.stdout.write(result.text(ctx));
    }
    process.exit(0);
  }

  if (ctx.json) {
    process.stderr.write(
      JSON.stringify({
        error: { code: result.code, message: result.message, details: result.details ?? {} },
      }) + "\n"
    );
  } else if (result.plainFormat === "raw") {
    process.stderr.write(`${result.message}\n`);
  } else {
    process.stderr.write(`tasks: ${result.code}: ${result.message}\n`);
  }
  process.exit(1);
}
