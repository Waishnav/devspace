# MCP testing research for DevSpace

Research date: 2026-08-24

DevSpace currently installs `@modelcontextprotocol/sdk` 1.29.0 and exposes a stateful Streamable HTTP endpoint. This note therefore uses the 2025-11-25 MCP specification and the matching TypeScript SDK tag as the main reference point. The newer 2026-07-28 revision is discussed only as an upgrade risk.

## Conclusion

The largest gap in the DevSpace suite is not a missing unit test. It is a missing boundary.

[`src/server.test.ts`](../src/server.test.ts) connects `createMcpServer()` to an SDK `InMemoryTransport`. That is a good seam for MCP tool behavior. It proves that an SDK client can discover and call registered DevSpace tools without coupling tests to private registration helpers.

It does not execute [`createServer()`](../src/server.ts), Express, Streamable HTTP, OAuth middleware, HTTP headers, session routing, SSE, or the shutdown path used by a real MCP host. No current test calls `createServer()`. The suite consequently has substantial coverage of code below the MCP endpoint and almost no evidence about the endpoint itself.

My recommendation is to retain focused domain tests and the in-memory MCP client tests, then add a small number of production-shaped tests in this order:

1. An authenticated Streamable HTTP lifecycle test on an ephemeral port.
2. Adversarial HTTP tests for sessions, versions, media types, Origin and Host validation, and OAuth failures.
3. An official MCP conformance run against the real DevSpace transport with a test-only authenticated proxy.
4. A packed-install smoke test that installs the generated tarball in a temporary directory and invokes its public binaries.
5. A CI split that runs platform-neutral evidence once and only platform-sensitive tests on macOS and Windows.

Do not add an MCP stdio suite to DevSpace. The product does not expose an MCP stdio transport. The stdio examples below are useful because they demonstrate how to test a packaged child-process boundary, which applies to DevSpace's CLI package, not because DevSpace should gain another transport.

## The MCP contracts worth testing

The protocol defines a small number of boundaries that matter much more than helper coverage.

