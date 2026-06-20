# Command Mapping

## `/plan`

Inputs:

- `@dev /plan ...`
- `/plan ...`

Expected behavior:

1. Call `handle_workspace_command`.
2. Ensure the workspace moves to `plan` mode.
3. Continue with planning tools and repository exploration.
4. Keep replies short unless the user explicitly asks for detail.

## `/goal`

Inputs:

- `@dev /goal ...`
- `/goal ...`

Expected behavior:

1. Call `handle_workspace_command`.
2. Create or continue the workspace goal.
3. Use `get_goal` and `update_goal` for lifecycle management.

## Compact Answers

Inputs:

- `1B，2A`
- `1B, 2A`
- `1b 2a`

Expected behavior:

1. Check that a pending `request_user_input` exists.
2. Pass the raw text to `handle_workspace_command` or `answer_user_input(text)`.
3. Do not rewrite the user's answer into prose before submitting it.

## Failure Handling

- If there is no open workspace, open one first.
- If there is no pending user input, do not pretend the answer was accepted.
- If the compact answer is incomplete or invalid, return the specific validation error.

## Batch File Changes

Inputs:

- "Modify these files ..."
- "Apply this patch ..."
- "Do the same change across the project ..."

Expected behavior:

1. Inspect the files first.
2. Use `apply_workspace_patch` for coordinated multi-file changes.
3. Avoid `bash` redirection, heredocs, `sed -i`, `perl -i`, or generated scripts for project writes.
4. Call `show_changes` after the related change set when available.

## Git Push

Inputs:

- "Push this branch"
- "git push"
- "Push origin main"

Expected behavior:

1. Use `git status` or the git inspection tools to verify what will be pushed.
2. Use `git_push` with structured arguments.
3. Do not use generic `bash` for raw `git push` unless `git_push` is unavailable.
