# ChatGPT Native Artifact Handoff Dogfood Findings

- **Status:** Implementation findings and recommended next steps
- **Date:** 2026-07-19
- **Products:** DevSpace Artifact Exchange, ChatGPT DevSpace connector, Haft artifact handoff workflow
- **Related specification:** `docs/2026-07-18-haft-cli-artifact-handoff-and-devspace-bridge-spec.md` in the Haft repository

## Executive summary

A live dogfood exercise attempted to generate an image with ChatGPT's native image-generation tool, stage it through DevSpace, and copy it onto the DevSpace host for later use by Haft.

The exercise validated the core Artifact Exchange design:

- the generated image was available inside ChatGPT's artifact environment;
- DevSpace's chunked fallback accepted the transferred bytes;
- DevSpace promoted the completed upload into the private Artifact Exchange;
- the committed artifact was present in the live SQLite database with the expected filename and size.

Two P0 integration and reliability gaps prevented the workflow from feeling successful:

1. **The ChatGPT connector did not rewrite the generated image into a native file value that `stage_artifact` could consume.** Calls failed before a trusted DevSpace adapter could normalize the file.
2. **A successful chunked commit was not reliably surfaced to the model, and retrying commit could only return `Artifact upload was not found`.** The implementation deletes the upload row after promotion, so a lost commit response creates an ambiguous false-negative state.

The recommended path is not to redesign the Artifact Exchange. The next work should focus on native file-argument integration, a reviewed ChatGPT incoming-artifact adapter, and idempotent commit receipts.

## Test objective

The intended workflow was:

```text
ChatGPT native image generation
  -> generated file in ChatGPT artifact storage
  -> DevSpace stage_artifact(file=<native file reference>)
  -> private Artifact Exchange
  -> artifact_copy_to_workspace(...)
  -> host-local file inside an approved workspace
```

The test image was a woodpecker with a thought bubble reading:

```text
I have a headache.
```

ChatGPT generated the original PNG at:

```text
/mnt/data/woodpecker_with_a_headache.png
```

The original PNG was approximately 2.09 MB. A 512-by-512 WebP transfer copy was later used to exercise the chunked fallback without requiring dozens of model-mediated tool calls.

## Observed behavior

### 1. Native `stage_artifact` calls failed at the connector boundary

Two native staging shapes were attempted:

- the generated-file reference supplied by the image tool;
- the visible `/mnt/data/woodpecker_with_a_headache.png` path.

Both failed with the connector/runtime error:

```text
File arg rewrite paths are required when proxied mounts are present
```

This error occurred before DevSpace could successfully normalize and stream the file through an `IncomingArtifactAdapter`.

The current DevSpace tool schema describes the field as:

```ts
file: z.unknown()
```

That is an appropriate generic server boundary, but the live connector did not treat it as a file-bearing argument. The most likely explanation is that the connector requires additional schema or tool metadata to identify arguments whose native file or proxied mount references must be rewritten before dispatch.

This remains a connector compatibility finding rather than evidence that the `IncomingArtifactAdapter` abstraction is incorrect.

### 2. No production ChatGPT adapter is enabled yet

DevSpace intentionally ships no host-specific incoming adapter by default. Its documentation correctly states that a real connector value must first be observed, sanitized, fixture-backed, and reviewed.

The repository already provides the necessary boundaries:

```ts
interface IncomingArtifactAdapter {
  readonly id: string;
  canHandle(value: unknown): boolean;
  open(value: unknown): Promise<{
    name: string;
    mimeType?: string;
    size?: number;
    stream: NodeJS.ReadableStream;
  }>;
}
```

It also includes an `IncomingArtifactProbeAdapter` for a controlled compatibility spike. The missing work is therefore a concrete, reviewed ChatGPT adapter rather than a new storage architecture.

### 3. The chunked fallback worked at the byte-storage layer

The fallback sequence was exercised through:

```text
artifact_upload_begin
artifact_upload_chunk
artifact_upload_commit
```

Large model-visible base64 arguments proved fragile. A payload near the server's advertised 48 KiB decoded maximum was truncated before it reached DevSpace and failed strict canonical-base64 validation. Smaller 8 KiB decoded chunks transferred reliably.

The completed WebP contained 41,836 bytes. Live database inspection later showed a committed artifact:

```text
artifactId: art_cded0021-83b9-4bee-8952-1548bdda9add
name:       woodpecker_with_a_headache.webp
size:       41836
source:     chunked
```

This confirms that:

- sequential chunk validation worked;
- strict base64 rejection worked;
- partial-file writes worked;
- promotion into immutable artifact storage worked;
- artifact metadata persistence worked.

