# DevSpace workflow patterns

Read `reference.md` first for the syntax. These are proven shapes for engineering work: adapt them, combine them, and
keep the parts that fit the task. Each one is a complete script.

## Designing a workflow

- **Pick targets per role.** Run `devspace agents targets` and match each step to the provider or profile that is best
  at it: a strong reasoner to plan and judge, a careful editor to implement, a cheap fast model to explore, and a
  different vendor to review. Pass them in `args` so one script serves many setups.
- **Decide with schemas.** Any step whose result controls the script (approve or not, pass or fail, a list to fan
  out over) should return JSON through `schema`, never prose that the script has to parse.
- **Bound every loop.** Loops end on a verdict *or* a maximum round count. Budget agent turns up front: a run has 128,
  and each schema correction costs one.
- **Make prompts self-contained.** A subagent only sees its prompt and the project. Paste in the plan, the diff
  summary, or the earlier findings it needs.
- **Keep readers read-only.** In a run started with `--write-mode allowed`, every call inherits write access unless
  it passes `writeMode: "read_only"`. Give it to every planner, reviewer, tester, judge, and investigator.
- **Use the right workspace.** Read-only steps run in the checkout. Sequential edits share one named worktree
  (`isolation: "worktree"` plus `workspace`). Parallel edits each get their own worktree.
- **Handle per-item failures.** `parallel` and `pipeline` never throw; check each `status`.
- **Keep it resumable.** Same inputs should produce the same calls in the same order: no timestamps or random values
  in prompts.

Start writing runs with `--write-mode allowed`; everything else stays read-only by default.

## Plan with a critic

Draft a plan, have a second model attack it, and revise until it holds up.

```js
export const meta = { name: "plan", description: "Draft, critique, and revise an implementation plan" };

const { task, planner = "codex", critic = "claude", rounds = 3 } = args;
const PLAN = {
  type: "object",
  properties: { steps: { type: "array", items: { type: "string" } }, risks: { type: "array", items: { type: "string" } } },
  required: ["steps", "risks"],
};
const CRITIQUE = {
  type: "object",
  properties: { approved: { type: "boolean" }, problems: { type: "array", items: { type: "string" } } },
  required: ["approved", "problems"],
};

let plan = await agent(`Write an implementation plan for: ${task}. Read the relevant code first.`, { target: planner, writeMode: "read_only", schema: PLAN, label: "draft" });

for (let round = 1; round <= rounds; round++) {
  const critique = await agent(
    `Critique this plan for "${task}". Check it against the code; approve only if it is complete and correct.\n${JSON.stringify(plan)}`,
    { target: critic, writeMode: "read_only", schema: CRITIQUE, label: `critique-${round}` },
  );
  if (critique.approved) return { plan, rounds: round };
  plan = await agent(
    `Revise the plan to fix these problems:\n${critique.problems.join("\n")}\nPlan:\n${JSON.stringify(plan)}`,
    { target: planner, writeMode: "read_only", schema: PLAN, label: `revise-${round}` },
  );
}

return { plan, rounds, approved: false };
```

## Implement, review, fix until approved

The core engineering loop. Edits stay in one named worktree so each fix builds on the last.

```js
export const meta = { name: "build", description: "Implement, then review and fix until the reviewer approves" };

const { task, implementer = "claude", reviewer = "codex", rounds = 3 } = args;
const REVIEW = {
  type: "object",
  properties: { approved: { type: "boolean" }, findings: { type: "array", items: { type: "string" } } },
  required: ["approved", "findings"],
};

await phase("Implement", (agent) => agent(`Implement: ${task}. Add or update tests.`, {
  target: implementer, writeMode: "allowed", isolation: "worktree", workspace: "feature",
}));

for (let round = 1; round <= rounds; round++) {
  const review = await phase(`Review ${round}`, (agent) => agent(
    `Review the uncommitted diff for: ${task}. Approve only if it is correct, tested, and complete. Cite file:line.`,
    { target: reviewer, writeMode: "read_only", workspace: "feature", schema: REVIEW },
  ));
  if (review.approved) return { approved: true, rounds: round };
  await phase(`Fix ${round}`, (agent) => agent(
    `A reviewer found these problems in your change for "${task}". Fix all of them:\n${review.findings.join("\n")}`,
    { target: implementer, writeMode: "allowed", workspace: "feature" },
  ));
}

return { approved: false, rounds };
```

