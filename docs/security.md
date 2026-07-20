# Security Model

DevSpace exposes local coding capabilities over MCP. Treat it as remote access
to your development machine.

The security model is simple:

- you choose a narrow filesystem allowlist
- the MCP endpoint requires OAuth approval with your Owner password
- Host headers are allowlisted from the configured public URL
- every coding action happens through explicit MCP tool calls

## Filesystem Allowlist

DevSpace only opens workspaces under configured roots.

Good examples:

```text
~/work
~/personal/open-source
```

Avoid broad roots:

```text
~
/
C:\
```

The narrower the root, the easier it is to reason about what the MCP client can
reach.

## Owner Password

`devspace init` generates an Owner password and stores it in:

```text
~/.devspace/auth.json
```

When an MCP client connects, DevSpace shows an approval page. Enter the Owner
password only when you intentionally want that client to access this server.

For env-driven deployments, set a long random value:

```bash
DEVSPACE_OAUTH_OWNER_TOKEN="$(openssl rand -base64 32)"
```

## Public URL And Host Allowlist

DevSpace needs `DEVSPACE_PUBLIC_BASE_URL` so MCP clients can discover OAuth
metadata and connect to the correct resource.

The value should be the origin only:

```text
https://your-tunnel-host.example.com
```

Do not include `/mcp` in `DEVSPACE_PUBLIC_BASE_URL`.

By default, DevSpace derives allowed Host headers from the local host and public
URL. Use `DEVSPACE_ALLOWED_HOSTS=*` only for intentional local debugging.

## Tunnels

DevSpace does not manage tunnels. Your tunnel or reverse proxy should point to:

```text
http://127.0.0.1:7676
```

Prefer adding Cloudflare Access, Tailscale identity controls, or equivalent
protection in front of public tunnels. DevSpace OAuth still protects the MCP
endpoint, but the tunnel URL should not be treated as a secret.

## Shell Access

The shell tool is powerful by design. It is meant for tests, builds, git, and
package scripts.

Filesystem path containment applies to DevSpace file tools. Shell commands run
as local commands and can do what your user account can do. This is why the MCP
client must be trusted and the Owner password must stay private.

## Worktrees

Managed worktrees reduce accidental edits to your active checkout, but they are
not a security boundary. They are a workflow boundary for isolated coding
sessions.

## Artifact Exchange

The Artifact Exchange is an opt-in private byte-transfer seam. Its root is
separate from allowed workspace roots, repositories, worktrees, temporary
folders, and public static assets.

DevSpace selects every storage path. Artifact names are metadata, not path
components. Names are Unicode-normalized and must be a single non-hidden
basename without separators, NUL bytes, or control characters. The store uses
content-addressed immutable objects, mode `0700` directories, mode `0600`
object and partial files, atomic promotion, realpath containment checks,
regular-file enforcement, and no-follow file opens where the platform supports
them.

Artifact records are scoped to the authenticated OAuth client. The first
version remains under the existing owner-only `devspace` scope. It does not add
an unauthenticated download route or expose the artifact root with
`express.static`.

Native staging is adapter-gated. The production server declares ChatGPT's
top-level `openai/fileParams` contract and accepts only the documented
`download_url`, `file_id`, optional MIME/filename aliases, and optional size.
Downloads use HTTPS on `files.oaiusercontent.com` or the constrained regional
OpenAI Azure account family
`oaisdmntpr<region>.blob.core.windows.net`, where `<region>` is lowercase
alphanumeric. This permits observed OpenAI regional accounts such as
`centralus`, `westcentralus`, and `centralindia`, but not arbitrary Azure Blob
accounts. Credentials, fragments, alternate ports, malformed IDs, extra fields,
and redirects outside that boundary fail closed. Opaque IDs are bounded metadata
and are never used as filenames or path components.

The staging seam deliberately does not:

- fetch arbitrary URLs
- expose a generic upload API
- automatically copy content into a workspace or repository
- extract archives
- execute transferred content
- expand workspace allowlists
- preserve executable permissions
- publish or permanently retain content

`artifact_copy_to_workspace` is the explicit exception: it reads only an
owner-scoped staged artifact and writes only within an already-open allowed
workspace. It requires a relative destination and an explicit conflict mode,
creates only real contained parent directories, rejects symlink/non-regular-file
paths, and verifies the final size and SHA-256.

MIME types are hints only. SHA-256 and byte counts are computed and enforced by
the server. Pinned records require explicit deletion; unpinned records and
failed in-progress transfers remain subject to cleanup.

## Logs

By default, DevSpace logs requests and tool calls. Shell command previews are
disabled unless `DEVSPACE_LOG_SHELL_COMMANDS=1`.

Do not enable shell command logging if commands may contain secrets.

Artifact tool logs contain identifiers, names, MIME hints, byte counts, hashes,
and status fields. `stage_artifact` logs only whether a file value and expected
digest were supplied plus non-sensitive options; it does not log the opaque
file value. Raw content, connector references, bearer credentials, presigned
URLs, and base64 chunks are never included in tool logs or tool results.