The fallback is therefore technically viable, although it is not an acceptable happy path for ordinary image generation.

### 4. Commit produced an ambiguous false negative

From the model's perspective, the final state appeared to be:

```text
Artifact upload was not found
```

However, live database inspection showed that the artifact had already been successfully committed.

The current commit implementation deletes the `artifact_uploads` row after inserting the artifact record:

```ts
afterInsert: () => {
  database.prepare(
    "delete from artifact_uploads where id = ? and client_id = ?",
  ).run(row.id, clientId);
}
```

That makes a successful commit non-idempotent from the caller's perspective:

1. the server commits and deletes the upload row;
2. the response is lost, hidden, truncated, or otherwise not delivered to the model;
3. the caller retries using the same upload ID;
4. the server reports that the upload does not exist;
5. the caller reasonably concludes that the upload failed, even though the artifact is present.

This behavior is the strongest reliability issue discovered in the dogfood test.

### 5. Workspace copying remains the correct explicit boundary

The requested destination was the root of the Haft repository. DevSpace correctly keeps staging separate from workspace mutation:

```text
stage_artifact or chunked upload
  -> private Artifact Exchange
  -> artifact_copy_to_workspace
  -> explicit repository write
```

This should remain explicit. Automatically writing generated files into repositories would create accidental dirty working trees and would weaken the existing containment model.

## Findings

### Finding A: Native file rewriting is the primary missing integration

`stage_artifact` cannot become the default workflow until the ChatGPT connector recognizes the top-level `file` field and rewrites generated or attached file references into an approved representation that DevSpace can normalize.

- **Severity:** P0 workflow blocker
- **Owner:** Connector integration plus DevSpace adapter implementation

### Finding B: The adapter architecture is sufficient

The registry, exact-one-adapter rule, streaming source contract, and fail-closed behavior are appropriate. ChatGPT-specific logic should remain isolated inside one trusted adapter.

- **Severity:** No redesign required
- **Owner:** DevSpace

### Finding C: Commit must be idempotent across response loss

A commit retry after successful promotion must return the same artifact record rather than `upload not found`.

- **Severity:** P0 reliability defect
- **Owner:** DevSpace Artifact Exchange

### Finding D: The advertised chunk maximum is not a safe model payload size

The server can accept 48 KiB decoded chunks, but the ChatGPT tool-call path did not reliably preserve base64 arguments of that size. Smaller 8 KiB decoded chunks worked.

The server maximum is still reasonable for programmatic clients. The returned capability should distinguish the hard server limit from a conservative recommendation for model-mediated clients.

- **Severity:** P1 fallback ergonomics
- **Owner:** Connector and DevSpace documentation/tool response

### Finding E: Commit and artifact results need traceable observability

The model could not distinguish successful promotion with a lost response from an actual failed commit. Existing logs should correlate the complete lifecycle without logging content or base64.

- **Severity:** P1 operability
- **Owner:** DevSpace

## Recommended way forward

## Phase 1: Complete the ChatGPT connector compatibility spike

Run the existing probe adapter in a controlled maintenance window against the actual ChatGPT connector.

Test at minimum:

- a user-uploaded text file;
- a user-uploaded PNG;
- a ChatGPT-generated PNG;
- a PDF;
- a DOCX or ZIP to confirm binary behavior.

For each case, determine whether the connector provides:

- an opaque file ID;
- a proxied or mounted path;
- a connector download handle;
- an embedded resource;
- another branded object shape.

Record only a sanitized structural fixture. Do not persist bearer tokens, signed URLs, raw file content, or user-specific mount paths.

Then determine what schema annotation or connector registration is required to trigger file-reference rewriting. The current `z.unknown()` JSON schema alone did not trigger it in this test.

### Acceptance criteria

- ChatGPT can invoke `stage_artifact` with a generated image without model-mediated base64.
- The connector delivers a normalized or adapter-recognizable value.
- Arbitrary user-supplied paths and URLs still fail closed.

## Phase 2: Add a reviewed ChatGPT incoming-artifact adapter

Implement one narrowly scoped adapter based on the captured fixture.

The adapter should:

- recognize only the exact trusted connector shape;
- stream bytes rather than buffering the full file;
- preserve a safe basename and MIME hint;
- verify regular-file or trusted-download semantics;
- reject unrecognized URLs, arbitrary absolute paths, symlinks, and malformed references;
- expose no connector secrets in logs or tool results.

Keep this adapter injected explicitly. Do not spread ChatGPT shape checks through `ArtifactStore` or generic artifact tools.

### Acceptance criteria

