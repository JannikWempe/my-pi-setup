import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect } from "effect";
import {
  loadChangedFiles,
  sanitizeTerminalText,
} from "./src/changed-files-view.ts";
import { CommandRunner } from "./src/process.ts";

test("repository text cannot inject terminal control sequences", () => {
  for (const sequence of [
    "\x1b]52;c;Y2xpcGJvYXJk\x07",
    "\x1b]8;;https://example.com\x1b\\",
    "\x9d52;c;clipboard\x9c",
    "\x1b[31m",
    "\x9b2J",
    "\x1b(B",
    "\x01",
    "\r",
    "\x7f",
  ]) {
    assert.equal(sanitizeTerminalText(`before${sequence}after`), "beforeafter");
  }
  assert.equal(
    sanitizeTerminalText("日本語\ttext\nnext"),
    "日本語\ttext\nnext",
  );
});

test("changed files sanitize labels and diffs without changing git path arguments", async () => {
  const path = "dir/\x1b[31mfile\x1b[0m\tname.txt";
  const paths: string[] = [];
  const files = await Effect.runPromise(
    loadChangedFiles("/repo").pipe(
      Effect.provideService(
        CommandRunner,
        CommandRunner.of({
          run: (_command, args) => {
            let stdout = "";
            if (args.includes("--show-toplevel")) stdout = "/repo\n";
            else if (args[0] === "status") stdout = ` M ${path}\0`;
            else if (args[0] === "diff") {
              paths.push(args.at(-1)!);
              stdout = args.includes("--numstat")
                ? "1\t0\tfile\n"
                : "+hello\x1b]52;c;bad\x07\x1b[31mworld\x1b[0m\n";
            }
            return Effect.succeed({ code: 0, stdout, stderr: "" });
          },
        }),
      ),
    ),
  );
  assert.deepEqual(paths, [path, path]);
  assert.deepEqual(files, [
    {
      additions: 1,
      deletions: 0,
      name: "file name.txt",
      path: "dir/file name.txt",
      diff: ["+helloworld"],
    },
  ]);
});
