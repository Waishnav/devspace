const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Agent ids are caller-suppliable (workflow dispatch, `--request-id`), so they need a portable shape. */
export function validateAgentId(id: string, label = "Subagent id"): string {
  if (!AGENT_ID_PATTERN.test(id)) {
    throw new Error(`${label} must be 1-128 characters using letters, numbers, '.', '_', ':' or '-'.`);
  }

  return id;
}
