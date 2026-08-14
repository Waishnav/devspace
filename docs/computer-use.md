# Local Multimodal Files, Computer Use, and Chrome Use

This document is the authoritative goal, architecture, implementation plan, and
acceptance baseline for exposing a DevSpace host computer to the MCP model.

It supersedes the earlier design in which DevSpace compiled and ran its own
Swift mouse, keyboard, and screenshot helper. That implementation remains a
transition prototype only and must not become the production architecture.

## Goal

A model connected to DevSpace should be able to use the approved local computer
through three complementary surfaces:

1. **Native local file exchange**
   - Read local images as MCP `image` content.
   - Return other binary files as MCP embedded resources with MIME type, size,
     and SHA-256 metadata.
   - Preserve workspace authorization and path-containment rules.

2. **macOS application control**
   - Observe an application window as a screenshot and accessibility tree.
   - Click, drag, scroll, press keys, enter text, and set accessible values.
   - Re-observe after an action instead of treating input delivery as proof of
     success.
   - Reuse OpenAI's signed Codex Computer Use components.

3. **Google Chrome control**
   - Reuse the user's existing Chrome profile and authenticated sessions when
     the user explicitly selects Chrome or when policy chooses it.
   - Support tab creation, navigation, DOM snapshots, screenshots, Playwright
     locators, browser CUA, typing, clicking, uploads, and downloads.
   - Reuse OpenAI's browser runtime and Chrome extension rather than launching a
     separate Playwright browser with an unrelated profile.

The active GPT model remains responsible for visual interpretation, planning,
and deciding the next action. Codex components are execution surfaces, not a
second reasoning agent.

## Non-goals

- Do not delegate the task to a Codex model merely to gain access to Computer
  Use or Chrome.
- Do not copy or reimplement OpenAI's native Computer Use service, Chrome
  extension host, DOM engine, or Playwright bridge.
- Do not expose unrestricted filesystem, application, browser-history, cookie,
  password, or local-storage access.
- Do not bypass official application approvals, browser-origin approvals,
  upload/download confirmation, or user-interruption controls.
- Do not hardcode a currently installed ChatGPT, Codex, Computer Use, or browser
  plugin version.

## Routing policy

Use the narrowest reliable surface for each task:

| Task | Preferred surface |
| --- | --- |
| Read a local image or binary file | DevSpace native file exchange |
| Public web research | Web search or a purpose-built connector |
| Gmail, Calendar, Drive, or another supported service | Purpose-built connector |
| Chrome page using existing login state | Codex Chrome Use |
| Local web application testing | Chrome Use or the in-app browser selected by policy |
| Native macOS application | Codex Computer Use |
| Browser or application system dialog not represented in DOM | Computer Use |

Within Chrome, prefer DOM snapshots and Playwright locators over screenshot
coordinates. Use screenshots when visual state is material or DOM evidence is
insufficient.

## Target architecture

```text
MCP model
  |
  v
DevSpace
  |-- Workspace file adapter
  |     `-- local file -> MCP image or embedded resource
  |
  |-- Codex app-server client
  |     |-- process/spawn: signed Computer Use MCP client
  |     `-- process/spawn: signed node_repl browser runtime
  |
  |-- Computer Use adapter
  |     `-- SkyComputerUseClient MCP -> Codex Computer Use.app
  |
  `-- Chrome adapter
        `-- browser-client -> ChatGPT for Chrome extension -> Google Chrome
