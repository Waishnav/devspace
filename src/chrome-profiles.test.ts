import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChromeProfileResolver } from "./chrome-profiles.js";
import type { CodexRuntimePaths } from "./codex-runtime-discovery.js";

const root = await mkdtemp(join(tmpdir(), "devspace-chrome-profiles-test-"));
const instanceIds = new Map<string, string>([
  ["Default", "instance-default"],
  ["Profile 3", "instance-work"],
  ["Profile 16", "instance-gemini"],
]);

await writeFile(
  join(root, "Local State"),
  JSON.stringify({
    profile: {
      info_cache: {
        Default: { name: "用户1", user_name: "default@example.com" },
        "Profile 3": { name: "baidu_yijianvip", user_name: "work@example.com" },
        "Profile 16": { name: "gemini", user_name: "gemini@example.com" },
      },
    },
  }),
);

for (const profilePath of instanceIds.keys()) {
  const profileDirectory = join(root, profilePath);
  await mkdir(join(profileDirectory, "Extensions", "test-extension"), { recursive: true });
  await mkdir(
    join(profileDirectory, "Local Extension Settings", "test-extension"),
    { recursive: true },
  );
  await writeFile(join(profileDirectory, "Preferences"), "{}");
}

const runtimePaths = {
  browserClientPath: "/tmp/plugin/scripts/browser-client.mjs",
} as CodexRuntimePaths;

const resolver = new ChromeProfileResolver({
  defaultProfile: "Default",
  runtimePaths: async () => runtimePaths,
  userDataDirectory: root,
  extensionIds: ["test-extension"],
  readExtensionInstanceId: async (storagePath) => {
    for (const [profilePath, instanceId] of instanceIds) {
      if (storagePath.includes(profilePath)) return instanceId;
    }
    return undefined;
  },
});

const listed = await resolver.list(new Set(["instance-default", "instance-gemini"]));
assert.equal(listed.length, 3);
assert.deepEqual(
  listed.map((profile) => ({
    path: profile.path,
    name: profile.name,
    email: profile.email,
    live: profile.live,
    isDefault: profile.isDefault,
  })),
  [
    {
      path: "Default",
      name: "用户1",
      email: "default@example.com",
      live: true,
      isDefault: true,
    },
    {
      path: "Profile 3",
      name: "baidu_yijianvip",
      email: "work@example.com",
      live: false,
      isDefault: false,
    },
    {
      path: "Profile 16",
      name: "gemini",
      email: "gemini@example.com",
      live: true,
      isDefault: false,
    },
  ],
);

assert.equal((await resolver.resolve(undefined)).path, "Default");
assert.equal((await resolver.resolve("用户1")).path, "Default");
assert.equal((await resolver.resolve("work@example.com")).path, "Profile 3");
assert.equal((await resolver.resolve("gemini")).path, "Profile 16");
assert.equal((await resolver.resolve("Profile 16")).email, "gemini@example.com");
await assert.rejects(() => resolver.resolve("missing"), /Chrome profile not found: missing/u);

let launchedPath: string | undefined;
const launchResolver = new ChromeProfileResolver({
  defaultProfile: "Default",
  runtimePaths: async () => runtimePaths,
  userDataDirectory: root,
  extensionIds: ["test-extension"],
  readExtensionInstanceId: async () => "instance-default",
  launchProfile: async (_profile, profileDirectory) => {
    launchedPath = profileDirectory;
  },
});
await launchResolver.launch(await launchResolver.resolve("用户1"));
assert.equal(launchedPath, join(root, "Default"));
