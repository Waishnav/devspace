export const meta = {
  name: "isolated-migrations",
  description: "Implement independent migration candidates in separate worktrees"
};
return await parallel(args.candidates.map(candidate => () => agent(
  `Implement and test this migration candidate: ${candidate}. Report tests and changed paths.`,
  { label: candidate, isolation: "worktree" }
)));
