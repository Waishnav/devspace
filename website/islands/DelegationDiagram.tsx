import { useEffect, useState } from "react";
import "../ui/diagrams.css";
import "../ui/routing.css";
import { Logo } from "../logos/Logo";
import Fit from "./Fit";
import { HOSTS, PROVIDERS } from "../logos";

// A host delegates through DevSpace to agents. Scripted and illustrative: the
// host list slides to bring the next host to the middle, then two agents run and
// complete. Commands and XML mirror the real `devspace agents` output; ids are
// made up. Laid out at DESIGN_WIDTH and scaled to fit, like the hero mocks.
const DESIGN_WIDTH = 720;
const ROW = 62; // px per host slot
const TICKS_PER_STEP = 8;
const TICK_MS = 550;
const AGENT_IDS = ["7Kq2", "Q9m4", "Xb31", "Lp58", "Tn0d", "Ve66", "Rw29", "Zc74"];

// Agent rows, matching `.dm__agents li` height and gap in routing.css, so the
// fan's curves land on each row's centre.
const AGENT_ROW = 38;
const AGENT_GAP = 9;
const FAN_HEIGHT = PROVIDERS.length * AGENT_ROW + (PROVIDERS.length - 1) * AGENT_GAP;

const fanCurve = (i: number) => {
  const y = i * (AGENT_ROW + AGENT_GAP) + AGENT_ROW / 2;
  const mid = FAN_HEIGHT / 2;

  return `M0 ${mid} C 55 ${mid}, 45 ${y}, 100 ${y}`;
};

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
    <Fit width={DESIGN_WIDTH}>
      <div className="ds-diagram dm" role="img" aria-label="Illustration: a host such as Grok Bot delegates through DevSpace to coding agents, which run and then complete">
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

          <div className="dm__core"><img className="dm__logo dm__logo--light" src="/logos/devspace-blue.png" alt="" width="27" height="28" /><img className="dm__logo dm__logo--dark" src="/logos/devspace-tile.png" alt="" width="28" height="28" /><b>DevSpace</b></div>

          <svg className="dm__fan" style={{ height: FAN_HEIGHT }} viewBox={`0 0 100 ${FAN_HEIGHT}`} preserveAspectRatio="none" aria-hidden="true">
            {PROVIDERS.map((p, i) => {
              const active = routed && targets.includes(i);

              return <path key={p.id} d={fanCurve(i)} className={active ? `on dm__fan--${phase}` : ""} />;
            })}
          </svg>

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
    </Fit>
  );
}
