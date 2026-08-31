import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  isExpandableCard,
  isInitiallyExpandedCard,
  summaryNumber,
  type HostContext,
  type ToolResultCard,
} from "./card-types.js";
import {
  getProviderLogo,
  renderIcon,
  toolIcons,
  type ProviderLogoTheme,
  type ToolIcon,
} from "./icons.js";
import {
  getFileChangePathDisplay,
  getPatchDisplayParts,
} from "./patch-display.js";
import {
  decodeToolResult,
  toolResultFromChatGptGlobals,
  type ChatGptToolGlobals,
} from "./tool-result.js";
import "./workspace-app.css";

interface CardDisplay {
  icon: ToolIcon;
  title: string;
  label?: string;
  tone: "workspace" | "review";
}

interface MountedPayload {
  update(options: {
    card: ToolResultCard;
    hostContext?: HostContext;
    errorMessage?: string | null;
    visibleFileCount?: number;
  }): void;
  unmount(): void;
}

let app: App | null = null;
let connected = false;
let connectionError: string | null = null;
let hostContext: HostContext | undefined;
let card: ToolResultCard | null = null;
let expanded = false;
let reviewFilesExpanded = false;
let errorMessage: string | null = null;
let currentPayload: MountedPayload | null = null;
let currentPayloadContainer: HTMLElement | null = null;
let openWorkspaceInstructionKey: string | null = null;
let showAvailableWorkspaceInstructions = false;
let pendingToolResult: CallToolResult | null = null;
let pendingReviewKey: string | null = null;

const maybeAppRoot = document.querySelector<HTMLElement>("#app");

if (!maybeAppRoot) {
  throw new Error("Missing #app root element.");
}

const appRoot = maybeAppRoot;

void boot();

async function boot(): Promise<void> {
  render();

  app = new App(
    { name: "devspace-tool-cards", version: "0.4.0" },
    {},
  );

  app.ontoolresult = (result) => {
    if (!connected) {
      pendingToolResult = result;
      return;
    }
    void applyToolResult(result);
  };

  app.onhostcontextchanged = (ctx) => {
    const previousTheme = hostContext?.theme;
    hostContext = {
      ...hostContext,
      ...ctx,
    };
    applyHostContext();
    // Workspace details inherit host variables directly. Rebuilding their DOM on
    // iframe resize would reset an in-progress instruction preview interaction.
    if (card?.tool === "open_workspace") {
      if (ctx.theme && ctx.theme !== previousTheme) {
        syncWorkspaceProviderLogos(ctx.theme === "light" ? "light" : "dark");
      }
    } else {
      renderPayloadIfNeeded();
    }
  };

  app.onteardown = async () => {
    window.removeEventListener("openai:set_globals", handleChatGptGlobalsChanged);
    unmountPayload();
    return {};
  };

  try {
    await app.connect();
    const initialContext = app.getHostContext();
    if (initialContext) hostContext = initialContext;
    applyHostContext();
    connected = true;
    window.addEventListener("openai:set_globals", handleChatGptGlobalsChanged);
  } catch (connectError) {
    connectionError = connectError instanceof Error
      ? connectError.message
      : String(connectError);
  }

  const initialResult = pendingToolResult ?? chatGptRestoredResult();
  pendingToolResult = null;
  if (initialResult) {
    await applyToolResult(initialResult);
  } else {
    render();
  }
}

async function applyToolResult(result: CallToolResult): Promise<void> {
  const decoded = decodeToolResult(result);
  if (decoded.kind === "card") {
    setCard(decoded.card);
    return;
  }
  if (decoded.kind === "invalid") {
    clearCard("No result card is available for this tool result.");
    return;
  }

  const reviewKey = `${decoded.workspaceId}:${decoded.reviewRef}`;
  pendingReviewKey = reviewKey;
  card = null;
  errorMessage = null;
  resetCardInteractions();
  render();

  try {
    const restored = await reopenReview(decoded.workspaceId, decoded.reviewRef);
    if (pendingReviewKey !== reviewKey) return;

    const restoredResult = decodeToolResult(restored);
    if (restoredResult.kind !== "card" || restoredResult.card.tool !== "show_changes") {
      throw new Error("The host returned an incomplete historical review.");
    }
    setCard(restoredResult.card);
  } catch (reviewError) {
    if (pendingReviewKey !== reviewKey) return;
    clearCard(
      reviewError instanceof Error
        ? reviewError.message
        : String(reviewError),
    );
  }
}

