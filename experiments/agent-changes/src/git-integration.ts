/** Quote interpolations as single POSIX shell arguments, including Git bearer credentials. */
function sh(parts: TemplateStringsArray, ...values: unknown[]): string {
  return parts.reduce((command, part, index) => {
    const arg = index < values.length
      ? `'${String(values[index]).replaceAll("'", "'\\''")}'`
      : "";
    return command + part + arg;
  }, "");
}

export interface GitIntegrationInput {
  baseRemote: string;
  forkRemote: string;
  baseCommit: string;
  headCommit: string;
  branch: string;
  baseToken: string;
  forkToken: string;
}

export interface GitCommandResult { exitCode: number; stdout: string }

/** An isolated, one-shot Git operation. The checkout is always removed, even on failure. */
export async function integrateGit(
  input: GitIntegrationInput,
  dir: string,
  run: (command: string) => Promise<GitCommandResult>,
): Promise<{ status: "merged" | "conflicted"; commit?: string }> {
  if (![input.baseCommit, input.headCommit].every((sha) => /^[a-f0-9]{40}$/.test(sha))) {
    throw new Error("Invalid proposal commit");
  }
  if (!/^\/workspace\/integration-[a-f0-9-]+$/.test(dir) && !/^\/tmp\/agent-integration-[a-f0-9-]+$/.test(dir)) {
    throw new Error("Invalid integration directory");
  }
  const baseAuth = `http.extraHeader=Authorization: Bearer ${input.baseToken}`;
  const forkAuth = `http.extraHeader=Authorization: Bearer ${input.forkToken}`;
  const checked = async (command: string): Promise<string> => {
    const result = await run(command);
    if (result.exitCode !== 0) throw new Error("Git integration command failed");
    return result.stdout.trim();
  };

  try {
    await checked(sh`git -c ${baseAuth} clone ${input.baseRemote} ${dir}`);
    const current = await checked(sh`git -C ${dir} rev-parse HEAD`);
    if (current !== input.baseCommit) throw new Error("Project baseline has changed");

    await checked(sh`git -C ${dir} -c ${forkAuth} fetch ${input.forkRemote} ${input.branch}`);
    const applied = await run(sh`git -C ${dir} -c ${"user.name=DevSpace Integrator"} -c ${"user.email=merge@devspace.invalid"} cherry-pick ${input.headCommit}`);
    if (applied.exitCode !== 0) {
      const conflicts = await checked(sh`git -C ${dir} diff --name-only --diff-filter=U`);
      if (conflicts) return { status: "conflicted" };
      throw new Error("Git integration command failed");
    }

    const commit = await checked(sh`git -C ${dir} rev-parse HEAD`);
    await checked(sh`git -C ${dir} -c ${baseAuth} push origin ${`HEAD:${input.branch}`}`);
    return { status: "merged", commit };
  } finally {
    // Never let a leftover checkout turn a transient failure into a permanent one.
    try { await run(sh`rm -rf -- ${dir}`); } catch { /* Best-effort cleanup. */ }
  }
}
