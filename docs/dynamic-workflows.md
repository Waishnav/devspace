# Dynamic workflows

DevSpace executes JavaScript that coordinates its configured subagents. The script contract includes `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`, and nested `workflow`. The same script can select different agent profiles or providers without changing its orchestration logic.

Enable workflows in your DevSpace `config.jsonc`, alongside the subagent providers you already use:

```jsonc
{
  "workflows": {
    "enabled": true,
    "defaultAgentType": "reviewer",
    "maxConcurrentAgents": 16,
    "maxConcurrentRuns": 4
  }
}
```

`reviewer` must be an existing configured profile. Run `devspace agents targets` to discover usable profiles and providers. Restart the MCP server after changing tool availability; an active execution daemon keeps its original configuration until its work finishes.

Save this example as `.devspace/workflows/review.js`:

```javascript
export const meta = {
  name: "review",
  description: "Review project areas and summarize findings",
  phases: [{ title: "Review" }, { title: "Summarize" }]
};
phase("Review");
const findings = await parallel(args.areas.map(area => () =>
  agent(`Review ${area}; identify concrete defects and include file references.`, {
    label: area,
    schema: {
      type: "object",
      properties: { findings: { type: "array", items: { type: "string" } } },
      required: ["findings"],
      additionalProperties: false
    }
  })
));
phase("Summarize");
log("Reviews finished");
return await agent(`Summarize these review results, noting failed branches: ${JSON.stringify(findings)}`);
```

Pass `{"areas":["src/server.ts","src/workspaces.ts"]}` in `input.json`:

```bash
devspace workflows run .devspace/workflows/review.js --args-file input.json
devspace workflows wait <run-id> --timeout 30
devspace workflows show <run-id>
devspace workflows save <run-id> --name review --location project
devspace workflows ls --definitions
```

The local CLI registers the current project as a workspace; it must be within configured allowed roots. MCP hosts use the existing `workspace_id`. When enabled, both tool modes expose `run_workflow`, `get_workflow`, `wait_workflow`, `control_workflow`, `list_workflows`, and `save_workflow`. Outer MCP fields use snake_case (`run_id`, `script_path`, `agent_type`, `after_revision`); script options and JSON argument keys retain their original casing.

Optional `workflows.packageRoots` registers directories of packaged workflow definitions. Relative roots resolve from the DevSpace configuration directory; package definitions are addressed as `package:name`. Project definitions take precedence over personal definitions.

The [bundled workflow skill](../skills/workflows/SKILL.md) documents all primitive signatures and lifecycle operations. It is published through workspace skill discovery, or preloaded with `workflows.instructions: "preload"`. The [configuration schema](../schema/v1/devspace.schema.json) contains resource limits and defaults.

## Execution and recovery

Runs execute in the existing local agent daemon and survive host disconnection. SQLite records run state, agent steps, attempts, events, results, and reported usage. Large event histories expose `eventsTruncated` and `nextEventRevision`; pass that cursor as `after_revision` to retrieve the next page. Completed runs export `journal.jsonl` and `result.json` under their workspace transcript directory. Results over 64 KiB return a preview and `resultArtifact`; step details use `outputArtifact`. These paths remain within the owning workspace. JavaScript runs in a bounded QuickJS guest in a worker. It has no Node, filesystem, network, or module-import capability; project access occurs through configured agents. This guest boundary does not sandbox shell commands run by agents.

Use `pause`, `resume`, and `stop` through `control_workflow` or the CLI. Individual `stop_agent` and `restart_agent` operations require a step ID. Pause gates new work and result delivery; it does not interrupt an agent already working. Stop does not undo edits. Provider cancellation must be acknowledged before a replacement turn is allowed; uncertain cancellation requires attention. Headless provider permission requests are recorded and declined; the workflow never manufactures approval.

Replay launches a new run using `resume_from_run_id` (CLI `--resume-from`). Matching recorded results can be reused, and divergence is reported. A replay is not a transaction rollback: an undelivered attempt may already have changed files. After a daemon crash, uncertain attempts are marked for recovery rather than automatically repeating side effects.

`isolation: "worktree"` creates a managed worktree for an agent. Inspect its changes before integration; DevSpace does not automatically merge them. A profile can restrict its write authority with `writeMode: read_only`, and continuation preserves that restriction. Final worktree status includes whether files or commits changed. Worktrees remain under the existing managed-worktree retention and pruning policy.

## Provider behavior

The core workflow protocol stays independent of provider SDKs. Workflow turns disable native delegation where the harness supports it, and DevSpace CLI reentry checks inherited workflow provenance. These are cooperative execution controls: unrestricted shell commands can still launch external programs. ACP has no generic way to disable provider-internal delegation, so its fleet size cannot be strictly bounded beyond the calls DevSpace observes. Adapters translate cancellation, continuation, structured results, progress, and usage. Codex and Claude support native structured-output requests; other adapters use validated JSON text. Validation errors are visible and bounded.

Output-token budgets depend on reported provider usage. They are admission limits: concurrent in-flight requests can overshoot. A provider without reliable usage cannot satisfy a required budget. Missing usage is not treated as zero. Model names, supported effort values, authentication, and provider billing remain specific to each configured harness.

The compatibility target is the portable scripting and lifecycle behavior in the [Claude workflow documentation](https://code.claude.com/docs/en/workflows) and [supplied reference](https://gist.github.com/Waishnav/38801adec1580aa689426ba075490670). Host slash menus, Anthropic account billing, and private cloud infrastructure are outside the local MCP execution layer.

Runnable authoring examples are in [examples/workflows](../examples/workflows): review and verification, a bounded repair loop, isolated migrations, and nested synthesis. Copy definitions into `.devspace/workflows` to discover them by name, and select a configured agent at launch. Nested synthesis expects the review definition to be saved first. Research tasks use the same primitives when the chosen agent actually has search tools.
