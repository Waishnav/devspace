import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
const exec = promisify(execFile);

export function workflowHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** No guessed cache hits: large/linked/unreadable contexts disable replay. */
export async function workflowContextHash(root: string): Promise<string | undefined> {
  const hash = createHash("sha256");
  let count = 0;
  let bytes = 0;
  try {
    const head = await exec("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 5_000 });
    hash.update(JSON.stringify({ head: head.stdout }));
    async function visit(path: string, relative: string): Promise<void> {
      if (++count > 20_000) throw new Error("context too large");
      const stat = await lstat(path);
      hash.update(JSON.stringify({ path: relative, mode: stat.mode, size: stat.isFile() ? stat.size : 0, directory: stat.isDirectory() }));
      if (stat.isSymbolicLink()) {
        // A symlink can expose changing data outside the observed tree.
        throw new Error("linked context");
      }
      if (stat.isDirectory()) {
        for (const entry of (await readdir(path)).sort()) {
          if (entry === ".git") continue;
          await visit(join(path, entry), `${relative}/${entry}`);
        }
      } else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > 64 * 1024 * 1024) throw new Error("context too large");
        const file = await open(path, "r");
        try {
          const buffer = Buffer.alloc(stat.size + 1);
          let length = 0;
          while (length < buffer.length) {
            const chunk = await file.read(buffer, length, buffer.length - length, length);
            if (!chunk.bytesRead) break;
            length += chunk.bytesRead;
          }
          const after = await file.stat();
          if (length !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs || after.ino !== stat.ino) throw new Error("changing context");
          hash.update(buffer.subarray(0, length));
        } finally { await file.close(); }
      } else throw new Error("special file context");
    }
    await visit(root, "");
    return hash.digest("hex");
  } catch { return undefined; }
}
