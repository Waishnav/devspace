# Native file exchange

DevSpace can transfer files in both directions between an MCP host such as
ChatGPT and an already-open local workspace. Enable the tools with
`DEVSPACE_ARTIFACTS=1`.

## Export a workspace file to the conversation

Use `export_file` when a file already exists on the DevSpace machine and the MCP
host needs the original bytes.

```text
open_workspace
  -> export_file({ workspaceId, path, mimeType? })
  -> embedded MCP binary resource + metadata
```

```text
export_file({
  workspaceId: "ws_123",
  path: "reports/result.pdf"
})
```

The tool reads one regular file from the selected workspace and returns the file
name, MIME type, byte size, SHA-256 digest, and original bytes.

PNG, JPEG, WebP, and GIF files are returned as native MCP `image` content. This
places the image in the model's multimodal input so it can inspect the pixels
rather than merely receiving a downloadable attachment. Other binary formats are
returned as embedded MCP resources for compatible file-aware hosts.

The existing `read` tool uses the same behavior for recognized binary paths.
For native application screenshots, use `computer_use` with
`action=get_app_state`. For Chrome screenshots, use `chrome_use` with
`action=screenshot` or request `observe=screenshot|both` after an action. The
older `capture_screen` and `read({ path: "@screen" })` paths exist only when the
explicit legacy Swift backend is selected. See
[Local Multimodal Files, Computer Use, and Chrome Use](computer-use.md).

The source must resolve inside the selected workspace. Absolute paths, path
traversal, directories, unreadable files, and links that resolve outside the
workspace are rejected. The file is checked before and after reading so a file
that changes during export is not returned.

## Download a host file into a workspace

`download_artifact` handles the opposite direction: a file attached or generated
by the MCP host is saved into an open workspace.

```text
open_workspace
  -> download_artifact({ file, workspaceId, path })
  -> { path }
```

```text
download_artifact({
  file: <native file value supplied by the MCP host>,
  workspaceId: "ws_123",
  path: "public/images/generated-image.png"
})
```

The `file` input must be the native value supplied by the MCP host. DevSpace does
not accept pasted download URLs or local source paths. It validates the complete
file-object shape, trusted OpenAI download hosts, and redirects before streaming.
Malformed references, unknown fields, absolute paths, traversal, and symlinked
parents are rejected.

Downloads are streamed under `DEVSPACE_ARTIFACT_MAX_FILE_BYTES` and published as
owner-only files without overwriting an existing destination. The download tool
is currently available on Linux. The export tool is available on every platform
supported by DevSpace.

## Limits

Both directions use `DEVSPACE_ARTIFACT_MAX_FILE_BYTES`, which defaults to 100 MiB.
An embedded binary resource is carried in an MCP JSON response and therefore has
base64 and transport overhead. The practical host limit may be lower than the
DevSpace limit; validate representative file sizes with the target MCP host.
