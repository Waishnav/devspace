import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Check, CircleDot, Code2, GitBranch, GitMerge, KeyRound, LoaderCircle, ShieldCheck, Terminal, TriangleAlert } from "lucide-react";
import type { Task } from "../src/domain.js";
import { endpoints } from "./api.js";
import type { Project, ProposalDiff } from "../src/domain.js";
import type { ProposalResponse } from "./api.js";
import type { Dispatch, SetStateAction } from "react";

const field = "w-full rounded-xl border border-edge bg-[#121618] px-4 py-3 text-sm text-white placeholder:text-[#647078] transition-colors";
const primary = "inline-flex items-center justify-center gap-2 rounded-xl bg-accent px-5 py-3 text-sm font-semibold text-[#112118] transition hover:bg-[#d1ffd3] disabled:opacity-40";

function Status({ status }: { status: Task["status"] }) {
  const ready = status === "completed";
  const failed = status === "failed";
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${ready ? "text-accent" : failed ? "text-rose-300" : "text-muted"}`}>
      {status === "running" ? <LoaderCircle className="size-3.5 animate-spin" /> : <CircleDot className="size-3.5" />}
      {status === "queued" ? "Queued" : ready ? "Ready for review" : failed ? "Failed" : "Working"}
    </span>
  );
}

function ErrorLine({ error }: { error: unknown }) {
  if (!error) return null;
  return <p role="alert" className="mt-3 flex items-start gap-2 text-sm text-rose-300"><TriangleAlert className="mt-0.5 size-4 shrink-0" />{error instanceof Error ? error.message : String(error)}</p>;
}

function TaskPanel({ task, selected, select }: { task: Task; selected: boolean; select: () => void }) {
  return (
    <button onClick={select} type="button" aria-pressed={selected} className={`w-full rounded-2xl border p-5 text-left transition ${selected ? "border-accent/60 bg-[#1d2823]" : "border-edge bg-panel hover:border-[#515a60]"}`}>
      <div className="mb-5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium tracking-wide text-muted"><GitBranch className="size-4" />{task.forkRepo}</div>
        {selected && <Check className="size-4 text-accent" />}
      </div>
      <p className="line-clamp-3 min-h-16 text-sm leading-6 text-[#e7efeb]">{task.prompt}</p>
      <div className="mt-4 flex items-center justify-between gap-2 border-t border-edge/70 pt-4">
        <Status status={task.status} />
        <span className="font-mono text-[11px] text-muted">{task.headCommit?.slice(0, 7) ?? "—"}</span>
      </div>
      {task.integrationStatus && <p className="mt-3 text-xs text-accent">Integration: {task.integrationStatus}</p>}
      {task.error && <p className="mt-3 text-xs text-rose-300">{task.error}</p>}
    </button>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const [token, setToken] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");
  const [projectId, setProjectId] = useState(() => new URLSearchParams(location.search).get("project") ?? "");
  const [sourceUrl, setSourceUrl] = useState("");
  const [prompts, setPrompts] = useState<[string, string]>(["", ""]);
  const [selectedId, setSelectedId] = useState("");

  const enabled = Boolean(token && projectId);
  const project = useQuery({ queryKey: ["project", projectId, token], queryFn: () => endpoints.project(token, projectId), enabled });
  const tasks = useQuery({
    queryKey: ["tasks", projectId, token], queryFn: () => endpoints.tasks(token, projectId),
    enabled, refetchInterval: (query) => query.state.data?.tasks.some((t) => t.status === "queued" || t.status === "running") ? 2500 : false,
  });
  const taskList = Array.isArray(tasks.data?.tasks) ? tasks.data.tasks : [];
  const proposals = useQuery({
    queryKey: ["proposals", projectId, token, taskList.map((t) => `${t.id}:${t.status}`).join("|")],
    queryFn: () => endpoints.proposals(token, projectId),
    enabled: enabled && taskList.some((t) => t.status === "completed"),
  });
  const selected = taskList.find((t) => t.id === selectedId) ?? taskList[0];
  const selectedDiff = proposals.data?.proposals.find(({ task }) => task.id === selected?.id)?.diff;

  const createProject = useMutation({
    mutationFn: () => endpoints.createProject(token, sourceUrl),
    onSuccess: (created) => {
      setProjectId(created.id);
      history.replaceState(null, "", `?project=${created.id}`);
      void queryClient.invalidateQueries();
    },
  });
  const compare = useMutation({
    mutationFn: () => endpoints.compare(token, projectId, prompts),
    onSuccess: (result) => {
      setSelectedId(result.tasks[0].id);
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
  const accept = useMutation({
    mutationFn: (taskId: string) => endpoints.accept(token, projectId, taskId),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["tasks"] }),
  });

  return (
    <div className="min-h-screen bg-canvas">
      <header className="border-b border-edge/80">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5 lg:px-10">
          <div className="flex items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-lg bg-accent text-[#102015]"><Terminal className="size-5" strokeWidth={2.4} /></span>
            <div><div className="text-sm font-semibold tracking-tight">DevSpace <span className="font-normal text-muted">/ Agent Changes</span></div><div className="mt-0.5 text-[10px] uppercase tracking-[.18em] text-muted">Cloudflare Artifacts experiment</div></div>
          </div>
          <span className="inline-flex items-center gap-2 rounded-full border border-edge px-3 py-1.5 text-xs text-muted"><span className="size-1.5 rounded-full bg-accent" />Hackathon V0</span>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-6 pb-24 pt-12 lg:px-10">
        <div className="mb-12 max-w-2xl">
          <div className="mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-[.22em] text-accent"><GitMerge className="size-4" /> Parallel development</div>
          <h1 className="text-4xl font-semibold leading-[1.12] tracking-[-.045em] sm:text-5xl">Two agents. Independent changes. <span className="text-muted">Your decision.</span></h1>
          <p className="mt-5 max-w-xl text-base leading-7 text-muted">Run competing coding proposals against the same Git baseline. Review what actually changed, then accept the implementation you want.</p>
        </div>

        {!token ? (
          <section className="max-w-lg rounded-2xl border border-edge bg-panel p-7">
            <KeyRound className="mb-5 size-6 text-accent" />
            <h2 className="text-xl font-semibold">Unlock your workspace</h2>
            <p className="mb-5 mt-2 text-sm leading-6 text-muted">Enter the demo access token configured on the Worker. It is kept only in page memory and cleared on refresh.</p>
            <form onSubmit={(event) => { event.preventDefault(); setToken(tokenDraft); setTokenDraft(""); }} className="flex gap-2">
              <input type="password" aria-label="Demo access token" value={tokenDraft} onChange={(event) => setTokenDraft(event.target.value)} placeholder="Access token" className={field} required />
              <button className={primary} type="submit">Enter <ArrowRight className="size-4" /></button>
            </form>
          </section>
        ) : !projectId ? (
          <section className="max-w-2xl border-t border-edge pt-8">
            <div className="mb-5 flex items-center gap-3"><span className="font-mono text-sm text-accent">01</span><h2 className="text-xl font-semibold">Connect a repository</h2></div>
            <p className="mb-5 text-sm text-muted">Import a small public GitHub repository into Cloudflare Artifacts. Every agent receives an isolated fork.</p>
            <form onSubmit={(event) => { event.preventDefault(); createProject.mutate(); }} className="flex flex-col gap-3 sm:flex-row">
              <input aria-label="GitHub repository URL" type="url" value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://github.com/owner/repo" className={`${field} flex-1`} required />
              <button className={primary} disabled={createProject.isPending} type="submit">{createProject.isPending ? "Importing…" : "Import repository"}<ArrowRight className="size-4" /></button>
            </form>
            <ErrorLine error={createProject.error} />
          </section>
        ) : (
          <WorkspaceView {...{ project, tasks, taskList, prompts, setPrompts, compare, proposals, selected, selectedDiff, setSelectedId, accept }} />
        )}
      </main>
    </div>
  );
}

interface WorkspaceProps {
  project: { data?: Project; error: Error | null; isLoading: boolean };
  tasks: { error: Error | null; isLoading: boolean };
  taskList: Task[];
  prompts: [string, string];
  setPrompts: Dispatch<SetStateAction<[string, string]>>;
  compare: { mutate: () => void; isPending: boolean; error: Error | null };
  proposals: { data?: ProposalResponse; isLoading: boolean; error: Error | null };
  selected?: Task;
  selectedDiff?: ProposalDiff | null;
  setSelectedId: (id: string) => void;
  accept: {
    mutate: (taskId: string) => void;
    isPending: boolean;
    error: Error | null;
    data?: { status: "merged" | "conflicted"; commit?: string };
  };
}

function WorkspaceView(props: WorkspaceProps) {
  const { project, tasks, taskList, prompts, setPrompts, compare, proposals, selected, selectedDiff, setSelectedId, accept } = props;
  const hasStarted = taskList.length > 0;
  return (
    <div className="grid gap-12 lg:grid-cols-[minmax(0,.9fr)_minmax(0,1.1fr)] lg:gap-16">
      <div className="min-w-0">
        <div className="mb-8 flex items-start justify-between border-t border-edge pt-6">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-widest text-muted">Source repository</p>
            <div className="mt-3 flex items-center gap-2 text-sm text-white"><GitBranch className="size-4 text-accent" />{project.data?.sourceUrl?.replace("https://github.com/", "") ?? "Loading…"}</div>
            <p className="mt-1 pl-6 font-mono text-xs text-muted">{project.data?.defaultBranch ?? ""}</p>
          </div>
          <span className="rounded-full border border-[#365442] px-3 py-1.5 text-xs text-accent">Artifacts</span>
        </div>
        <ErrorLine error={project.error ?? tasks.error} />

        <div className="mb-5 flex items-center gap-3"><span className="font-mono text-sm text-accent">02</span><h2 className="text-xl font-semibold">Parallel work</h2></div>
        {!hasStarted ? (
          <form onSubmit={(event) => { event.preventDefault(); compare.mutate(); }} className="space-y-4">
            {prompts.map((prompt, index) => (
              <div key={index}>
                <label htmlFor={`prompt-${index}`} className="mb-2 block text-xs font-medium text-muted">Agent {index === 0 ? "A" : "B"} · Brief</label>
                <textarea id={`prompt-${index}`} rows={4} maxLength={2000} required className={`${field} resize-y leading-6`} value={prompt} placeholder={index === 0 ? "Describe the first implementation approach…" : "Describe a competing implementation approach…"} onChange={(event) => setPrompts((old) => old.map((p, i) => i === index ? event.target.value : p) as [string, string])} />
              </div>
            ))}
            <button className={primary} disabled={compare.isPending || !prompts.every((p) => p.trim())} type="submit"><Code2 className="size-4" />{compare.isPending ? "Preparing forks…" : "Launch both agents"}<ArrowRight className="size-4" /></button>
            <ErrorLine error={compare.error} />
            <p className="text-xs leading-5 text-muted">Runs are limited to two agents. Each receives its own repository fork and durable workspace.</p>
          </form>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {taskList.map((task) => <TaskPanel key={task.id} task={task} selected={selected?.id === task.id} select={() => setSelectedId(task.id)} />)}
          </div>
        )}
        {(tasks.isLoading || project.isLoading) && <p className="mt-5 text-sm text-muted">Loading project…</p>}
      </div>

      <section className="min-w-0 border-t border-edge pt-6">
        <div className="mb-7 flex items-center justify-between">
          <div className="flex items-center gap-3"><span className="font-mono text-sm text-accent">03</span><h2 className="text-xl font-semibold">Review changes</h2></div>
          <span className="text-xs text-muted">Human approval required</span>
        </div>

        {proposals.data?.overlappingFiles.length ? (
          <div className="mb-5 rounded-xl border border-amber-300/25 bg-amber-300/5 px-4 py-3">
            <div className="flex items-center gap-2 text-xs font-medium text-amber-200"><TriangleAlert className="size-4" />{proposals.data.overlappingFiles.length} overlapping file(s)</div>
            <p className="mt-2 break-words font-mono text-xs text-muted">{proposals.data.overlappingFiles.join(", ")}</p>
            <p className="mt-2 text-xs text-muted">Overlap is a review warning, not proof of a merge conflict.</p>
          </div>
        ) : null}

        {!selected ? (
          <div className="flex min-h-72 flex-col items-center justify-center rounded-2xl border border-dashed border-edge px-6 text-center"><GitMerge className="mb-4 size-8 text-muted" /><p className="text-sm font-medium">No proposals yet</p><p className="mt-2 max-w-xs text-xs leading-6 text-muted">Start two agents to see their independent Git changes here.</p></div>
        ) : selected.status !== "completed" ? (
          <div className="flex min-h-72 flex-col items-center justify-center rounded-2xl border border-dashed border-edge px-6 text-center"><LoaderCircle className={`mb-4 size-8 text-muted ${selected.status === "running" ? "animate-spin" : ""}`} /><p className="text-sm font-medium">{selected.status === "failed" ? "This run failed" : "Awaiting a proposal"}</p><p className="mt-2 text-xs text-muted">{selected.error ?? "Agent changes appear after the run publishes a commit."}</p></div>
        ) : (
          <>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <div><p className="text-sm font-medium">Proposal {selected.id.slice(0, 7)}</p><p className="mt-1 text-xs text-muted">{selectedDiff?.files.length ?? 0} changed files · automated tests not recorded</p></div>
              {selected.integrationStatus === "merged" ? <span className="flex items-center gap-2 text-xs text-accent"><ShieldCheck className="size-4" />Merged</span> :
                <button className={primary} disabled={accept.isPending || Boolean(selected.integrationStatus)} onClick={() => accept.mutate(selected.id)}><GitMerge className="size-4" />{accept.isPending ? "Integrating…" : "Accept proposal"}</button>}
            </div>
            <ErrorLine error={proposals.error ?? accept.error} />
            {selected.integrationStatus === "conflicted" && <p className="mb-3 text-sm text-amber-200">Git reported a merge conflict. No changes were pushed to the base repository.</p>}
            {proposals.isLoading && <p className="text-sm text-muted">Loading Git diff…</p>}
            <div className="overflow-hidden rounded-xl border border-edge bg-[#0b0e10]">
              <div className="flex items-center gap-2 border-b border-edge bg-panel px-4 py-3 text-xs text-muted"><Code2 className="size-4" />Git diff · base → agent</div>
              <pre className="max-h-[500px] overflow-auto p-4 font-mono text-[11px] leading-[1.65] sm:text-xs"><code>{selectedDiff?.patch ? selectedDiff.patch.split("\n").map((line, index) => <span key={index} className={`block whitespace-pre ${line.startsWith("+") ? "text-[#91d6a0]" : line.startsWith("-") ? "text-[#e3a199]" : line.startsWith("@@") ? "text-[#abc5ec]" : "text-[#b0b8bb]"}`}>{line}{"\n"}</span>) : <span className="text-muted">No patch available.</span>}</code></pre>
            </div>
            {selectedDiff?.truncated && <p className="mt-2 text-xs text-amber-200">Diff preview truncated at 32 KB.</p>}
            {selected.result && <div className="mt-6"><p className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted">Agent summary</p><p className="whitespace-pre-wrap text-sm leading-6 text-[#cbd3d0]">{selected.result}</p></div>}
          </>
        )}
        <div className="mt-7 flex items-center gap-2 text-xs leading-5 text-muted"><ShieldCheck className="size-4 shrink-0 text-accent" /> Changes are only integrated after you accept a proposal.</div>
      </section>
    </div>
  );
}