function setCard(nextCard: ToolResultCard): void {
  pendingReviewKey = null;
  card = nextCard;
  expanded = isInitiallyExpandedCard(nextCard);
  reviewFilesExpanded = false;
  openWorkspaceInstructionKey = null;
  showAvailableWorkspaceInstructions = false;
  errorMessage = null;
  render();
}

function clearCard(message: string): void {
  pendingReviewKey = null;
  card = null;
  errorMessage = message;
  resetCardInteractions();
  render();
}

function resetCardInteractions(): void {
  expanded = false;
  reviewFilesExpanded = false;
  openWorkspaceInstructionKey = null;
  showAvailableWorkspaceInstructions = false;
}

async function reopenReview(
  workspaceId: string,
  reviewRef: string,
): Promise<CallToolResult> {
  if (!app) throw new Error("The app bridge is not connected.");
  if (!app.getHostCapabilities()?.serverTools) {
    throw new Error("This host cannot reload historical review details.");
  }

  return app.callServerTool({
    name: "show_changes",
    arguments: { workspaceId },
    _meta: { "devspace/reviewRef": reviewRef },
  });
}

function chatGptRestoredResult(): CallToolResult | undefined {
  return toolResultFromChatGptGlobals(window.openai);
}

function handleChatGptGlobalsChanged(event: Event): void {
  if (!connected || card) return;

  const customEvent = event as CustomEvent<{ globals?: ChatGptToolGlobals }>;
  const restored = toolResultFromChatGptGlobals(customEvent.detail?.globals)
    ?? chatGptRestoredResult();
  if (restored) void applyToolResult(restored);
}

function applyHostContext(): void {
  if (hostContext?.theme) applyDocumentTheme(hostContext.theme);
  if (hostContext?.styles?.variables) {
    applyHostStyleVariables(hostContext.styles.variables);
  }
  if (hostContext?.styles?.css?.fonts) {
    applyHostFonts(hostContext.styles.css.fonts);
  }

  const insets = hostContext?.safeAreaInsets;
  if (!insets) return;

  document.body.style.padding = `${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px`;
}

function render(): void {
  unmountPayload();

  if (connectionError) {
    renderEmpty(connectionError, "error");
    return;
  }

  if (!connected) {
    renderEmpty("Connecting to host...");
    return;
  }

  if (!card) {
    renderEmpty(errorMessage ?? "Waiting for a tool result.", errorMessage ? "error" : "muted");
    return;
  }

  const display = cardDisplay(card);
  if (card.tool === "show_changes") {
    renderReviewCard(card, display);
    return;
  }

  const expandable = isExpandableCard(card);
  const main = element("main", { className: "shell" });
  const section = element("section", {
    className: toolCardClassName(display),
  });
  const button = element("button", {
    className: "tool-header",
    type: "button",
    ariaExpanded: String(expanded),
    disabled: !expandable,
  });

  if (expandable) {
    button.addEventListener("click", () => {
      expanded = !expanded;
      render();
    });
  }

  const icon = element("span", { className: "tool-icon", ariaHidden: "true" });
  icon.append(renderIcon(display.icon));

  const toolMain = element("span", { className: "tool-main" });
  const title = element("span", { className: "tool-title", text: display.title });
  toolMain.append(title);
  if (display.label) {
    toolMain.append(element("span", {
      className: "tool-label",
      text: display.label,
      title: display.label,
    }));
  }

  button.append(
    icon,
    toolMain,
    renderHeaderSummary(card),
    renderChevron(expanded, expandable),
  );
  section.append(button);

  if (expanded) {
    const body = element("div", { className: "tool-body" });
    currentPayloadContainer = body;
    section.append(body);
  }

  main.append(section);
  appRoot.replaceChildren(main);
  renderPayloadIfNeeded();
}

