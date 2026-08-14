# DevSpace Chrome Use recovery

Read this only after the normal path in `SKILL.md` has failed.

## Fast diagnosis

Use the smallest set of probes that separates the failure domains:

1. Confirm the DevSpace MCP request reaches the server and ordinary workspace
   tools still work.
2. Probe `chrome_use status`; confirm its returned profile name/email/path is
   the intended profile, then probe one real tab operation (`new_tab` or the
   relevant claimed tab).
3. If profile resolution is the suspected problem, use `list_profiles` and
   verify the requested profile is installed and live before diagnosing the
   target site or network.
4. Use native `computer_use` only as an independent health probe when needed;
   do not use it as a substitute for the requested Chrome task.

If DevSpace and ordinary tools are healthy while Chrome Use alone fails, keep
the investigation in the Chrome browser-session layer until direct evidence
points elsewhere.

## Verified DevSpace recovery

DevSpace uses a small pool of Chrome workers. A normal node-repl/worker failure
is recovered by replacing only that worker; it must not invalidate unrelated
Chrome work. DevSpace rebuilds the shared Codex app-server host only for errors
that show the app-server itself is unavailable.

Profile identity is resolved independently from the browser worker. If a cached
extension instance disappears, DevSpace rereads the selected profile's current
instance identity and, when necessary, launches that exact profile with the
official Chrome helper. A failure must not cause silent fallback to another
profile.

After recovery, do not stop at process health or `status`. Verify a real Chrome
Use loop:

```text
status -> connected
new_tab https://example.com -> DOM contains Example Domain
close -> temporary tab closed
```

If the task requires a particular profile, `status` must report that exact
profile before resuming the task:

```text
status -> expected profileName/profileEmail/profilePath
claim_tab / snapshot -> expected business page state, when relevant
```

Then continue the original business task. Recovery itself is not the task's
completion condition.

## Escalation order

Only if worker/profile recovery does not restore a real Chrome Use loop should
the investigation move deeper:

1. Follow the host's official OpenAI Chrome/browser troubleshooting for Chrome
   process, extension, selected profile, and native-host communication.
2. Inspect DevSpace worker/runtime logs when the upstream extension is healthy
   but the wrapper still cannot resolve or bind the exact profile instance.
3. Investigate network/proxy/Tunnel/site behavior only when there is direct
   evidence the browser/profile session is correct and the failure is actually
   on that path.

Do not reinstall extensions, rewrite browser profile state, or perform broad
network changes as the first recovery action.

## Tool-schema refresh

ChatGPT may keep an MCP tool schema for the lifetime of an existing
conversation. After DevSpace adds or changes `chrome_use` fields, a backend
restart alone does not prove that an already-open conversation can see the new
schema. Verify the connector/tool schema in a fresh conversation when accepting
new actions or parameters such as `list_profiles` or `profile`.

## User-intervention boundary

Known DevSpace session/profile recovery is an agent responsibility. Ask the user
only for an external step that cannot be performed through the available tools,
such as person-bound sign-in, QR/second-factor authentication, or a platform
approval that explicitly requires the user's action.
