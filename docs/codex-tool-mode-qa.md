# Codex Tool Mode Manual QA

Run these checks against a disposable Git repository inside an allowed DevSpace
root. Keep the DevSpace server logs visible during the test.

## Setup

1. Build the current branch with `npm ci && npm run build`.
2. Start DevSpace with `DEVSPACE_TOOL_MODE=codex devspace serve`.
3. Connect or refresh the DevSpace connector in ChatGPT.
4. Open the disposable repository with `open_workspace`.
5. Confirm the core tools are `open_workspace`, `read`, `apply_patch`,
   `exec_command`, and `write_stdin`.
6. Confirm `write`, `edit`, `bash`, `grep`, `glob`, and `ls` are absent.
7. If `DEVSPACE_WIDGETS=changes`, also expect `show_changes`.

## Apply Patch

1. Add a text file containing multiple lines and a blank line.
2. Update two separate regions of that file in one patch.
3. Create a nested file, rename it, and then delete it.
4. Patch an existing CRLF file and verify it remains CRLF.
5. Verify executable permissions survive an update and a move.
6. Try to add `../outside.txt`; confirm the tool rejects the path.
7. Patch through a symlink targeting an external directory; confirm rejection.
8. Submit a hunk whose context is absent; confirm no file from that patch changes.
9. With changes widgets enabled, inspect the aggregate diff.

## Foreground Commands

1. Run `pwd` and confirm it reports the opened workspace.
2. Run a command in a relative `workingDirectory` and confirm the directory.
3. Write to stdout and stderr; confirm both appear.
4. Exit nonzero; confirm `running=false` and the exit code.
5. Use a small output budget on a noisy command; confirm truncation is reported.

## Background Sessions

1. Start a delayed command with a short yield time.
2. Confirm `exec_command` returns `running=true` and a `sessionId`.
3. Poll with empty `chars`; confirm output is not duplicated.
4. Poll until completion; confirm the final exit code and no `sessionId`.
5. Poll the completed session again; confirm it is unknown.
6. Reconnect MCP without restarting DevSpace and confirm polling still works.
7. Restart DevSpace and confirm old process session IDs are invalid.

## Input, Interrupt, And PTY

1. Start a program that reads stdin without a PTY and send it a line.
2. Start a long-running process and send `\u0003`; confirm it stops.
3. Start an interactive program with `tty=true`; confirm it detects a TTY.
4. Resize a PTY from 80x24 to 120x30 and verify the observed dimensions.
5. Omit optional dependencies; normal commands must work and `tty=true` must
   return the explicit `node-pty` error.

## Cleanup

1. Start a non-PTY command that creates a long-running child process.
2. Stop DevSpace with SIGINT and verify both shell and child exit.
3. Repeat with a PTY command.
4. Confirm no process remains after server exit.
5. Repeat session cycles and check that memory use does not steadily increase.

## Existing Mode Regression

1. Start without `DEVSPACE_TOOL_MODE`; confirm `minimal` remains the default.
2. Minimal must expose `read`, `write`, `edit`, and `bash`, but not Codex tools
   or dedicated search tools.
3. `DEVSPACE_TOOL_MODE=full` must add `grep`, `glob`, and `ls`.
4. With no explicit mode, `DEVSPACE_MINIMAL_TOOLS=1` maps to minimal and `0`
   maps to full.
5. Set `DEVSPACE_TOOL_MODE=codex` with `DEVSPACE_MINIMAL_TOOLS=0`; confirm the
   explicit Codex mode wins.