```

DevSpace is a thin authenticated adapter. It performs discovery, lifecycle
management, permission forwarding, result normalization, and MCP content
conversion. It does not perform model inference inside Codex.

## Model-token boundary

The validated local path uses standalone Codex app-server process APIs and does
not call `thread/start` or `turn/start`.

The implementation must preserve this invariant:

- Starting `codex app-server` is allowed.
- Calling standalone `process/spawn`, `process/writeStdin`, and `process/kill`
  is allowed.
- Running the signed Computer Use MCP client is allowed.
- Running the signed `node_repl` browser runtime is allowed.
- Creating a Codex thread or model turn is not allowed unless the user
  explicitly requests delegation to Codex.

Session-file counts and app-server notifications are useful regression signals,
but they are not billing records. Acceptance must verify that no thread or turn
API was called; it must not claim direct access to billing-level token counters.

## Runtime discovery

Never hardcode paths containing installed version numbers such as
`26.721.41059` or `1.0.1000502`.

Discovery should:

1. Locate the active ChatGPT/Codex application bundle and signed `codex`
   executable.
2. Locate the current `cua_node` runtime.
3. Locate the newest valid OpenAI-bundled Computer Use and browser plugins under
   the current Codex home.
4. Verify expected files, code signatures, Team ID, executable permissions, and
   minimum supported APIs.
5. Reject unsigned replacements and unsafe symlink traversal.
6. Cache discovery results only while the underlying bundle identity and file
   metadata remain unchanged.

Expected signed identities currently include:

- Computer Use service: `com.openai.sky.CUAService`
- Computer Use client: `com.openai.sky.CUAService.cli`
- Chrome extension host and Codex executables signed by OpenAI Team ID
  `2DC432GLL2`

These values are verification constraints, not permission to copy private
binaries into the DevSpace repository.

## Computer Use adapter

The production adapter should:

1. Start a signed `codex app-server` process.
2. Use app-server `process/spawn` to start the signed
   `SkyComputerUseClient mcp` executable. Directly spawning it from DevSpace is
   rejected by the service's parent-process authentication.
3. Complete MCP initialize/initialized negotiation.
4. Proxy official tools such as application discovery, application state,
   click, drag, scroll, keypress, text input, value assignment, and secondary
   accessibility actions.
5. Return screenshots as MCP `image` content and accessibility output as
   structured text.
6. Preserve official elicitation requests and require real user approval when
   the request is not already covered by persisted policy.
7. Reuse a healthy process for a sequence of actions and terminate it when the
   DevSpace session closes or becomes idle.

The adapter must not silently auto-accept application approvals. Test probes may
use an isolated explicit test policy, but production code may not.

## Chrome adapter

The production adapter should:

1. Start the signed Codex `node_repl` MCP runtime through app-server so the
   trusted parent and native-pipe requirements are satisfied.
2. Load the absolute `scripts/browser-client.mjs` path from the current bundled
   browser or Chrome plugin.
3. Propagate only the runtime environment keys required by the official client.
4. Select Chrome explicitly when the user requests Chrome; otherwise follow the
   browser-selection policy.
5. Read the complete browser documentation once per fresh runtime before first
   use.
6. Expose tab, screenshot, DOM, Playwright, browser-CUA, and capability APIs
   through a controlled DevSpace adapter.
7. Keep existing user tabs read-only until the user authorizes a task that
   requires claiming or modifying one.
8. Prefer creating an isolated test tab for acceptance tests and close it after
   the test.
9. Forward origin, upload, download, and sensitive-data elicitations instead of
   accepting them automatically.

## Request context and locked use

Chrome Use has been validated while the Mac is locked and does not require
unlocking the desktop for normal tab/DOM operations.

Native Computer Use locked-mode behavior is stricter. The official service
contains a lock-screen auto-unlock coordinator and a SecurityAgent authorization
plugin. It rejects or pauses requests that cannot be associated with a real
ChatGPT thread.

Therefore DevSpace must:

1. Inspect incoming MCP request metadata without logging its values.
2. Detect whether authentic thread/turn metadata is present.
3. Pass authentic metadata through unchanged to the official Computer Use
   client.
4. Never invent thread IDs for locked-mode requests.
5. Refuse locked-mode desktop actions with a clear explanation when authentic
   association is unavailable.
6. Continue to allow Chrome Use while locked when browser policy permits it.

A live ChatGPT-to-DevSpace request was inspected on 2026-07-30 using key-only
logging. The request contained an `openai/session` value of type string, but no
`x-codex-turn-metadata` object and no turn identifier. The value itself was not
logged. This is insufficient for the official lock-screen auto-unlock
coordinator, which requires a request associated with a real ChatGPT thread and
turn. DevSpace must not transform the session string or MCP request ID into
invented Codex metadata.

The current `nick-work` machine has the official
`CodexComputerUseAuthorizationPlugin.bundle` installed. Installation alone does
not prove locked-mode success. Locked Computer Use remains **not accepted** until
an actual DevSpace request carries verifiable ChatGPT thread context and passes
an observe/action/re-observe test while the machine is locked.

## Permission and confirmation handling

Production behavior must preserve the official safety model:

- Application approval is scoped and persisted only by official policy.
- Browser origins require official approval when not already allowed.
- Uploads, downloads, external side effects, and sensitive-data transmission
  follow the host's confirmation policy.
- Physical Escape or official interruption signals stop the active action loop.
- Typed text and screenshot bytes are not written to normal logs.
- Request metadata values, authentication material, cookies, and browser state
  are never logged.

DevSpace may log only non-sensitive diagnostics such as metadata key names,
component versions, result types, durations, and health-state transitions.

## Lifecycle and recovery

Use long-lived local processes where safe, with bounded idle cleanup:

- One app-server client per DevSpace service or authenticated MCP session.
- One Computer Use MCP child per active execution scope.
- One browser runtime per active browser session.
- Automatic restart after broken pipes, incompatible API versions, signed
  component updates, or extension reconnects.
- Explicit child cleanup on client disconnect, server shutdown, timeout, or user
  interruption.

Health checks must distinguish:

- component missing;
- signature invalid;
- service not running;
- extension disconnected;
- machine locked without authentic thread context;
- app not approved;
- origin not approved;
- stale tab or window;
- browser or CUA API version mismatch.

## Transition from the custom helper

The following files represent the earlier prototype and are not the target
implementation:

```text
scripts/macos-computer-use.swift
src/computer-use.ts
src/computer-use.test.ts
```

They may remain temporarily as a fallback during migration, but the final change
must:

1. make the Codex-backed adapters the default;
2. keep the fallback disabled unless explicitly selected for diagnostics;
3. remove the custom permission instructions from user-facing documentation;
4. remove the fallback after the Codex path passes the acceptance matrix on both
   maintained hosts.

## Implementation phases

### Phase 1: Preserve the validated file path — complete

- Secure workspace-relative binary export remains in place.
- Supported images return native MCP image content.
- File identity, timestamp, size, containment, and SHA-256 checks remain enforced.

### Phase 2: Codex app-server transport — complete

- JSONL request/response correlation and streamed child-process I/O are implemented.
- The hard method allowlist contains only `initialize`, `process/spawn`,
  `process/writeStdin`, and `process/kill`.
- Tests reject `thread/start` and `turn/start` before transmission.
- ChatGPT, Codex, Computer Use, browser-client, versions, hashes, and signatures
  are discovered dynamically.

### Phase 3: Computer Use adapter — complete for the available host context

- The official Computer Use MCP client is proxied.
- Accessibility output and screenshots return directly to the MCP model.
- Official application elicitations are forwarded when the outer MCP host
  supports them.
- When the host cannot render nested elicitation, DevSpace fails closed and
  returns `approvalRequired`, the official message, and its schema. A retry with
  `appApproval=accept` is allowed only after explicit user authorization.
- Unlocked official runtime observe/action/re-observe and repeated observations
  have passed.
- The formal adapter rejects locked requests without authentic turn metadata.

### Phase 4: Chrome adapter — complete

- The official browser runtime is initialized through signed `node_repl`.
- Chrome extension selection is explicit.
- Isolated-tab navigation, DOM, screenshot, input, click, state verification,
  and cleanup pass through the formal adapter.
- The same formal adapter passes while macOS is locked.

### Phase 5: Authentic request-context propagation — complete

- Incoming MCP `_meta` is read through the SDK handler context.
- Temporary key-only diagnostics confirmed the current host shape and were then
  removed from normal runtime logging.
- Authentic `x-codex-turn-metadata` is passed through without mutation.
- Incomplete or invented metadata is rejected for locked desktop use.

### Phase 6: Make Codex the production default — complete on both hosts

- `DEVSPACE_COMPUTER_USE_BACKEND=codex` is the default.
- The custom Swift helper is not registered unless `backend=swift` is selected
  explicitly.
- User-facing permission guidance describes the signed Codex path.
- The rollback backend remains explicit and disabled by default.

### Phase 7: Deploy to both maintained hosts — complete

- The same source implementation and maintenance documents are present on
  `local_agent_nick_work` and `local_agent`.
- Both hosts passed dynamic runtime discovery, OpenAI signature verification,
  unit tests, the tool-list protocol test, typecheck, build, service restart,
  Codex backend command inspection, and health checks.
- Both account-level Apps initially exposed a stale six-action schema. The user
  performed account-level **Refresh only**; no uninstall, reinstall, Reconnect,
  OAuth repetition, or network change was needed. Both Apps then exposed eight
  actions, including `computer_use` and `chrome_use`.
- `local_agent_nick_work` passed the complete Chat-mode image, isolated Chrome,
  application-approval, native observe/action/re-observe, cleanup, and
  token-boundary matrix.
- The user designated `local_agent_nick_work` as the canonical functional
  acceptance host. The primary `local_agent` is accepted by source/document
  SHA-256 parity, identical tool schema, tests/build, runtime configuration, and
  health checks; it does not repeat the same native desktop action unless a
  machine-specific difference exists.
- The final claim-to-evidence record and fallback decision are maintained in
  [DevSpace final acceptance handoff](devspace-final-acceptance-handoff.md).

### Two-host maintenance acceptance policy

For ordinary code and documentation changes, validate the full image, Chrome,
and native application path on `local_agent_nick_work`, then validate the
primary host by synchronized hashes, eight-action schema, tests/build, runtime
configuration, and local/public health. Require independent native desktop
acceptance on both hosts only when the change can be machine-specific, including
macOS, ChatGPT/Codex runtime, signature, permission, display, accessibility, or
Chrome-extension differences.

## Acceptance matrix

A release is complete only when all applicable checks pass:

| Area | Acceptance requirement |
| --- | --- |
| Local image | Image is visible to the MCP model as native image content |
| Other binary | Original bytes and metadata are returned without text/base64 reconstruction |
| Computer Use observation | Screenshot and accessibility tree are both returned |
| Computer Use action | Safe action succeeds and a fresh state is returned |
| Computer Use stability | Repeated independent runs complete without leaked children |
| Chrome observation | Navigation, DOM snapshot, and screenshot succeed |
| Chrome action | Input and click produce a verified page-state change |
| Chrome cleanup | Isolated test tab is closed |
| Locked Chrome | DOM, screenshot, input, and click succeed while macOS is locked |
| Locked Computer Use | With authentic Codex turn metadata: observe/action/re-observe; without it: fail closed before starting native control |
| Token boundary | No `thread/start` or `turn/start` calls occur |
| Permissions | Unapproved app/origin/upload/download requests are surfaced to the user |
| Updates | Component version changes trigger rediscovery rather than path failure |
| Shutdown | All spawned app-server, MCP, and browser runtime children are terminated |

## Validated baseline on `local_agent_nick_work`

As of 2026-07-30:

- Native local PNG read: passed.
- Other binary export and metadata validation: passed.
- Official Computer Use unlocked observe/action/re-observe: passed.
- Official Computer Use independent unlocked observations: 10/10 passed.
- Formal Codex app-server transport and nested MCP protocol tests: passed.
- Formal tool-list protocol test: passed; `computer_use` and `chrome_use` are
  registered, while legacy `capture_screen` and `computer_action` are absent.
- Formal Chrome adapter isolated-tab DOM/screenshot/input/click/cleanup: passed.
- Formal Chrome adapter while macOS is locked: passed.
- Formal native Computer Use locked request without authentic turn metadata:
  passed by failing closed before native control starts.
- Codex app-server methods observed during formal live acceptance were exactly
  `initialize`, `process/spawn`, `process/writeStdin`, and `process/kill`.
- Codex session files were byte-for-byte unchanged during formal live acceptance.
- Dynamic runtime discovery and OpenAI signature verification: passed.
- Official locked-use SecurityAgent plugin installation: passed.
- Full unit tests, typecheck, and production build: passed.

The current ChatGPT MCP request exposes an `openai/session` string but no
`turn_id`. Therefore locked native auto-unlock cannot be securely associated
with this conversation. This is an upstream host-context limitation, not a
missing local permission, and DevSpace deliberately does not bypass it.

## Rollback and legacy Swift removal

Final acceptance uses the signed Codex backend. Disabling local control must not
disable normal workspace operations or native file exchange, and rollback must
never silently select the custom Swift helper.

The legacy Swift implementation remains temporarily available only through the
explicit local setting `DEVSPACE_COMPUTER_USE_BACKEND=swift`; it is disabled by
default and absent from the normal eight-action ChatGPT tool surface. Its removal
is deferred as one atomic maintenance change because it requires deleting three
files and simultaneously removing configuration, server registration, service
script branches, tests, and documentation. The current Chat-mode DevSpace tool
surface has no file-delete action and bash is prohibited from modifying project
files, so partial removal is not acceptable.

The exit condition is a deletion-capable maintenance change that removes
`scripts/macos-computer-use.swift`, `src/computer-use.ts`, and
`src/computer-use.test.ts`, cleans every `swift` branch and reference, and then
passes the complete tests/build/tool-schema regression. Until then, the helper
must remain explicit, local-only, documented, and visible in startup logs.
