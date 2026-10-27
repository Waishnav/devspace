import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { QaCardCall, QaRun, QaStep } from "../transcript.js";
import { hostStyles } from "./host-styles.js";

type CardState = "loading" | "initialized" | "ready" | "timeout" | "error";

interface CardStatus {
  step: number;
  state: CardState;
  height: number;
  error?: string;
}

declare global {
  interface Window {
    /** Read by the QA runner through agent-browser once every card has settled. */
    __devspaceQa: { settled: boolean; cards: CardStatus[]; hostEvents: unknown[] };
  }
}

const CARD_TIMEOUT_MS = 15_000;

// Cards keep resizing while fonts and diff highlighting load; wait for a quiet period.
const SIZE_QUIET_MS = 800;

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "dark" : "light";

// A bare host sends only the theme, like hosts that do not implement style variables.
const bareHost = params.get("styles") === "none";

document.documentElement.dataset.theme = theme;

window.__devspaceQa = { settled: false, cards: [], hostEvents: [] };

const run = await (await fetch("/api/run")).json() as QaRun & { sandboxOrigin: string };

renderSummary(run);

const pending = run.steps.map((step) => renderStep(run, step));

await Promise.all(pending);

window.__devspaceQa.settled = true;

function renderSummary(qaRun: QaRun): void {
  const header = document.getElementById("summary")!;
  const failed = qaRun.steps.filter((step) => step.failures.length > 0).length;
  header.innerHTML = "";
  header.append(
    element("h1", {}, `${qaRun.scenario.name}`),
    element("p", {}, qaRun.scenario.description),
    element("p", { className: "meta" }, `${qaRun.checkout.branch ?? "detached"} @ ${qaRun.checkout.commit?.slice(0, 12) ?? "?"}${qaRun.checkout.dirty ? " (dirty)" : ""} · ${qaRun.steps.length} steps · ${failed} with failures · theme ${theme}${bareHost ? " (bare host)" : ""}`),
  );
}

async function renderStep(qaRun: QaRun & { sandboxOrigin: string }, step: QaStep): Promise<void> {
  const section = element("section", { className: "step", id: `step-${step.index}` });
  const ok = step.failures.length === 0;
  section.append(
    element("h2", {},
      `${step.index}. ${step.tool}`,
      element("span", { className: `badge ${ok ? "ok" : "fail"}` }, ok ? (step.result?.isError ? "expected error" : "ok") : "failed"),
      element("span", { className: "meta" }, `${step.durationMs} ms${step.label ? ` · ${step.label}` : ""}`),
    ),
    details("arguments", JSON.stringify(step.arguments, null, 2)),
    details("result", step.error ?? JSON.stringify(step.result, null, 2)),
  );

  if (!ok) section.append(element("ul", { className: "failures" }, ...step.failures.map((failure) => element("li", {}, failure))));
  document.getElementById("steps")!.append(section);

  if (step.resourceUri && step.result) await mountCard(qaRun, step, step.result, section);
}

async function mountCard(
  qaRun: QaRun & { sandboxOrigin: string },
  step: QaStep,
  result: CallToolResult,
  section: HTMLElement,
): Promise<void> {
  const status: CardStatus = { step: step.index, state: "loading", height: 0 };
  window.__devspaceQa.cards.push(status);
  const callLog = element("ul", { className: "meta" });

  const iframe = document.createElement("iframe");
  iframe.className = "card-frame";
  iframe.title = `${step.tool} card`;
  iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups");
  section.append(iframe, callLog);

  const tool = qaRun.tools.find((item) => item.name === step.tool);

  const bridge = new AppBridge(
    null,
    { name: "devspace-qa-host", version: "1.0.0" },
    { serverTools: {}, openLinks: {}, downloadFile: {}, logging: {} },
    {
      hostContext: {
        theme,
        ...(bareHost ? {} : { styles: hostStyles(theme) }),
        displayMode: "inline",
        availableDisplayModes: ["inline"],
        platform: "web",
        locale: "en-US",
        timeZone: "UTC",
        containerDimensions: { maxHeight: 2000 },
        ...(tool ? { toolInfo: { tool } } : {}),
      },
    },
  );

  const hostEvent = (kind: string, detail: unknown) => {
    window.__devspaceQa.hostEvents.push({ step: step.index, kind, detail });
    callLog.append(element("li", {}, `card → ${kind}: ${summarize(detail)}`));
  };

  bridge.oncalltool = async (params) => {
    const response = await fetch("/api/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ step: step.index, name: params.name, arguments: params.arguments, _meta: params._meta }),
    });

    const call = await response.json() as QaCardCall;
    hostEvent("tools/call", { name: params.name, error: call.error, isError: call.result?.isError });

    if (call.error || !call.result) throw new Error(call.error ?? "Tool call failed");

    return call.result;
  };

  bridge.onopenlink = async (params) => {
    hostEvent("open-link", params);

    return {};
  };

  bridge.ondownloadfile = async (params) => {
    hostEvent("download-file", params);

    return {};
  };

  bridge.onmessage = async (params) => {
    hostEvent("message", params);

    return {};
  };

  bridge.onupdatemodelcontext = async (params) => {
    hostEvent("update-model-context", params);

    return {};
  };

  bridge.onrequestdisplaymode = async (params) => {
    hostEvent("request-display-mode", params);

    return { mode: "inline" };
  };

  bridge.onloggingmessage = (params) => console.log(`[card ${step.index}]`, params.level, params.data);

  let quietTimer: number | undefined;
  let finish: () => void = () => undefined;
  const settled = new Promise<void>((resolveSettled) => { finish = resolveSettled; });

  const markReady = () => {
    window.clearTimeout(quietTimer);
    quietTimer = window.setTimeout(() => {
      if (status.state === "initialized") status.state = "ready";
      finish();
    }, SIZE_QUIET_MS);
  };

  bridge.onsizechange = ({ height }) => {
    if (height === undefined) return;
    status.height = Math.ceil(height);
    iframe.style.height = `${status.height}px`;

    if (status.state === "initialized") markReady();
  };

  bridge.oninitialized = () => {
    status.state = "initialized";
    void bridge.sendToolInput({ arguments: step.arguments })
      .then(() => bridge.sendToolResult(result))
      .then(markReady)
      .catch((error: unknown) => {
        status.state = "error";
        status.error = error instanceof Error ? error.message : String(error);
        finish();
      });
  };

  const timeout = window.setTimeout(() => {
    if (status.state === "loading" || status.state === "initialized") status.state = "timeout";
    finish();
  }, CARD_TIMEOUT_MS);

  // Connect before loading so the card's ui/initialize request is not missed.
  // Racing against `settled` lets the timeout end a setup that never loads.
  const setup = async () => {
    const loaded = new Promise((resolveLoad) => iframe.addEventListener("load", resolveLoad, { once: true }));
    iframe.src = "about:blank";
    await loaded;
    await bridge.connect(new PostMessageTransport(iframe.contentWindow!, iframe.contentWindow!));
    iframe.src = `${qaRun.sandboxOrigin}/resource?uri=${encodeURIComponent(step.resourceUri!)}`;
  };

  try {
    await Promise.race([setup(), settled]);
  } catch (error) {
    status.state = "error";
    status.error = error instanceof Error ? error.message : String(error);
    finish();
  }

  await settled;
  window.clearTimeout(timeout);
}

function details(label: string, text: string): HTMLElement {
  return element("details", {}, element("summary", {}, label), element("pre", {}, text));
}

function summarize(value: unknown): string {
  const text = JSON.stringify(value);

  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]>,
  ...children: Array<string | Node>
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);

  return node;
}
