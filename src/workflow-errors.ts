import { TaggedError } from "better-result";
import {
  isAgentProviderError,
  ProviderExecutionError,
  ProviderUnavailableError,
  type AgentProviderError,
} from "./local-agent-errors.js";
import type {
  WorkflowErrorKind,
  WorkflowRunStatus,
} from "./workflow-types.js";

export class InvalidWorkflowInputError extends TaggedError(
  "InvalidWorkflowInputError",
)<{
  code: "ambiguous_source" | "missing_source" | "invalid_name" | "invalid_argument";
  message: string;
}>() {}

export class WorkflowFileNotFoundError extends TaggedError(
  "WorkflowFileNotFoundError",
)<{
  path: string;
  message: string;
}>() {
  constructor(path: string) {
    super({ path, message: `Script file not found: ${path}` });
  }
}

export class WorkflowFileReadError extends TaggedError(
  "WorkflowFileReadError",
)<{
  path: string;
  cause: unknown;
  message: string;
}>() {
  constructor(path: string, cause: unknown) {
    super({
      path,
      cause,
      message: `Unable to read workflow script ${path}: ${errorMessage(cause)}`,
    });
  }
}

export class WorkflowFileWriteError extends TaggedError(
  "WorkflowFileWriteError",
)<{
  path: string;
  cause: unknown;
  message: string;
}>() {
  constructor(path: string, cause: unknown) {
    super({
      path,
      cause,
      message: `Unable to persist workflow script ${path}: ${errorMessage(cause)}`,
    });
  }
}

export class NamedWorkflowNotFoundError extends TaggedError(
  "NamedWorkflowNotFoundError",
)<{
  name: string;
  candidates: string[];
  message: string;
}>() {
  constructor(name: string, candidates: string[]) {
    super({
      name,
      candidates,
      message: `Named workflow not found: ${name}. Looked in ${candidates.join(", ")}`,
    });
  }
}

export class WorkflowNotFoundError extends TaggedError(
  "WorkflowNotFoundError",
)<{
  runId: string;
  message: string;
}>() {
  constructor(runId: string) {
    super({ runId, message: `Unknown workflow run: ${runId}` });
  }
}

export class InvalidRunTransitionError extends TaggedError(
  "InvalidRunTransitionError",
)<{
  runId: string;
  from: WorkflowRunStatus;
  operation: "claim" | "complete" | "fail" | "cancel" | "set_script_path";
  message: string;
}>() {
  constructor(input: {
    runId: string;
    from: WorkflowRunStatus;
    operation: "claim" | "complete" | "fail" | "cancel" | "set_script_path";
  }) {
    super({
      ...input,
      message: `Cannot ${input.operation} workflow run ${input.runId} in status ${input.from}`,
    });
  }
}

export class WorkflowStoreError extends TaggedError(
  "WorkflowStoreError",
)<{
  operation: string;
  cause: unknown;
  message: string;
}>() {
  constructor(operation: string, cause: unknown) {
    super({
      operation,
      cause,
      message: `Workflow store ${operation} failed: ${errorMessage(cause)}`,
    });
  }
}

export class WorkflowStoredDataError extends TaggedError(
  "WorkflowStoredDataError",
)<{
  record: string;
  cause: unknown;
  message: string;
}>() {
  constructor(record: string, cause: unknown) {
    super({
      record,
      cause,
      message: `Stored workflow data is invalid (${record}): ${errorMessage(cause)}`,
    });
  }
}

export class WorktreeOperationError extends TaggedError(
  "WorktreeOperationError",
)<{
  operation: "create" | "inspect" | "finalize" | "remove";
  runId?: string;
  callIndex?: number;
  path?: string;
  cause: unknown;
  message: string;
}>() {
  constructor(input: {
    operation: "create" | "inspect" | "finalize" | "remove";
    runId?: string;
    callIndex?: number;
    path?: string;
    cause: unknown;
  }) {
    super({
      ...input,
      message: `Workflow worktree ${input.operation} failed${input.path ? ` at ${input.path}` : ""}: ${errorMessage(input.cause)}`,
    });
  }
}

export interface SchemaIssue {
  path: string;
  message: string;
}

export class InvalidAgentJsonError extends TaggedError(
  "InvalidAgentJsonError",
)<{
  attempt: number;
  mode: "native" | "prompt";
  responseExcerpt: string;
  message: string;
}>() {
  constructor(input: {
    attempt: number;
    mode: "native" | "prompt";
    responseExcerpt: string;
  }) {
    super({
      ...input,
      message: `Agent response was not valid JSON on attempt ${input.attempt}`,
    });
  }
}

