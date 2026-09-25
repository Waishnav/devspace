import { useEffect, useState } from "react";
import "../ui/diagrams.css";
import { Logo } from "../logos/Logo";
import { providerLogo, type LogoId } from "../logos";

type Status = "idle" | "running" | "completed";
type Line = { kind: "cmd" | "out"; text: string };
type Frame = { statuses?: Partial<Record<string, Status>>; line?: Line; wire?: "out" | "back" };
type Scenario = { host: string; logo: LogoId; frames: Frame[] };

const PROVIDERS = [
  { id: "codex", role: "planner · reviewer" },
  { id: "claude", role: "implementer" },
  { id: "opencode", role: "explorer" },
  { id: "pi", role: "second opinion" },
  { id: "cursor", role: "ui worker" },
  { id: "copilot", role: "reviewer" },
  { id: "grok", role: "builder" },
];

// Scripted, illustrative runs. Output mirrors the real `devspace agents` XML.
const SCENARIOS: Scenario[] = [
  {
    host: "ChatGPT",
    logo: "openai",
    frames: [
      { line: { kind: "cmd", text: 'devspace agents run codex --effort xhigh "Plan CSV export…"' }, statuses: { codex: "running" }, wire: "out" },
      { line: { kind: "out", text: '<agent id="agt_P1an" status="running"/>' } },
      { line: { kind: "cmd", text: "devspace agents wait agt_P1an" } },
      { statuses: { codex: "completed" }, line: { kind: "out", text: '<agent id="agt_P1an" status="completed">steps: 1. …</agent>' }, wire: "back" },
      { line: { kind: "cmd", text: 'devspace agents run claude-implementer "Implement steps 1–4…"' }, statuses: { claude: "running" }, wire: "out" },
      { line: { kind: "cmd", text: "devspace agents wait agt_Bu1d" } },
      { statuses: { claude: "completed" }, line: { kind: "out", text: '<agent id="agt_Bu1d" status="completed">summary: 6 files…</agent>' }, wire: "back" },
    ],
  },
  {
    host: "Claude Code",
    logo: "claude",
    frames: [
      { line: { kind: "cmd", text: 'devspace agents run codex "Review the staged diff…"' }, statuses: { codex: "running" }, wire: "out" },
      { line: { kind: "cmd", text: 'devspace agents run opencode-explorer "Find callers of…"' }, statuses: { opencode: "running" } },
      { line: { kind: "cmd", text: 'devspace agents run copilot-reviewer "Check test gaps…"' }, statuses: { copilot: "running" } },
      { line: { kind: "cmd", text: "devspace agents wait agt_R3vw agt_Xp1r agt_T3st" } },
      { statuses: { opencode: "completed" } },
      { statuses: { copilot: "completed" } },
      { statuses: { codex: "completed" }, line: { kind: "out", text: "3 × <agent status=\"completed\">…</agent>" }, wire: "back" },
    ],
  },
  {
    host: "Hermes",
    logo: "hermes",
    frames: [
      { line: { kind: "cmd", text: 'devspace agents run cursor-agent-worker "Polish the settings UI…"' }, statuses: { cursor: "running" }, wire: "out" },
      { line: { kind: "cmd", text: 'devspace agents run pi-reviewer "Sanity-check the change…"' }, statuses: { pi: "running" } },
      { line: { kind: "cmd", text: "devspace agents wait agt_Ux1 agt_Pi2" } },
      { statuses: { cursor: "completed" } },
      { statuses: { pi: "completed" }, line: { kind: "out", text: '2 × <agent status="completed">…</agent>' }, wire: "back" },
    ],
  },
];

const TICK_MS = 1100;

export default function DelegationDiagram() {
  const [scenarioIndex, setScenarioIndex] = useState(0);
  const [frameIndex, setFrameIndex] = useState(0);
  const scenario = SCENARIOS[scenarioIndex]!;

  useEffect(() => {
    const done = frameIndex >= scenario.frames.length;
    const timer = setTimeout(
      () => {
        if (done) {
          setScenarioIndex((i) => (i + 1) % SCENARIOS.length);
          setFrameIndex(0);
        } else {
          setFrameIndex((i) => i + 1);
        }
      },
      done ? 2600 : TICK_MS,
    );
    return () => clearTimeout(timer);
  }, [frameIndex, scenario]);

  const shown = scenario.frames.slice(0, frameIndex);
  const statuses: Record<string, Status> = {};
  for (const frame of shown) Object.assign(statuses, frame.statuses);
  const lines = shown.flatMap((frame) => (frame.line ? [frame.line] : [])).slice(-4);
  const wire = shown.at(-1)?.wire;
  const anyRunning = Object.values(statuses).includes("running");

  return (
    <div className="ds-diagram" aria-label="Illustration: a host delegating work to other coding agents through DevSpace">
      <div className="ds-diagram__bar">
        <span className="ds-diagram__dots"><i /><i /><i /></span>
        <span>host: {scenario.host}</span>
        <span>{anyRunning ? "delegating…" : "idle"}</span>
      </div>
      <div className="ds-deleg">
        <div className="ds-node">
          <div className="ds-node__label">host</div>
          <div className="ds-node__title ds-node__host"><Logo id={scenario.logo} size={16} />{scenario.host}</div>
          <div className="ds-node__label" style={{ textTransform: "none", letterSpacing: 0 }}>
            translates intent → briefs
          </div>
        </div>
        <div className={`ds-wire ${wire ? "ds-wire--active" : ""} ${wire === "back" ? "ds-wire--back" : ""}`}>
          <span className="ds-wire__pulse" />
        </div>
        <div className="ds-node ds-node--core">
          <div className="ds-node__label">local</div>
          <div className="ds-node__title">devspace</div>
          <div className="ds-node__label" style={{ textTransform: "none", letterSpacing: 0 }}>agentd</div>
        </div>
        <div className={`ds-wire ${anyRunning ? "ds-wire--active" : ""}`}>
          <span className="ds-wire__pulse" />
        </div>
        <div className="ds-providers">
          {PROVIDERS.map((provider) => {
            const status = statuses[provider.id] ?? "idle";
            return (
              <div key={provider.id} className={`ds-prov ds-prov--${status}`}>
                <span className="ds-prov__name">
                  <Logo id={providerLogo(provider.id)} size={14} /> {provider.id} <span className="ds-prov__role">{provider.role}</span>
                </span>
                <span className={`ds-status ds-status--${status}`}>{status}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="ds-log" aria-live="off">
        {lines.map((line, i) => (
          <div key={`${scenarioIndex}-${frameIndex}-${i}-${line.text}`} className={`ds-log__line ds-log__${line.kind}`}>
            {line.text}
          </div>
        ))}
      </div>
    </div>
  );
}