| Concern | Protocol invariant | What DevSpace should observe |
| --- | --- | --- |
| Lifecycle | Initialization must happen first, negotiates a protocol version and capabilities, and is followed by `notifications/initialized`. Peers may only use negotiated capabilities. | A real SDK client can initialize the HTTP endpoint; advertised capabilities and instructions are correct; invalid order and unsupported versions fail at the endpoint. [MCP lifecycle specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle) |
| Streamable HTTP | POST and GET share one endpoint. POST clients advertise JSON and SSE support. Stateful servers issue a secure session ID, require it on later calls, return 404 for expired sessions, accept DELETE termination, and validate `MCP-Protocol-Version`. Servers must reject an invalid Origin with 403. | Status codes, headers, session creation and reuse, unknown sessions, DELETE cleanup, media-type failures, protocol-version failures, and Origin rejection through `/mcp`. [MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) |
| Authorization | HTTP authorization applies to every request in a logical session. Invalid or expired tokens return 401, insufficient scope returns 403, the server validates the token audience, and protected-resource discovery is part of the HTTP contract. | OAuth metadata, `WWW-Authenticate`, token issuance, authorization on initialization and subsequent requests, scope failure, audience mismatch, expiration, refresh rotation, and revocation through HTTP. [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) |
| Tool contracts | `tools/list` advertises input and optional output JSON Schemas. If an output schema exists, the server must return conforming `structuredContent`. Malformed protocol input and tool execution failures use different error mechanisms. | The schema seen by an SDK client matches the intended model contract; representative calls validate at the SDK boundary; invalid arguments produce the intended model-recoverable result. [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) |
| Cancellation and timeouts | Cancellation is a raced notification. A receiver should stop work and free associated resources, but must tolerate an unknown or already-completed request. Sent requests should have bounded timeouts even when progress resets an idle timer. | Cancel a live effect through an MCP client and inspect the user-visible result plus resource ownership. Test completion-before-cancel and cancel-before-completion deterministically. [MCP cancellation specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation), [MCP lifecycle timeout rules](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle#timeouts) |

These are interface tests. They remain useful if session storage, Express routing, tool registration, or process management is refactored.

## What the official TypeScript SDK tests

The TypeScript SDK 1.29.0 uses several distinct seams instead of asking one kind of test to prove everything.

### HTTP transport tests use HTTP

The SDK's Streamable HTTP server tests create a Node HTTP server on a random port and use `fetch` to initialize, call tools, open SSE streams, send DELETE, and exercise invalid headers and session IDs. The scenarios include missing and invalid session IDs, Accept and Content-Type errors, protocol-version validation on POST, GET, and DELETE, resumability, stateless mode, callbacks, and DNS rebinding protection. [TypeScript SDK 1.29.0 Streamable HTTP server tests](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/test/server/streamableHttp.test.ts)

The SDK also has a higher-level integration test that connects its real `Client` and `StreamableHTTPClientTransport` to a real Node HTTP server, then compares stateful and stateless behavior and multiple clients. This is close to the missing DevSpace seam. [TypeScript SDK 1.29.0 session-management integration test](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/test/integration-tests/stateManagementStreamableHttp.test.ts)

DevSpace should not copy all of the SDK's transport cases. The SDK owns generic transport correctness. DevSpace needs the cases where its composition can violate the contract: authentication before session routing, session registry ownership, headers added or rejected by Express, the selected protocol versions, and cleanup of DevSpace resources.

### Temporal behavior uses deterministic control

The SDK protocol tests use fake timers for request timeouts, progress-based resets, and maximum total timeouts. Its cancellation tests drive messages through the protocol abstraction and distinguish request cancellation from task cancellation. [TypeScript SDK 1.29.0 protocol tests](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/test/shared/protocol.test.ts)

That is the right pattern for DevSpace process and subagent lifecycle tests. Inject time, deferred completion, and explicit queues. Do not add sleeps to make races probable.

### Conformance is a separate gate

The SDK runs the official conformance CLI in a separate CI workflow against a running server and client, with an expected-failures baseline. [TypeScript SDK 1.29.0 conformance workflow](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/.github/workflows/conformance.yml), [TypeScript SDK 1.29.0 conformance runner](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/test/conformance/scripts/run-server-conformance.sh)

The official conformance framework connects to a running server, records protocol interactions, checks scenario behavior, and validates wire messages against the schema for the negotiated protocol version. Its baseline fails both on a new regression and when an expected failure starts passing but remains listed. [MCP conformance framework](https://github.com/modelcontextprotocol/conformance)

Conformance is useful but not sufficient here. The current framework explicitly notes that its server suite does not exercise an SDK server as an OAuth protected resource. DevSpace still needs its own HTTP authorization tests. [Conformance authorization coverage note](https://github.com/modelcontextprotocol/conformance/blob/main/src/seps/sep-2207.yaml)

Since DevSpace requires OAuth on `/mcp`, the clean conformance setup is a test-only loopback proxy that obtains or receives a valid test token, attaches it to each conformance request, and forwards to an otherwise unchanged DevSpace app. The proxy must stay in test code. A production `disableAuth` option would weaken the exact composition being tested.

### Packaged boundaries are tested as packages

The first-party filesystem server builds its distribution, starts `dist/index.js` with the SDK's `StdioClientTransport`, and calls tools through an actual MCP subprocess. The same test checks the advertised `outputSchema` through `tools/list` and validates results through `callTool`. [Filesystem server structured-content integration test](https://github.com/modelcontextprotocol/servers/blob/main/src/filesystem/__tests__/structured-content.test.ts)

The MCP Inspector goes further for its CLI product. Its documented smoke path runs the built launcher against a bundled test server, and its package verification inspects the publish artifact. [MCP Inspector launcher and packaging checks](https://github.com/modelcontextprotocol/inspector/blob/main/clients/launcher/README.md)

DevSpace is distributed as an npm CLI with native and static assets. A source-checkout build is not enough evidence. A temporary install of `npm pack` output should prove that `devspace`, `devspace-agentd`, migrations, UI assets, skills, docs, and the postinstall/native dependency path are present and resolvable.

### Official does not mean automatically good

The canonical `server-everything` suite also contains implementation-coupled tests that mock `McpServer` and assert exact registration counts and direct registrar calls. [Everything server registration tests](https://github.com/modelcontextprotocol/servers/blob/main/src/everything/__tests__/registrations.test.ts)

Those are poor examples for DevSpace. A new composition strategy could register the same public tools and break the tests without changing client-visible behavior. Use the official repositories to find protocol scenarios and executable boundaries, not as a blanket quality standard.

## DevSpace comparison

| Seam | Current evidence | Assessment | Required change |
| --- | --- | --- | --- |
| Domain modules | Filesystem, roots, workspaces, process sessions, persistence, runtime pools, and provider adapters have direct tests. | Mixed. Security and temporal invariants are valuable. Exact mappings and incidental call patterns need pruning. | Keep tests that name an invariant and observe the module's public result. Delete or merge implementation-shaped cases after replacement evidence exists. |
| MCP tool interface | [`src/server.test.ts`](../src/server.test.ts) uses the SDK client through `InMemoryTransport`. | Good component seam, but it mostly exercises `open_workspace`. | Keep it. Expand only for tool contracts that cross registration, schema, metadata, and handler output. Do not duplicate every handler's domain cases here. |
| Production HTTP endpoint | [`src/server.ts`](../src/server.ts) composes Express, OAuth, session registry, transport, tools, stores, and shutdown. No test invokes this composition. | Critical gap. | Add an ephemeral HTTP fixture around `createServer().app` and a real SDK `StreamableHTTPClientTransport`. |
| MCP sessions | [`src/mcp-sessions.test.ts`](../src/mcp-sessions.test.ts) tests idle close and shutdown of a generic registry. | Valuable invariant test, but it cannot prove header routing or HTTP status codes. | Keep it and add a smaller HTTP lifecycle set. Do not repeat registry internals at HTTP level. |
| OAuth | [`src/oauth-store.test.ts`](../src/oauth-store.test.ts) tests persistence, hashing, rotation, expiry, restart, and provider methods. | Strong storage evidence. It bypasses HTTP discovery and bearer middleware. | Keep it. Add HTTP tests for metadata, challenge, resource audience, scopes, per-request authorization, and revocation. |
| Cancellation | Process termination is tested inside [`src/process-sessions.test.ts`](../src/process-sessions.test.ts), but MCP request cancellation is not driven through the server. Tool handlers in `server.ts` do not currently consume the SDK request abort signal. | Missing ownership contract. | Decide the invariant first. For example, cancelling a still-blocked `bash` request either terminates the owned process or deliberately returns a retained process session. Then write one adversarial MCP test for each legal ordering. |
| Protocol versions and capabilities | The in-memory SDK handshake succeeds, but HTTP version headers and capability gating are not asserted. | Missing upgrade guard. | Pin the supported protocol version in a production-shaped test and assert advertised capabilities through the client. |
| Package | CI builds and runs `dist/cli.js doctor`, but does not install the package it would publish. | Missing consumer path. | Pack, install in a clean temporary project, invoke the public bin, and verify required packaged files. |
| CI | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs typecheck, the whole test chain, build, and doctor on Linux, macOS, and Windows under Node 22. | Broad repetition without evidence labels. It omits package install, HTTP conformance, and the upper supported Node version. | Split fast platform-neutral checks from focused OS and package jobs. |

## Proposed test architecture

Use Node's built-in test runner across the repository. DevSpace already uses `node:test` in several newer files, it supports named tests and cleanup hooks, and it avoids adding a framework only to obtain basic structure. A single runner is more important than which runner wins.

The suite should expose five scripts with distinct purposes:

```text
test:unit          pure domain rules and narrow module interfaces
test:component     real files, Git, SQLite, processes, provider protocol fixtures
test:mcp           SDK client against in-memory and real Streamable HTTP transports
test:package       npm tarball installed and invoked in a clean temporary project
test:conformance   pinned official MCP conformance CLI against the HTTP test endpoint
```

`npm test` should run the first three locally. Package and conformance tests can remain explicit CI jobs if their runtime is materially higher. Every test must have a behavioral name and register cleanup at fixture creation time.

This is not a test pyramid by file count. It is a set of agreed interfaces:

1. Domain modules own pure rules and temporal transitions.
2. Adapter tests own decoding and normalization of external provider messages.
3. MCP component tests own the model-facing schema and tool result.
4. HTTP tests own transport, session, authorization, and server lifecycle.
5. Package tests own the npm consumer experience.

An assertion belongs at the lowest interface that can prove the invariant without reaching into implementation details. The same fact should not be repeated at every level.

## Cleanup sequence

### 1. Write the invariant inventory

Before editing tests, list the permanent product invariants by owner:

- allowed-root containment and symlink handling
- workspace identity, checkout reuse, and worktree isolation
- process and subagent ownership, cancellation, shutdown, and bounded retention
- persisted state and restart compatibility
- provider protocol decoding and error preservation
- MCP tool schemas and model-visible results
- HTTP session, OAuth, and host-boundary behavior
- package contents and entry points

Attach each existing test to one invariant and one public interface. A test with no invariant is a deletion candidate. An invariant with no interface test is a gap.

### 2. Normalize the runner without changing assertions

Move the anonymous top-level assertion scripts into named `node:test` cases. Add reusable fixtures for temporary directories, repositories, databases, child processes, environment variables, and MCP clients. Register cleanup immediately with `t.after()`.

This mechanical stage should not rewrite behavior or add coverage. It makes later pruning reviewable and gives agents a test name instead of a file line when something fails.

### 3. Add missing boundary tests before deleting substitutes

Build one authenticated HTTP tracer test first:

1. Start `createServer().app` on port `0`.
2. Complete the real local OAuth flow or issue a token through a public test fixture.
3. Connect `StreamableHTTPClientTransport`.
4. Assert negotiated version and advertised capabilities.
5. Call `open_workspace`, then a read-only workspace tool.
6. Close the MCP client and DevSpace server.
7. Assert no session, process, database, or listener remains owned by the fixture.

Then add table-driven negative HTTP cases for the spec requirements DevSpace composes itself. Keep the table small: missing token, wrong audience, missing session, unknown session, unsupported protocol version, invalid Origin, and DELETE termination. The SDK already exhaustively tests generic media parsing and SSE mechanics.

Add one cancellation history through the MCP interface only after the ownership rule is agreed. Use deferred values or an explicitly controlled process. Do not use sleeps.

### 4. Add conformance and package evidence

Pin the conformance package version. Run the server suite at the exact protocol version DevSpace claims to support. Keep any expected-failures baseline short and require a reason beside every entry.

For the package job:

1. Build once.
2. Create an npm tarball.
3. Inspect its file list for the declared runtime assets.
4. Install it into a clean temporary project without workspace links.
5. Run `devspace --version` and `devspace doctor` through the installed bin.
6. Exercise one bounded command that loads migrations and UI assets from the installed package.

The package test should never import source files.

### 5. Prune by evidence, not percentage

Delete or merge a test when one of these is true:

- It observes a private helper or internal collaborator and a public-interface test proves the same invariant.
- Its expected value is reconstructed using the same algorithm as production.
- TypeScript already makes the asserted state impossible and there is no runtime decoding seam.
- It checks an exact call count, ordering, string, or complete object with no documented contract requiring that exact value.
- It preserves the absence of a deleted feature without a security, compatibility, or migration reason.
- No plausible production defect makes it fail.

Retain a test when it protects authority, atomicity, ownership, ordering, idempotency, bounded resources, restart behavior, version compatibility, or a model-visible contract.

Do not set a coverage target or deletion quota. Both are easy for coding agents to game. For disputed tests, make one plausible mutation to the implementation. If the test stays green, it does not prove the claimed behavior. If an unrelated refactor breaks it while behavior remains correct, it is coupled to implementation.

### 6. Reshape CI

The official SDK 1.29.0 separates build from tests, runs its normal suite on its minimum and current Node versions, and gives conformance a separate workflow. [TypeScript SDK 1.29.0 CI](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/.github/workflows/main.yml)

For DevSpace, use:

- Linux, Node 22: typecheck, unit, component, MCP, build.
- Linux, highest supported Node: package install and doctor.
- macOS and Windows, Node 22: only path, process, native module, Git/worktree, and packaged-bin cases that can vary by OS.
- Linux, pinned Node: MCP conformance.

This keeps cross-platform evidence where the product actually differs while making the important HTTP and package failures visible as separate jobs.

## Protocol-version horizon

The 2026-07-28 revision removes protocol-level sessions and `MCP-Session-Id`. DevSpace 1.29.0 is built around the 2025 stateful session model. [MCP 2026-07-28 changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)

Do not mix support for the newer revision into the cleanup. First pin and test the contract DevSpace ships today. A later SDK v2 migration should begin with an explicit compatibility decision and new tracer test because the HTTP lifecycle, request association, and cancellation model change. Keeping protocol-version evidence in its own MCP test layer will make that migration legible instead of turning hundreds of lower-level tests red at once.

## Practical standard for future tests

Before adding a test, write down:

1. The invariant.
2. The public interface where callers observe it.
3. The independent source of the expected result.
4. The plausible defect that would make the test fail.
5. The resource cleanup and time bound.

If those answers do not fit in a few lines, the test probably needs a clearer seam or the behavior is not ready to test. This is the admission rule that prevents the suite from growing back into assertion inventory.
