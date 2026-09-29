import { useEffect, useState } from "react";
import "../ui/diagrams.css";
import "../ui/routing.css";
import { Logo } from "../logos/Logo";
import { HOSTS, PROVIDERS } from "../logos";

// Any host to any agent, through DevSpace. Illustrative and scripted: each step
// lights one host and two agents, which run and then complete. Commands and XML
// mirror the real `devspace agents` output; ids are made up.
const H = 380;
const hostY = HOSTS.map((_, i) => (H / HOSTS.length) * (i + 0.5));
const provY = PROVIDERS.map((_, i) => (H / PROVIDERS.length) * (i + 0.5));
const mid = H / 2;
const curve = (x1: number, y1: number, x2: number, y2: number) =>
  `M${x1} ${y1} C ${x1 + (x2 - x1) * 0.55} ${y1}, ${x2 - (x2 - x1) * 0.55} ${y2}, ${x2} ${y2}`;

const TICKS_PER_STEP = 7;
const TICK_MS = 550;
const AGENT_IDS = ["7Kq2", "Q9m4", "Xb31", "Lp58", "Tn0d", "Ve66", "Rw29", "Zc74"];

type Phase = "idle" | "running" | "completed";

function stepAt(step: number) {
  const host = step % HOSTS.length;
  const targets = [(step * 2) % PROVIDERS.length, (step * 2 + 3) % PROVIDERS.length];
  return { host, targets };
}

export default function DelegationDiagram() {
  const [tick, setTick] = useState(0);
  const reduced = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  useEffect(() => {
    if (reduced) return;
    const timer = setInterval(() => setTick((t) => t + 1), TICK_MS);
    return () => clearInterval(timer);
  }, [reduced]);

  const step = reduced ? 0 : Math.floor(tick / TICKS_PER_STEP);
  const k = reduced ? TICKS_PER_STEP - 1 : tick % TICKS_PER_STEP;
  const { host, targets } = stepAt(step);
  const phase: Phase = k < 1 ? "idle" : k < 4 ? "running" : "completed";
  const routed = k >= 1;

  const lines = targets.flatMap((t, i) => {
    const id = `agt_${AGENT_IDS[(step * 2 + i) % AGENT_IDS.length]}`;
    const shown = k >= 1 + i;
    if (!shown) return [];
    return [
      { kind: "cmd" as const, text: `devspace agents run ${PROVIDERS[t]!.id} "…"` },
      { kind: "out" as const, text: `<agent id="${id}" status="${phase === "completed" ? "completed" : "running"}"/>`, done: phase === "completed" },
    ];
  });

  return (
    <div className="ds-diagram dm" role="img" aria-label="Illustration: any chat app or coding agent on the left routes through DevSpace to any of seven coding agents on the right">
      <div className="ds-diagram__bar">
        <span className="ds-diagram__dots"><i /><i /><i /></span>
        <span>devspace · <b>any host → any agent</b></span>
        <span className="dm__caption">{HOSTS[host]!.name} → {targets.map((t) => PROVIDERS[t]!.name).join(" + ")}</span>
      </div>

      <div className="dm__labels"><span>Orchestrate from</span><span>Delegate to</span></div>

      <div className="dm__canvas" style={{ height: H }}>
        <svg viewBox={`0 0 1000 ${H}`} preserveAspectRatio="none" aria-hidden="true">
          {hostY.map((y, i) => <path key={`h${i}`} d={curve(225, y, 425, mid)} className={routed && i === host ? "on" : ""} />)}
          {provY.map((y, i) => <path key={`p${i}`} d={curve(575, mid, 775, y)} className={routed && targets.includes(i) ? "on" : ""} />)}
        </svg>

        <ul className="dm__col dm__col--l">
          {HOSTS.map((h, i) => (
            <li key={h.name} className={i === host ? "on" : ""} style={{ top: `${(hostY[i]! / H) * 100}%` }}>
              <Logo id={h.logo} size={18} />{h.name}
            </li>
          ))}
        </ul>

        <div className={`dm__core ${routed ? "on" : ""}`}><b>devspace</b><span>workspaces · subagents<br />workflows</span></div>

        <ul className="dm__col dm__col--r">
          {PROVIDERS.map((p, i) => {
            const active = routed && targets.includes(i);
            const status: Phase = active ? phase : "idle";
            return (
              <li key={p.id} className={active ? "on" : ""} style={{ top: `${(provY[i]! / H) * 100}%` }}>
                <Logo id={p.logo} size={18} /><span className="dm__name">{p.name}</span>
                <i className={`dm__st dm__st--${status}`} aria-hidden="true" />
              </li>
            );
          })}
        </ul>
      </div>

      <div className="dm__log">
        {lines.length === 0 && <div className="dm__line dm__line--out">&nbsp;</div>}
        {lines.map((line, i) => (
          <div key={`${step}-${i}-${line.text}`} className={`dm__line dm__line--${line.kind}`}>
            {line.kind === "cmd" ? <><span className="dm__prompt">$</span> {line.text}</> : (
              <>{line.text}{line.done ? <b className="dm__ok"> ✓</b> : null}</>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
