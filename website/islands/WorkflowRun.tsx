import { useEffect, useState } from "react";
import "../ui/diagrams.css";

type Call = { label: string; target: string; phase: string; start: number; end: number };

// An illustrative `ship` workflow run on a shared clock (ticks). Parallel calls
// overlap in time, which is the point of the illustration.
const PHASES = ["Plan", "Build", "Verify"];
const CALLS: Call[] = [
  { label: "plan", target: "codex · xhigh", phase: "Plan", start: 0, end: 5 },
  { label: "implement", target: "claude-implementer", phase: "Build", start: 5, end: 13 },
  { label: "review", target: "copilot-reviewer", phase: "Verify", start: 13, end: 18 },
  { label: "qa", target: "codex-qa-tester", phase: "Verify", start: 13, end: 20 },
  { label: "summary", target: "pi-reviewer", phase: "Verify", start: 20, end: 23 },
];
const LAST_TICK = 23;
const TICK_MS = 420;

export default function WorkflowRun() {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const timer = setTimeout(
      () => setTick((t) => (t > LAST_TICK + 6 ? 0 : t + 1)),
      TICK_MS,
    );
    return () => clearTimeout(timer);
  }, [tick]);

  const started = CALLS.filter((call) => call.start <= tick);
  const activePhase = started.at(-1)?.phase ?? PHASES[0];
  const completed = CALLS.filter((call) => call.end <= tick).length;
  const status = completed === CALLS.length ? "completed" : "running";

  return (
    <div className="ds-diagram" aria-label="Illustration: a dynamic workflow run moving through Plan, Build, and Verify phases">
      <div className="ds-diagram__bar">
        <span className="ds-diagram__dots"><i /><i /><i /></span>
        <span>devspace workflow tui · ship</span>
        <span className={`ds-status ds-status--${status}`}>{status}</span>
      </div>
      <div className="ds-wf">
        <div className="ds-wf__phases">
          {PHASES.map((phase) => {
            const calls = CALLS.filter((call) => call.phase === phase);
            const done = calls.filter((call) => call.end <= tick).length;
            return (
              <div key={phase} className={`ds-wf__phase ${phase === activePhase ? "ds-wf__phase--active" : ""}`}>
                <span>{phase}</span>
                <span>{done}/{calls.length}</span>
              </div>
            );
          })}
        </div>
        <div className="ds-wf__calls">
          {started.map((call, index) => {
            const progress = Math.min(1, (tick - call.start) / (call.end - call.start));
            const callStatus = progress >= 1 ? "completed" : "running";
            return (
              <div key={call.label} className="ds-wf__call">
                <span className="ds-wf__idx">{index}</span>
                <span>{call.label}</span>
                <span className="ds-wf__target">{call.target}</span>
                <span className={`ds-status ds-status--${callStatus}`}>{callStatus}</span>
                <div className="ds-wf__bar"><span style={{ width: `${progress * 100}%` }} /></div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="ds-wf__foot">
        <span>{completed}/{CALLS.length} calls</span>
        <span>↑↓ navigate · enter open · q quit</span>
      </div>
    </div>
  );
}
