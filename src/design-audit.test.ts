import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import {
  runDesignAudit,
  validateDesignAuditUrl,
  type DesignAuditAdapter,
} from "./design-audit.js";

const root = await mkdtemp(join(tmpdir(), "gpt-agent-design-audit-test-"));
const baseEnv = {
  DEVSPACE_ALLOWED_ROOTS: root,
  DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
};

try {
  const disabled = await runDesignAudit(loadConfig(baseEnv), {
    workspaceRoot: root,
    url: "not-a-url",
  });
  assert.equal(disabled.status, "disabled");
  assert.equal(disabled.metrics.payloadCharacters, JSON.stringify(disabled).length);

  const enabledConfig = loadConfig({ ...baseEnv, DEVSPACE_DESIGN_AUDIT: "1" });
  const unavailable = await runDesignAudit(enabledConfig, {
    workspaceRoot: root,
    url: "http://localhost:3000/path?token=hidden#fragment",
  });
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.validatedUrl, "http://localhost:3000/path");
  assert.equal(JSON.stringify(unavailable).includes("hidden"), false);
  assert.equal(unavailable.metrics.payloadCharacters, JSON.stringify(unavailable).length);

  await assert.rejects(
    () => validateDesignAuditUrl("file:///tmp/index.html", ["localhost"]),
    /http or https/,
  );
  await assert.rejects(
    () => validateDesignAuditUrl("http://user:pass@localhost:3000", ["localhost"]),
    /must not contain credentials/,
  );
  await assert.rejects(
    () => validateDesignAuditUrl("http://192.168.1.2", ["localhost"]),
    /not allowed/,
  );
  await assert.rejects(
    () => validateDesignAuditUrl("http://[fe90::1]", ["fe90::1"]),
    /private or unsafe/,
  );
  await assert.rejects(
    () => validateDesignAuditUrl("http://[::ffff:7f00:1]", ["::ffff:7f00:1"]),
    /unsafe mapped address/,
  );
  await assert.rejects(
    () => validateDesignAuditUrl("http://198.18.0.1", ["198.18.0.1"]),
    /private or unsafe/,
  );
  await assert.rejects(
    () => validateDesignAuditUrl("http://224.0.0.1", ["224.0.0.1"]),
    /private or unsafe/,
  );
  await assert.rejects(
    () => runDesignAudit(enabledConfig, {
      workspaceRoot: root,
      url: "http://localhost:3000",
      outputDirectory: "../escape",
    }),
    /must stay inside/,
  );
  await assert.rejects(
    () => runDesignAudit(enabledConfig, {
      workspaceRoot: root,
      url: "http://localhost:3000",
      routes: ["//example.com/private"],
    }),
    /must stay on the validated origin/,
  );

  const outputDirectory = join(root, "audit-output");
  const artifactPath = join(outputDirectory, "desktop.png");
  await mkdir(outputDirectory);
  await writeFile(artifactPath, "image fixture");
  const adapter: DesignAuditAdapter = {
    name: "fake-adapter",
    async availability() { return { available: true }; },
    async run() {
      return {
        artifacts: [
          ...Array.from({ length: 55 }, () => ({
            kind: "desktop-screenshot" as const,
            path: artifactPath,
          })),
          { kind: "report" as const, path: join(root, "outside.txt") },
        ],
        consoleErrors: 2,
        overflowIssues: 1,
        accessibilityIssues: 3,
        headingIssues: 1,
        diagnostics: Array.from(
          { length: 55 },
          () => "api_key=very-secret-value-that-must-not-leak",
        ),
      };
    },
  };
  const completed = await runDesignAudit(enabledConfig, {
    workspaceRoot: root,
    url: "http://localhost:3000",
    outputDirectory: "audit-output",
  }, adapter);
  assert.equal(completed.status, "completed");
  assert.equal(completed.metrics.truncated, true);
  assert.ok(completed.metrics.payloadCharacters <= 12_000);
  assert.equal(completed.metrics.payloadCharacters, JSON.stringify(completed).length);
  assert.equal(JSON.stringify(completed).includes("very-secret-value"), false);
} finally {
  await rm(root, { recursive: true, force: true });
}