## QA gate

Implement, then have a separate agent run the tests and report; fix and retry until green.

```js
export const meta = { name: "qa", description: "Implement and loop until the test suite passes" };

const { task, implementer = "claude", tester = "codex", attempts = 3 } = args;
const RESULT = {
  type: "object",
  properties: { passed: { type: "boolean" }, failures: { type: "array", items: { type: "string" } } },
  required: ["passed", "failures"],
};

await agent(`Implement: ${task}.`, { target: implementer, writeMode: "allowed", isolation: "worktree", workspace: "qa" });

for (let attempt = 1; attempt <= attempts; attempt++) {
  const result = await agent(
    "Run the project's tests and type checks. Report each failure with its error output. Do not change any files.",
    { target: tester, writeMode: "read_only", workspace: "qa", schema: RESULT, label: `test-${attempt}` },
  );
  if (result.passed) return { passed: true, attempts: attempt };
  await agent(`Make these failures pass without weakening the tests:\n${result.failures.join("\n")}`, {
    target: implementer, writeMode: "allowed", workspace: "qa", label: `fix-${attempt}`,
  });
}

return { passed: false, attempts };
```

## Explore, then synthesize

Fan cheap explorers out over separate questions, then let one model combine what they found.

```js
export const meta = { name: "explore", description: "Answer several questions in parallel, then synthesize", concurrency: 4 };

const { goal, questions, explorer = "opencode", synthesizer = "codex" } = args;

const answers = await phase("Explore", (agent) => parallel(questions, (question) => agent(
  `${question}\nAnswer from the code only. Cite file paths and symbols.`,
  { target: explorer, writeMode: "read_only", label: question.slice(0, 40) },
)));

const found = answers.map((answer, index) => ({
  question: questions[index],
  answer: answer.status === "completed" ? answer.value : `failed: ${answer.error.message}`,
}));

return await phase("Synthesize", (agent) => agent(
  `Goal: ${goal}\nCombine these findings into one answer and name what is still unknown:\n${JSON.stringify(found)}`,
  { target: synthesizer, writeMode: "read_only" },
));
```

## Multi-lens review with verification

Review from several angles at once, then have a different model confirm each finding before reporting it, which
filters out false positives.

```js
export const meta = { name: "review", description: "Review from several angles and keep only verified findings", concurrency: 4 };

const { scope = "the uncommitted diff", reviewers = ["codex", "claude"], verifier = "codex" } = args;
const lenses = ["correctness and edge cases", "security", "performance", "missing tests"];
const FINDINGS = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: { location: { type: "string" }, issue: { type: "string" } },
        required: ["location", "issue"],
      },
    },
  },
  required: ["findings"],
};
const VERDICT = {
  type: "object",
  properties: { real: { type: "boolean" }, reason: { type: "string" } },
  required: ["real", "reason"],
};

const reviews = await phase("Review", (agent) => parallel(lenses, (lens, index) => agent(
  `Review ${scope} only for ${lens}. Report concrete issues with file:line, or none.`,
  { target: reviewers[index % reviewers.length], writeMode: "read_only", schema: FINDINGS, label: lens },
)));
const findings = reviews.flatMap((review) => (review.status === "completed" ? review.value.findings : []));

const verdicts = await phase("Verify", (agent) => parallel(findings, (finding) => agent(
  `Check whether this reported issue is real by reading the code. Be skeptical.\n${JSON.stringify(finding)}`,
  { target: verifier, writeMode: "read_only", schema: VERDICT },
)));

return findings
  .map((finding, index) => ({ ...finding, verdict: verdicts[index] }))
  .filter(({ verdict }) => verdict.status === "completed" && verdict.value.real)
  .map(({ verdict, ...finding }) => ({ ...finding, reason: verdict.value.reason }));
```

## Bake-off

Several implementers solve the same task in separate worktrees; a judge picks the best. Use it when the approach is
uncertain or quality matters more than turns.