function renderEmpty(message: string, tone: "muted" | "error" = "muted"): void {
  const main = element("main", { className: "shell" });
  main.append(element("section", { className: `empty ${tone}`, text: message }));
  appRoot.replaceChildren(main);
}

async function renderPayloadIfNeeded(): Promise<void> {
  if (!card || !currentPayloadContainer || !expanded) return;

  const target = currentPayloadContainer;

  if (errorMessage) {
    renderStatus(target, errorMessage, "error");
    return;
  }

  if (card.tool === "open_workspace") {
    renderWorkspacePayload(target, card);
    return;
  }

  const visibleFileCount = !reviewFilesExpanded
    ? Math.max(3, (card.files ?? []).slice(0, 3).length)
    : undefined;

  if (currentPayload) {
    currentPayload.update({ card, hostContext, errorMessage, visibleFileCount });
    return;
  }

  renderStatus(target, "Loading review...");
  const { mountReviewPayload } = await import("./review-payload.js");
  if (target !== currentPayloadContainer || !card) return;

  currentPayload = mountReviewPayload(target, {
    card,
    hostContext,
    errorMessage,
    visibleFileCount,
  });
}

function unmountPayload(): void {
  unmountCurrentPayload();
  currentPayload = null;
  currentPayloadContainer = null;
}

function unmountCurrentPayload(): void {
  currentPayload?.unmount();
  currentPayload = null;
}

function renderStatus(
  container: HTMLElement,
  message: string,
  tone: "muted" | "error" = "muted",
): void {
  unmountCurrentPayload();
  container.replaceChildren(element("div", { className: `status ${tone}`, text: message }));
}

function renderHeaderSummary(card: ToolResultCard): HTMLElement {
  if (card.tool === "show_changes") {
    const stats = element("span", { className: "stats" });
    stats.setAttribute("aria-label", "Diff statistics");
    stats.append(
      element("span", {
        className: "add",
        text: `+${String(summaryNumber(card.summary, "additions") ?? 0)}`,
      }),
      element("span", {
        className: "remove",
        text: `-${String(summaryNumber(card.summary, "removals") ?? 0)}`,
      }),
    );
    return stats;
  }

  const parts = [
    countLabel(summaryNumber(card.summary, "agentsFiles"), "instruction"),
    countLabel(summaryNumber(card.summary, "skills"), "skill"),
  ].filter((part): part is string => Boolean(part));
  const meta = element("span", {
    className: `header-meta ${parts.length === 0 ? "empty" : ""}`,
    text: parts.join(" · "),
  });
  if (parts.length === 0) meta.setAttribute("aria-hidden", "true");
  return meta;
}

function renderReviewCard(card: ToolResultCard, display: CardDisplay): void {
  unmountPayload();

  const files = card.files ?? [];
  const visibleFiles = reviewFilesExpanded ? files : files.slice(0, 3);
  const hiddenCount = Math.max(0, files.length - visibleFiles.length);
  const expandable = isExpandableCard(card);
  const main = element("main", { className: "shell" });
  const section = element("section", { className: toolCardClassName(display) });
  const header = element("button", {
    className: "tool-header review-header",
    type: "button",
    ariaExpanded: String(expanded),
    disabled: !expandable,
  });

  if (expandable) {
    header.addEventListener("click", () => {
      expanded = !expanded;
      render();
    });
  }

  const icon = element("span", { className: "tool-icon", ariaHidden: "true" });
  icon.append(renderIcon(display.icon));
  const titleGroup = element("span", { className: "tool-main review-title-group" });

  titleGroup.append(element("span", { className: "tool-title", text: display.title }));
  if (display.label) {
    titleGroup.append(element("span", {
      className: "tool-label",
      text: display.label,
      title: display.label,
    }));
  }
  header.append(
    icon,
    titleGroup,
    renderHeaderSummary(card),
    renderChevron(expanded, expandable),
  );

  section.append(header);
  if (expanded) {
    const body = element("div", { className: "review-summary" });
    const payload = element("div", { className: "review-payload" });
    currentPayloadContainer = payload;
    body.append(payload);

    if (hiddenCount > 0) {
      const showMore = element("button", {
        className: "review-more",
        type: "button",
        text: `Show ${hiddenCount} more ${hiddenCount === 1 ? "file" : "files"}`,
      });
      showMore.addEventListener("click", () => {
        reviewFilesExpanded = true;
        render();
      });
      body.append(showMore);
    }

    section.append(body);
  }

  main.append(section);
  appRoot.replaceChildren(main);
  renderPayloadIfNeeded();
}

