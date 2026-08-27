import {
  defaultDevspaceConfig,
  type DevspaceConfig,
} from "../config-schema.js";
import { writeDevspaceConfig } from "../user-config.js";

type SectionOverrides = {
  server?: Partial<DevspaceConfig["server"]>;
  workspaces?: Partial<DevspaceConfig["workspaces"]>;
  storage?: Partial<DevspaceConfig["storage"]>;
  tools?: Partial<DevspaceConfig["tools"]>;
  ui?: Partial<DevspaceConfig["ui"]>;
  artifacts?: Partial<DevspaceConfig["artifacts"]>;
  skills?: Partial<DevspaceConfig["skills"]>;
  subagents?: DevspaceConfig["subagents"];
  logging?: Partial<DevspaceConfig["logging"]>;
  oauth?: Partial<DevspaceConfig["oauth"]>;
};

export function writeTestDevspaceConfig(
  configDir: string,
  overrides: SectionOverrides = {},
): NodeJS.ProcessEnv {
  const defaults = defaultDevspaceConfig();
  const env = { DEVSPACE_CONFIG_DIR: configDir };
  writeDevspaceConfig({
    ...defaults,
    server: { ...defaults.server, ...overrides.server },
    workspaces: { ...defaults.workspaces, ...overrides.workspaces },
    storage: { ...defaults.storage, ...overrides.storage },
    tools: { ...defaults.tools, ...overrides.tools },
    ui: { ...defaults.ui, ...overrides.ui },
    artifacts: { ...defaults.artifacts, ...overrides.artifacts },
    skills: { ...defaults.skills, ...overrides.skills },
    subagents: overrides.subagents ?? defaults.subagents,
    logging: { ...defaults.logging, ...overrides.logging },
    oauth: { ...defaults.oauth, ...overrides.oauth },
  }, env);
  return {
    ...env,
    DEVSPACE_OAUTH_OWNER_TOKEN: "test-owner-token-that-is-long-enough",
  };
}