```js
export const meta = { name: "bakeoff", description: "Compare implementations from several agents and pick one" };

const { task, implementers = ["claude", "codex"], judge = "codex" } = args;
const PICK = {
  type: "object",
  properties: { winner: { type: "integer" }, reason: { type: "string" } },
  required: ["winner", "reason"],
};

const attempts = await phase("Implement", (agent) => parallel(implementers, (target) => agent(
  `Implement: ${task}. Finish with a summary of your approach and which files you changed.`,
  { target, writeMode: "allowed", isolation: "worktree", label: target },
)));

const candidates = attempts
  .map((attempt, index) => ({ index, implementer: implementers[index], attempt }))
  .filter(({ attempt }) => attempt.status === "completed");
if (candidates.length === 0) throw new Error("Every implementation failed.");

const pick = await phase("Judge", (agent) => agent(
  `Pick the best implementation of "${task}" by index. Weigh correctness, simplicity, and tests.\n` +
    candidates.map(({ index, implementer, attempt }) => `#${index} (${implementer}): ${attempt.value}`).join("\n\n"),
  { target: judge, writeMode: "read_only", schema: PICK },
));

return { winner: implementers[pick.winner], reason: pick.reason };
```

The winning worktree is kept; inspect it with `devspace workflow calls <id>` and apply it from there.

## Map over many items

When the same change applies to many independent units (modules, endpoints, files), list them first, then run each
through the same stages. Each item gets its own worktree so parallel edits never collide.

```js
export const meta = { name: "migrate", description: "Apply one change to every matching unit, then check each", concurrency: 3 };

const { change, finder = "opencode", worker = "claude", checker = "codex" } = args;
const UNITS = { type: "object", properties: { units: { type: "array", items: { type: "string" } } }, required: ["units"] };
const CHECK = { type: "object", properties: { ok: { type: "boolean" }, notes: { type: "string" } }, required: ["ok", "notes"] };

const { units } = await agent(`List every file or module that needs this change, one per entry: ${change}`, {
  target: finder, writeMode: "read_only", schema: UNITS,
});

const results = await pipeline(
  units,
  (unit, _item, index) => agent(`Apply this change to ${unit} only: ${change}`, {
    target: worker, writeMode: "allowed", isolation: "worktree", workspace: `unit-${index}`, label: unit,
  }),
  (_summary, unit, index) => agent(`Verify the change to ${unit} is complete and correct: ${change}`, {
    target: checker, writeMode: "read_only", workspace: `unit-${index}`, schema: CHECK,
  }),
);

return units.map((unit, index) => ({ unit, ...results[index] }));
```

## Debug with competing hypotheses

Generate several explanations for a bug, test each independently, then fix the one that holds.

```js
export const meta = { name: "debug", description: "Investigate competing hypotheses, then fix the confirmed cause" };

const { bug, thinker = "codex", investigator = "opencode", fixer = "claude" } = args;
const HYPOTHESES = { type: "object", properties: { hypotheses: { type: "array", items: { type: "string" } } }, required: ["hypotheses"] };
const EVIDENCE = { type: "object", properties: { confirmed: { type: "boolean" }, evidence: { type: "string" } }, required: ["confirmed", "evidence"] };

const { hypotheses } = await agent(`List up to 4 distinct root-cause hypotheses for this bug, most likely first: ${bug}`, {
  target: thinker, writeMode: "read_only", schema: HYPOTHESES,
});

const checks = await phase("Investigate", (agent) => parallel(hypotheses, (hypothesis) => agent(
  `Bug: ${bug}\nTest this hypothesis against the code and, if useful, by running commands. Do not edit files.\nHypothesis: ${hypothesis}`,
  { target: investigator, writeMode: "read_only", schema: EVIDENCE },
)));

const index = checks.findIndex((check) => check.status === "completed" && check.value.confirmed);
if (index === -1) return { fixed: false, checks };

const cause = { hypothesis: hypotheses[index], evidence: checks[index].value.evidence };
await phase("Fix", (agent) => agent(
  `Fix this bug at its root cause and add a regression test.\nBug: ${bug}\nCause: ${JSON.stringify(cause)}`,
  { target: fixer, writeMode: "allowed", isolation: "worktree" },
));

return { fixed: true, cause };
```

## Compose a full pipeline

Named workflows can call each other one level deep, so the patterns above become building blocks:

```js
export const meta = { name: "ship", description: "Plan, build with review, then gate on QA" };

const plan = await workflow("plan", { task: args.task });
const build = await workflow("build", { task: `${args.task}\nFollow this plan:\n${JSON.stringify(plan.plan)}` });
return { plan, build };
```

Nested workflows share the parent's turn budget, cancellation, and named worktrees: a nested workflow that uses
`workspace: "feature"` works on the same tree as any other step in the run that created it. Run the parent with the
write mode the nested workflows need, since they cannot exceed it.