export class AgentSchemaValidationError extends TaggedError(
  "AgentSchemaValidationError",
)<{
  attempt: number;
  mode: "native" | "prompt";
  issues: SchemaIssue[];
  message: string;
}>() {
  constructor(input: {
    attempt: number;
    mode: "native" | "prompt";
    issues: SchemaIssue[];
  }) {
    super({
      ...input,
      message: `Agent response failed schema validation on attempt ${input.attempt}: ${input.issues.map((issue) => `${issue.path} ${issue.message}`).join("; ")}`,
    });
  }
}

export class SchemaConfigurationError extends TaggedError(
  "SchemaConfigurationError",
)<{
  cause: unknown;
  message: string;
}>() {
  constructor(cause: unknown) {
    super({
      cause,
      message: `Unable to compile agent JSON Schema: ${errorMessage(cause)}`,
    });
  }
}

export type SchemaAttemptError = InvalidAgentJsonError | AgentSchemaValidationError;

export class SchemaRetriesExhaustedError extends TaggedError(
  "SchemaRetriesExhaustedError",
)<{
  attempts: number;
  lastFailure: SchemaAttemptError;
  message: string;
}>() {
  constructor(attempts: number, lastFailure: SchemaAttemptError) {
    super({
      attempts,
      lastFailure,
      message: `Schema validation failed after ${attempts} attempts: ${lastFailure.message}`,
    });
  }
}

export type WorkflowOperationError =
  | InvalidWorkflowInputError
  | WorkflowFileNotFoundError
  | WorkflowFileReadError
  | WorkflowFileWriteError
  | NamedWorkflowNotFoundError
  | WorkflowNotFoundError
  | InvalidRunTransitionError
  | WorkflowStoreError
  | WorkflowStoredDataError
  | WorktreeOperationError
  | InvalidAgentJsonError
  | AgentSchemaValidationError
  | SchemaConfigurationError
  | SchemaRetriesExhaustedError
  | AgentProviderError;

export function isWorkflowOperationError(error: unknown): error is WorkflowOperationError {
  return (
    InvalidWorkflowInputError.is(error) ||
    WorkflowFileNotFoundError.is(error) ||
    WorkflowFileReadError.is(error) ||
    WorkflowFileWriteError.is(error) ||
    NamedWorkflowNotFoundError.is(error) ||
    WorkflowNotFoundError.is(error) ||
    InvalidRunTransitionError.is(error) ||
    WorkflowStoreError.is(error) ||
    WorkflowStoredDataError.is(error) ||
    WorktreeOperationError.is(error) ||
    InvalidAgentJsonError.is(error) ||
    AgentSchemaValidationError.is(error) ||
    SchemaConfigurationError.is(error) ||
    SchemaRetriesExhaustedError.is(error) ||
    isAgentProviderError(error)
  );
}

export function workflowErrorKind(error: WorkflowOperationError): WorkflowErrorKind {
  switch (error._tag) {
    case "InvalidWorkflowInputError":
    case "WorkflowFileNotFoundError":
    case "WorkflowFileReadError":
    case "WorkflowFileWriteError":
    case "NamedWorkflowNotFoundError":
      return "path";
    case "WorkflowNotFoundError":
    case "InvalidRunTransitionError":
    case "WorkflowStoreError":
    case "WorkflowStoredDataError":
      return "internal";
    case "WorktreeOperationError":
      return "worktree";
    case "InvalidAgentJsonError":
    case "AgentSchemaValidationError":
    case "SchemaConfigurationError":
    case "SchemaRetriesExhaustedError":
    case "ProviderSchemaUnsupportedError":
      return "schema";
    case "ProviderCancelledError":
      return "cancelled";
    case "ProviderUnavailableError":
      return "provider_unavailable";
    case "ProviderExecutionError":
      return "provider";
  }
}

export function workflowCliExitCode(error: WorkflowOperationError): number {
  switch (error._tag) {
    case "InvalidWorkflowInputError":
      return 2;
    case "WorkflowFileNotFoundError":
    case "NamedWorkflowNotFoundError":
    case "WorkflowNotFoundError":
      return 3;
    case "ProviderUnavailableError":
      return 4;
    case "ProviderCancelledError":
      return 130;
    case "InvalidAgentJsonError":
    case "AgentSchemaValidationError":
    case "SchemaConfigurationError":
    case "SchemaRetriesExhaustedError":
    case "ProviderSchemaUnsupportedError":
      return 5;
    case "WorkflowFileReadError":
    case "WorkflowFileWriteError":
    case "InvalidRunTransitionError":
    case "WorkflowStoreError":
    case "WorkflowStoredDataError":
    case "WorktreeOperationError":
    case "ProviderExecutionError":
      return 1;
  }
}

export function serializeWorkflowError(error: WorkflowOperationError): {
  code: WorkflowOperationError["_tag"];
  message: string;
  kind: WorkflowErrorKind;
  retryable: boolean;
} {
  return {
    code: error._tag,
    message: error.message,
    kind: workflowErrorKind(error),
    retryable:
      ProviderExecutionError.is(error) ? error.retryable : ProviderUnavailableError.is(error),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
