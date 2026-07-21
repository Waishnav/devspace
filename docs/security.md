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

## Native File Download

Native file download is an opt-in, one-shot byte-transfer seam. It has no
persistent artifact root, object database, upload lifecycle, reusable artifact
ID, public download route, TTL, pinning, or quota ledger.

The production server declares ChatGPT's top-level `openai/fileParams` contract
and accepts only the documented `download_url`, `file_id`, optional
MIME/filename aliases, and optional size. Downloads use HTTPS on
`files.oaiusercontent.com` or the constrained regional OpenAI Azure account
family `oaisdmntpr<region>.blob.core.windows.net`, where `<region>` is lowercase
alphanumeric. Arbitrary Azure Blob accounts, alternate ports, credentials,
fragments, malformed IDs, extra fields, and redirects outside that boundary fail
closed. Opaque IDs are bounded metadata and are never used as filenames or path
components.

`download_artifact` accepts only the native file value, a `workspaceId` returned
by `open_workspace`, and a relative destination `path`. Absolute paths,
traversal, symlinked parents, and existing destinations fail closed. Callers
cannot supply a conflict mode, expected hash, host path, or storage policy.

The selected workspace is opened without following symlinks. DevSpace then
creates or opens `.devspace` and its private `incoming` staging directory through
already-open parent directory descriptors. Requested destination parents are
also created or opened component-by-component through descriptor anchors.
Replacing a pathname therefore cannot redirect writes outside the selected
workspace. Symlinked components, non-directories, non-private incoming
directories, and existing destination files fail closed. Existing directories
are inspected but are never chmodded as a startup side effect.

Bytes stream into an exclusive mode-`0600` partial under the configured per-file
limit. DevSpace computes SHA-256 while writing, verifies any size hint, chmods
and fsyncs through the still-open descriptor, then publishes the verified inode
with a no-overwrite atomic hard link at the requested path and verifies the
published inode identity. It does not path-chmod or path-hash the published file.
Partials are removed on success or failure; crash-leftover cleanup is bounded and
only considers owned, regular DevSpace partial files.

The native download seam deliberately does not:

- fetch arbitrary URLs or local paths;
- expose generic upload/chunk/stat/delete/copy tools;
- expose artifact IDs, signed URLs, host paths, temp paths, or raw content;
- extract archives or execute transferred content;
- expand workspace allowlists;
- preserve executable permissions;
- opportunistically delete legacy artifact tables or bytes.

## Logs

By default, DevSpace logs requests and tool calls. Shell command previews are
disabled unless `DEVSPACE_LOG_SHELL_COMMANDS=1`.

Do not enable shell command logging if commands may contain secrets.

Artifact tool logs contain bounded workspace ID, validated hostname,
workspace-relative output path, byte count, hash, duration, and status metadata.
`download_artifact` does not log the opaque file value. Raw content, connector
references, native file IDs, bearer credentials, presigned URLs, host paths,
temporary paths, and base64 chunks are never included in tool logs or tool
results.
