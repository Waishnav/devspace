import { useEffect, useState } from "react";
import "../ui/diagrams.css";
import "../ui/routing.css";
import { Logo } from "../logos/Logo";
import { HOSTS, PROVIDERS } from "../logos";

// A host delegates through DevSpace to agents. Scripted and illustrative: the
// host list slides to bring the next host to the middle, then two agents run and
// complete. Commands and XML mirror the real `devspace agents` output; ids are
// made up.
const ROW = 62; // px per host slot
const TICKS_PER_STEP = 8;
const TICK_MS = 550;
const AGENT_IDS = ["7Kq2", "Q9m4", "Xb31", "Lp58", "Tn0d", "Ve66", "Rw29", "Zc74"];

type Phase = "idle" | "running" | "completed";

const wrap = (n: number, len: number) => ((n % len) + len) % len;

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
  const targets = [wrap(step * 2, PROVIDERS.length), wrap(step * 2 + 3, PROVIDERS.length)];
  const phase: Phase = k < 2 ? "idle" : k < 5 ? "running" : "completed";
  const routed = k >= 2;
  const host = HOSTS[wrap(step, HOSTS.length)]!;

  // Render the active host and two neighbours each side; keys are absolute so
  // each row keeps its DOM node and slides as `step` advances.
  const hostRows = [-2, -1, 0, 1, 2].map((offset) => {
    const idx = step + offset;
    return { idx, offset, host: HOSTS[wrap(idx, HOSTS.length)]! };
  });

  const lines = targets.flatMap((t, i) => {
    if (k < 2 + i) return [];
    const id = `agt_${AGENT_IDS[(step * 2 + i) % AGENT_IDS.length]}`;
    const done = phase === "completed";
    return [
      { kind: "cmd" as const, text: `devspace agents run ${PROVIDERS[t]!.id} "…"` },
      { kind: "out" as const, text: `<agent id="${id}" status="${done ? "completed" : "running"}"/>`, done },
    ];
  });

  return (
    <div className="ds-diagram dm" role="img" aria-label="Illustration: a host such as ChatGPT delegates through DevSpace to coding agents, which run and then complete">
      <div className="ds-diagram__bar">
        <span className="ds-diagram__dots"><i /><i /><i /></span>
        <span>host: <b>{host.name}</b></span>
        <span className={`dm__state dm__state--${phase}`}>{phase === "idle" ? "idle" : phase === "running" ? "delegating…" : "done"}</span>
      </div>

      <div className="dm__body">
        <div className="dm__hosts" style={{ height: ROW * 3 + 22 }}>
          <span className="dm__tag">Host</span>
          {hostRows.map(({ idx, offset, host: h }) => (
            <div
              key={idx}
              className={`dm__host ${offset === 0 ? "on" : ""}`}
              style={{
                transform: `translateY(${(offset + 1) * ROW + 22}px)`,
                opacity: offset === 0 ? 1 : Math.abs(offset) === 1 ? 0.42 : 0,
              }}
            >
              <Logo id={h.logo} size={22} />{h.name}
            </div>
          ))}
        </div>

        <div className={`dm__wire ${routed ? "on" : ""}`}><i /></div>

        <div className="dm__core"><b>devspace</b></div>

        <div className={`dm__wire ${phase === "running" ? "on" : ""}`}><i /></div>

        <ul className="dm__agents">
          {PROVIDERS.map((p, i) => {
            const active = routed && targets.includes(i);
            const status: Phase = active ? phase : "idle";
            return (
              <li key={p.id} className={active ? "on" : ""}>
                <Logo id={p.logo} size={20} />
                <span className="dm__name">{p.id}</span>
                <span className={`dm__st dm__st--${status}`}>{status}</span>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="dm__log">
        {lines.length === 0 && <div className="dm__line">&nbsp;</div>}
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