- uploaded and generated ChatGPT files stage through the same artifact pipeline;
- unit tests use sanitized connector fixtures;
- security tests prove that arbitrary lookalike objects, paths, and URLs are rejected.

## Phase 3: Make `artifact_upload_commit` idempotent

Retain a durable upload-to-artifact receipt after successful promotion.

Two reasonable implementations are:

### Option A: Keep the upload row as `committed`

Add an `artifact_id` column and transition the row rather than deleting it immediately:

```text
active -> committed
```

A repeated commit reads `artifact_id` and returns the existing artifact record.

Committed receipts may expire with a bounded retention period after which cleanup removes them.

### Option B: Add a dedicated commit-receipts table

```sql
create table artifact_upload_receipts (
  upload_id text primary key,
  client_id text not null,
  artifact_id text not null,
  committed_at text not null,
  expires_at text not null
);
```

A commit retry first checks the active upload table, then the receipt table.

Option A is simpler. Option B keeps active upload state and completed receipts conceptually separate.

### Required behavior

- first commit promotes the artifact and returns its record;
- identical retry returns the same artifact record;
- retry by a different client remains unauthorized/not found;
- a failed pre-promotion commit remains retryable after the caller corrects the missing bytes;
- receipts are cleaned up without deleting the artifact itself.

### Acceptance criteria

Add an integration test that deliberately discards the first commit response, retries the same upload ID, and asserts that both calls resolve to the same artifact ID and SHA-256.

## Phase 4: Improve lifecycle observability

Log bounded metadata for each artifact operation:

- request ID;
- MCP session ID prefix;
- OAuth client ID hash or safe prefix;
- upload ID;
- artifact ID after promotion;
- operation phase;
- byte count;
- outcome and stable error code.

Do not log:

- file content;
- base64 chunks;
- bearer credentials;
- signed URLs;
- private filenames when logging policy requires redaction.

A successful commit should emit an explicit event such as:

```text
artifact_upload_committed
```

A commit retry served from a receipt should emit:

```text
artifact_upload_commit_replayed
```

## Phase 5: Clarify fallback chunk capabilities

Keep the 48 KiB decoded hard limit for efficient programmatic clients, but return both:

```json
{
  "maxChunkBytes": 49152,
  "recommendedChunkBytes": 8192
}
```

The recommendation may later be client-specific. Documentation should state that chunking is a compatibility fallback, not the normal ChatGPT generated-file workflow.

Do not optimize the product around dozens of model-authored base64 calls. Native file staging should eliminate them.

## Phase 6: Preserve explicit workspace materialization

After staging succeeds, the normal repository handoff should remain:

```text
stage_artifact
  -> artifactId
  -> artifact_copy_to_workspace(
       artifactId,
       workspaceId,
       destination,
       onConflict
     )
```

The copy result should return the final contained workspace path and whether the operation renamed, replaced, or created the destination.

A connector-side convenience action such as “stage the most recently generated file” may improve UX, but it should normalize into the same generic `stage_artifact` contract rather than becoming a separate DevSpace storage path.

## Proposed end-to-end acceptance test

The feature is complete when this scenario succeeds without base64 reconstruction:

1. Generate a PNG with ChatGPT's native image tool.
2. Call `stage_artifact` with the generated file.
3. Receive `artifactId`, SHA-256, size, MIME type, and materialized host path.
4. Call `artifact_copy_to_workspace` into an approved disposable test workspace.
5. Verify byte-for-byte equality with the staged artifact.
6. Retry the stage or commit response path where applicable and receive the same artifact rather than a false `not found` result.
7. Confirm arbitrary paths, arbitrary URLs, and symlinks are rejected.
8. Confirm no file bytes, credentials, or protected URLs appear in logs.

## Suggested implementation order

1. **P0:** Determine and enable the connector's native file rewrite contract.
2. **P0:** Implement and fixture-test the trusted ChatGPT adapter.
3. **P0:** Make commit idempotent with a durable receipt.
4. **P1:** Add correlated lifecycle logs and explicit commit/replay events.
5. **P1:** Return a conservative recommended fallback chunk size.
6. **P1:** Run the full generated-image-to-workspace acceptance test.

## Conclusion

The dogfood test supports the existing architectural split:

- DevSpace transfers and stores bytes generically;
- the Artifact Exchange provides private, content-addressed lifecycle management;
- workspace copying is explicit;
- Haft remains responsible for importing and interpreting the resulting host-local file.

The core storage implementation worked. The remaining blockers are at the native connector boundary and the commit-response reliability boundary. Solving those two issues should turn the current multi-step debugging workflow into the intended one-call staging experience.
