---
name: devspace-chrome-use
description: Use DevSpace chrome_use correctly with the user's real Chrome session, including profile-sensitive work and DevSpace browser-session recovery.
---

# DevSpace Chrome Use

Use this skill whenever a task uses DevSpace `chrome_use`. It is the runtime
guide for DevSpace-specific Chrome behavior. Generic upstream Chrome/browser
behavior remains governed by the host's official OpenAI Chrome/browser guidance
when that guidance is available.

## Normal path

`chrome_use` controls the user's real Chrome profiles through OpenAI's signed
browser runtime. Keep the normal path short:

1. Use the workspace ID returned by `open_workspace`.
2. Omit `profile` to use the machine default profile. `status` returns the
   selected profile name, Google account email, profile path, and connection
   state.
3. If the user explicitly asks to use another profile, pass its profile name,
   Google account email, or Chrome profile path in `profile`. A successful
   explicit selection becomes sticky for the current ChatGPT conversation;
   other conversations are unaffected. Use `list_profiles` only when the user
   asks what profiles exist or the requested identity is ambiguous.
4. For a new isolated page, use `new_tab`; for an existing user page, use
   `list_user_tabs` and then `claim_tab` explicitly.
5. Prefer DOM snapshots and Playwright selectors over desktop coordinates.
6. Close temporary isolated tabs when the task is done.

Do not replace an explicitly requested Chrome Use task with Computer Use,
standalone Playwright, or a temporary browser profile merely because Chrome Use
needs recovery. Recover Chrome Use and continue the original task unless the
user changes the requested surface.

## Profile-sensitive work

DevSpace resolves Chrome profiles by stable human-facing identity first, then
maps that profile to its current extension instance. Do not select a profile by
whatever extension instance happens to be first or currently foreground.

When profile identity matters:

1. Prefer the profile name or Google account email supplied by the user. Profile
   path (`Default`, `Profile 3`, and so on) is also accepted when explicitly
   known.
2. Use `status` to verify which profile DevSpace selected. Use
   `list_user_tabs` / `claim_tab` only when the business page or login state
   itself also needs verification.
3. If the requested profile has the ChatGPT Chrome extension installed but is
   not currently connected, DevSpace automatically launches that profile with
   the official Chrome helper and waits for its extension instance. Do not use
   AppleScript, foreground Profile menus, or focus-sensitive UI switching for
   normal profile selection.
4. Never silently fall back to another profile when an explicitly requested
   profile cannot be resolved or connected.

Multiple LLM conversations may use the same Chrome profile concurrently, and
one conversation may use different profiles over time. DevSpace does not add a
profile-level lock. OpenAI's browser runtime owns per-session tab leases; the
same concrete tab cannot be claimed concurrently by incompatible browser
sessions.

## When something fails

Do not expand immediately into DNS, proxy, Tunnel, OAuth, Native Host, or site
business logic. First distinguish a page problem from a DevSpace Chrome session
problem.

Read `references/recovery.md` when any of these occurs:

- `Browser is not available`;
- `codex_chrome_tool_failed`;
- a previously working Chrome binding stops responding;
- the requested profile exists but its extension instance is not live;
- `status` succeeds but real tab operations repeatedly fail.

## Knowledge boundaries

Keep machine-specific profile identities, enterprise login states, and local
recovery facts in the environment's own knowledge system when one exists. Do
not bake those facts into this bundled skill.

Keep generic OpenAI browser-extension setup, permissions, and native-host rules
in the official upstream Chrome/browser guidance. This skill adds only the
DevSpace wrapper behavior needed to use and recover `chrome_use`.

The DevSpace machine default profile belongs in machine configuration, not in
this skill. The maintained setting is `chromeDefaultProfile` in
`~/.devspace/config.json` (or `DEVSPACE_CHROME_DEFAULT_PROFILE`).
