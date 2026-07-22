import { link } from "node:fs/promises";
import { ArtifactError } from "./artifact-error.js";

export type ArtifactPublishLink = typeof link;

export interface SecureArtifactTarget {
  writeAll(buffer: Buffer, position: number): Promise<void>;
  syncAndVerify(expectedSize: number): Promise<void>;
  publish(): Promise<void>;
  close(): Promise<void>;
}

export interface SecureArtifactTargetOptions {
  workspaceRoot: string;
  parentParts: readonly string[];
  name: string;
  publishLink: ArtifactPublishLink;
}

const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(["linux", "darwin", "win32"]);

export function isSecureArtifactPlatformSupported(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return SUPPORTED_PLATFORMS.has(platform);
}

export async function openSecureArtifactTarget(
  options: SecureArtifactTargetOptions,
): Promise<SecureArtifactTarget> {
  if (process.platform === "linux") {
    const { openLinuxArtifactTarget } = await import("./artifact-secure-filesystem-linux.js");
    return openLinuxArtifactTarget(options);
  }
  if (process.platform === "darwin") {
    const { openDarwinArtifactTarget } = await import("./artifact-secure-filesystem-darwin.js");
    return openDarwinArtifactTarget(options);
  }
  if (process.platform === "win32") {
    const { openWindowsArtifactTarget } = await import("./artifact-secure-filesystem-windows.js");
    return openWindowsArtifactTarget(options);
  }
  throw new ArtifactError(
    "artifact_platform_unsupported",
    "Native file download requires secure platform filesystem primitives.",
  );
}