function renderChevron(isExpanded: boolean, visible: boolean): HTMLElement {
  const chevron = element("span", {
    className: visible ? `chevron ${isExpanded ? "expanded" : ""}` : "chevron",
    ariaHidden: "true",
  });

  if (visible) {
    chevron.append(renderIcon(toolIcons.chevronDown));
  }

  return chevron;
}

function toolCardClassName(display: CardDisplay): string {
  return `tool-card ${display.tone}`;
}

function cardDisplay(card: ToolResultCard): CardDisplay {
  if (card.tool === "open_workspace") {
    const title = card.workspaceReused === true
      ? "Reused workspace"
      : card.workspaceReused === false
        ? "Opened workspace"
        : "Workspace";
    return {
      icon: card.mode === "worktree" ? toolIcons.gitBranch : toolIcons.folderOpen,
      title,
      label: card.root ?? card.path,
      tone: "workspace",
    };
  }

  const display = getPatchDisplayParts(card, { emptyTitle: "Changes ready" });
  return {
    icon: toolIcons.diff,
    title: card.files?.length || card.payload?.patch ? display.title : "No changes",
    label: singleFilePath(card),
    tone: "review",
  };
}

function singleFilePath(card: ToolResultCard): string | undefined {
  if (card.files?.length !== 1) return undefined;
  return getFileChangePathDisplay(card.files[0])?.title ?? card.path;
}

function countLabel(count: number | undefined, noun: string): string | undefined {
  if (count === undefined) return undefined;
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function renderWorkspacePayload(container: HTMLElement, card: ToolResultCard): void {
  unmountCurrentPayload();

  const details = element("div", {
    className: "workspace-details pretty-scrollbar",
  });
  const rows = element("div", { className: "workspace-rows" });
  const worktree = card.worktree;

  if (worktree) {
    const base = [
      worktree.baseRef,
      worktree.baseSha?.slice(0, 8),
    ].filter((value): value is string => Boolean(value));
    const baseLabel = base.join(" · ") || "Worktree";
    const baseContent = element("span", { className: "workspace-base-value" });
    baseContent.append(element("span", {
      className: "workspace-value",
      text: baseLabel,
      title: baseLabel,
    }));

    if (worktree.dirtySource) {
      const warning = element("span", {
        className: "workspace-base-warning",
        title: "The source checkout had uncommitted changes when this worktree was created. Those changes are not included here.",
        ariaLabel: "Source checkout changes are not included in this worktree",
      });
      warning.append(renderIcon(toolIcons.warning, "workspace-base-warning-svg"));
      baseContent.append(warning);
    }

    appendWorkspaceRow(rows, "Base", baseContent, toolIcons.base);
  }

  if (card.sourceRoot && card.sourceRoot !== card.root) {
    appendWorkspaceTextRow(
      rows,
      "Source checkout",
      card.sourceRoot,
      toolIcons.sourceCheckout,
      true,
    );
  }

  if (card.review?.available === false) {
    appendWorkspaceTextRow(
      rows,
      "Review",
      card.review.reason,
      toolIcons.warning,
    );
  }

  appendWorkspaceInstructions(
    rows,
    card.agentsFiles ?? [],
    card.availableAgentsFiles ?? [],
  );

  const skills = card.skills ?? [];
  if (skills.length > 0) {
    appendWorkspaceSkills(rows, skills);
  }

  const providers = card.agentProviders ?? [];
  const agents = card.agents ?? [];
  const providerLogoTheme: ProviderLogoTheme = hostContext?.theme === "light"
    ? "light"
    : "dark";
  const agentChips: WorkspaceChip[] = agents.map((agent) => {
    const name = agent.name ?? "Unnamed agent";
    const providerName = agent.provider?.trim();
    const title = [
      agent.description,
      providerName ? `Provider: ${providerName}` : undefined,
      agent.model ? `Model: ${agent.model}` : undefined,
      agent.effort ? `Effort: ${agent.effort}` : undefined,
    ].filter((value): value is string => Boolean(value)).join("\n");
    return {
      label: name,
      logo: providerName
        ? getProviderLogo(providerName, providerLogoTheme)
        : undefined,
      logoProvider: providerName,
      profile: true,
      title: title || undefined,
    };
  });
  const providerChips: WorkspaceChip[] = providers.map((provider) => {
    const name = provider.id?.trim() || "Unknown provider";
    const logo = getProviderLogo(name, providerLogoTheme);
    const title = [
      provider.model ? `Model: ${provider.model}` : undefined,
      provider.effort ? `Effort: ${provider.effort}` : undefined,
      provider.note,
    ].filter((value): value is string => Boolean(value)).join("\n");
    return {
      label: name,
      logo,
      logoProvider: logo ? name : undefined,
      bareLogo: Boolean(logo),
      ariaLabel: name,
      title: title || name,
    };
  });

  if (agentChips.length > 0) {
    const chipList = renderWorkspaceChips([...agentChips, ...providerChips]);
    chipList.classList.add("workspace-agents-list");
    appendWorkspaceRow(rows, "Agents", chipList, toolIcons.agents, "workspace-agents-row");
  } else if (providerChips.length > 0) {
    appendWorkspaceChipRow(rows, "Providers", providerChips, toolIcons.providers);
  }

  if (rows.childElementCount > 0) details.append(rows);

  if (details.childElementCount === 0) {
    details.append(element("div", { className: "status muted", text: "No workspace details available." }));
  }

  container.replaceChildren(details);
}

interface WorkspaceChip {
  label: string;
  logo?: string;
  logoProvider?: string;
  profile?: boolean;
  bareLogo?: boolean;
  ariaLabel?: string;
  title?: string;
  tone?: "muted";
}

interface WorkspaceInstruction {
  key: string;
  path?: string;
  label: string;
  content?: string;
  status: "loaded" | "available";
}

function appendWorkspaceInstructions(
  container: HTMLElement,
  loadedFiles: NonNullable<ToolResultCard["agentsFiles"]>,
  availableFiles: NonNullable<ToolResultCard["availableAgentsFiles"]>,
): void {
  const loaded: WorkspaceInstruction[] = [];
  const loadedPaths = new Set<string>();
  for (const [index, file] of loadedFiles.entries()) {
    loaded.push({
      key: `loaded:${index}`,
      path: file.path,
      label: file.path ?? "Loaded instructions",
      content: file.content,
      status: "loaded",
    });
    if (file.path) loadedPaths.add(file.path);
  }

  const available: WorkspaceInstruction[] = [];
  for (const [index, file] of availableFiles.entries()) {
    if (file.path && loadedPaths.has(file.path)) continue;
    available.push({
      key: `available:${index}`,
      path: file.path,
      label: file.path ?? "Nested instructions",
      status: "available",
    });
  }
  if (loaded.length === 0 && available.length === 0) return;

  const instructions = showAvailableWorkspaceInstructions
    ? [...loaded, ...available]
    : loaded;
  const list = renderWorkspaceInstructionList(instructions);

  if (available.length > 0) {
    const showAll = showAvailableWorkspaceInstructions;
    const toggle = element("button", {
      className: "workspace-instructions-toggle",
      type: "button",
      text: showAll ? "Show less" : "View all",
      ariaLabel: showAll
        ? "Show only loaded instruction files"
        : `View all ${available.length} available instruction files`,
      ariaExpanded: String(showAll),
    });
    toggle.addEventListener("click", () => {
      showAvailableWorkspaceInstructions = !showAvailableWorkspaceInstructions;
      if (!showAvailableWorkspaceInstructions) openWorkspaceInstructionKey = null;
      render();
    });
    list.append(toggle);
  }

  const content = element("div", { className: "workspace-instructions-content" });
  content.append(list);

  appendWorkspaceRow(
    container,
    "Instructions",
    content,
    toolIcons.instructions,
    "workspace-instructions-row",
  );
}

function renderWorkspaceInstructionList(
  instructions: WorkspaceInstruction[],
): HTMLElement {
  const list = element("span", { className: "workspace-instruction-list" });

  for (const instruction of instructions) {
    const item = element("span", { className: "workspace-instruction-item" });
    item.dataset.instructionKey = instruction.key;
    const hasContent = instruction.status === "loaded" && instruction.content !== undefined;
    const header = element(hasContent ? "button" : "span", {
      className: `workspace-instruction-header${hasContent ? " interactive" : ""}`,
      type: hasContent ? "button" : undefined,
      ariaLabel: hasContent ? `View ${instruction.label}` : undefined,
      ariaExpanded: hasContent ? "false" : undefined,
    });
    const text = element("span", { className: "workspace-instruction-text" });
    const basename = workspacePathBasename(instruction.label);
    text.append(element("span", {
      className: "workspace-instruction-name",
      text: basename,
    }));
    if (instruction.path && instruction.path !== basename) {
      text.append(element("span", {
        className: "workspace-instruction-path",
        text: instruction.path,
        title: instruction.path,
      }));
    }

    header.append(
      renderWorkspaceInstructionStatus(instruction.status),
      text,
    );

    if (hasContent) {
      const chevron = element("span", {
        className: "workspace-instruction-chevron",
        ariaHidden: "true",
      });
      chevron.append(renderIcon(toolIcons.chevronDown, "workspace-instruction-chevron-svg"));
      header.append(chevron);
      header.addEventListener("click", () => {
        openWorkspaceInstructionKey = openWorkspaceInstructionKey === instruction.key
          ? null
          : instruction.key;
        syncWorkspaceInstructionPreviews(list);
      });

      const preview = element("pre", {
        className: "workspace-instruction-preview pretty-scrollbar",
        text: instruction.content,
      });
      preview.hidden = true;
      item.append(header, preview);
    } else {
      item.append(header);
    }

    list.append(item);
  }

  syncWorkspaceInstructionPreviews(list);
  return list;
}

function syncWorkspaceInstructionPreviews(list: HTMLElement): void {
  for (const item of list.querySelectorAll<HTMLElement>(".workspace-instruction-item")) {
    const isOpen = item.dataset.instructionKey === openWorkspaceInstructionKey;
    item.classList.toggle("expanded", isOpen);
    const header = item.querySelector<HTMLElement>(".workspace-instruction-header.interactive");
    header?.setAttribute("aria-expanded", String(isOpen));
    const preview = item.querySelector<HTMLElement>(".workspace-instruction-preview");
    if (preview) preview.hidden = !isOpen;
  }
}

function renderWorkspaceInstructionStatus(
  status: WorkspaceInstruction["status"],
): HTMLElement {
  const label = instructionStatusLabel(status);
  const wrapper = element("span", {
    className: `workspace-instruction-status ${status}`,
    title: label,
    ariaLabel: label,
  });
  wrapper.setAttribute("role", "img");
  wrapper.append(renderIcon(
    status === "loaded" ? toolIcons.instructionLoaded : toolIcons.instructionAvailable,
    "workspace-instruction-status-svg",
  ));
  return wrapper;
}

function instructionStatusLabel(status: WorkspaceInstruction["status"]): string {
  return status === "loaded"
    ? "Loaded into the current workspace context"
    : "Available for a nested directory";
}

function workspacePathBasename(path: string): string {
  const parts = path.replaceAll("\\", "/").split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

function appendWorkspaceTextRow(
  container: HTMLElement,
  label: string,
  value: string,
  icon: ToolIcon,
  mono = false,
): void {
  const content = element("span", {
    className: `workspace-value${mono ? " mono" : ""}`,
    text: value,
    title: value,
  });
  appendWorkspaceRow(container, label, content, icon);
}

function appendWorkspaceChipRow(
  container: HTMLElement,
  label: string,
  chips: WorkspaceChip[],
  icon: ToolIcon,
): void {
  appendWorkspaceRow(container, label, renderWorkspaceChips(chips), icon);
}

function appendWorkspaceRow(
  container: HTMLElement,
  label: string,
  content: HTMLElement,
  icon: ToolIcon,
  rowClassName?: string,
): void {
  const row = element("div", {
    className: ["workspace-row", rowClassName].filter(Boolean).join(" "),
  });
  row.append(
    renderWorkspaceRowIcon(icon),
    element("span", { className: "workspace-key", text: label }),
    content,
  );
  container.append(row);
}

function appendWorkspaceSkills(
  container: HTMLElement,
  skills: NonNullable<ToolResultCard["skills"]>,
): void {
  const skillChips = skills.map((skill) => ({
    label: skill.name ?? skill.path ?? "Unnamed skill",
    title: [skill.path, skill.description].filter(Boolean).join("\n\n") || undefined,
  }));

  const chipList = renderWorkspaceChips(skillChips);
  chipList.classList.add("workspace-skills-list");
  appendWorkspaceRow(container, "Skills", chipList, toolIcons.skills, "workspace-skills-row");
}

function renderWorkspaceRowIcon(icon: ToolIcon): HTMLElement {
  const wrapper = element("span", {
    className: "workspace-row-icon",
    ariaHidden: "true",
  });
  wrapper.append(renderIcon(icon, "workspace-row-icon-svg"));
  return wrapper;
}

function renderWorkspaceChips(chips: WorkspaceChip[]): HTMLElement {
  const list = element("span", { className: "workspace-chip-list" });
  for (const chip of chips) {
    const bareLogo = Boolean(chip.bareLogo && chip.logo);
    const item = element("span", {
      className: [
        bareLogo
          ? "workspace-provider-logo"
          : chip.profile
          ? "workspace-agent-profile"
          : "workspace-chip",
        chip.tone,
      ].filter(Boolean).join(" "),
      title: chip.title,
    });
    if (bareLogo) {
      item.setAttribute("role", "img");
      item.setAttribute("aria-label", chip.ariaLabel ?? chip.label);
    }
    if (chip.logo) {
      const logo = document.createElement("img");
      logo.className = bareLogo
        ? "workspace-provider-logo-image"
        : chip.profile
        ? "workspace-agent-profile-logo"
        : "workspace-chip-logo";
      logo.src = chip.logo;
      if (chip.logoProvider) logo.dataset.provider = chip.logoProvider;
      logo.alt = "";
      logo.setAttribute("aria-hidden", "true");
      item.append(logo);
    }
    if (!bareLogo) {
      item.append(element("span", { className: "workspace-chip-label", text: chip.label }));
    }
    list.append(item);
  }
  return list;
}

function syncWorkspaceProviderLogos(theme: ProviderLogoTheme): void {
  for (const logo of document.querySelectorAll<HTMLImageElement>("img[data-provider]")) {
    const providerName = logo.dataset.provider;
    if (!providerName) continue;
    const src = getProviderLogo(providerName, theme);
    if (src && logo.src !== src) logo.src = src;
  }
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: {
    className?: string;
    text?: string;
    type?: string;
    title?: string;
    ariaHidden?: string;
    ariaLabel?: string;
    ariaExpanded?: string;
    disabled?: boolean;
  } = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.type !== undefined && "type" in node) node.setAttribute("type", options.type);
  if (options.title !== undefined) node.title = options.title;
  if (options.ariaHidden !== undefined) node.setAttribute("aria-hidden", options.ariaHidden);
  if (options.ariaLabel !== undefined) node.setAttribute("aria-label", options.ariaLabel);
  if (options.ariaExpanded !== undefined) node.setAttribute("aria-expanded", options.ariaExpanded);
  if (options.disabled !== undefined && "disabled" in node) {
    (node as HTMLButtonElement).disabled = options.disabled;
  }
  return node;
}
