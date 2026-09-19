import ts from "typescript";
import { validateWorkflowMeta } from "./workflow-schema.js";
import type { JsonValue, ParsedWorkflowScript, WorkflowLocation } from "./workflow-types.js";

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export class WorkflowScriptError extends Error {
  readonly code: "WORKFLOW_SOURCE_INVALID" | "WORKFLOW_SYNTAX_ERROR" | "WORKFLOW_META_INVALID";
  readonly location?: WorkflowLocation;

  constructor(code: WorkflowScriptError["code"], message: string, location?: WorkflowLocation) {
    super(message);
    this.name = "WorkflowScriptError";
    this.code = code;
    this.location = location;
  }
}

export function parseWorkflowScript(
  source: string,
  options: { filename?: string; maxBytes?: number } = {},
): ParsedWorkflowScript {
  const filename = options.filename ?? "workflow.js";
  const sourceBytes = Buffer.byteLength(source, "utf8");
  if (sourceBytes > (options.maxBytes ?? 256 * 1024)) {
    throw new WorkflowScriptError("WORKFLOW_SOURCE_INVALID", "Workflow script exceeds the source size limit.");
  }

  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const compilerOptions: ts.CompilerOptions = {
    allowJs: true,
    noEmit: true,
    noLib: true,
    noResolve: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
  };
  const host = ts.createCompilerHost(compilerOptions);
  host.getSourceFile = (requested) => requested === filename ? file : undefined;
  host.fileExists = (requested) => requested === filename;
  host.readFile = (requested) => requested === filename ? source : undefined;
  host.writeFile = () => undefined;
  const diagnostic = ts.createProgram([filename], compilerOptions, host).getSyntacticDiagnostics(file)[0];
  if (diagnostic) {
    const start = diagnostic.start ?? 0;
    throw new WorkflowScriptError(
      "WORKFLOW_SYNTAX_ERROR",
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      locationAt(file, start),
    );
  }

  const first = file.statements[0];
  if (!first || !ts.isVariableStatement(first)
    || !hasModifier(first, ts.SyntaxKind.ExportKeyword)
    || !hasModifier(first, ts.SyntaxKind.ConstKeyword)
    || first.declarationList.declarations.length !== 1) {
    throw metaError(file, first, "The first statement must be `export const meta = { ... }`.");
  }
  const declaration = first.declarationList.declarations[0]!;
  if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "meta" || !declaration.initializer) {
    throw metaError(file, declaration, "The first statement must declare `meta`.");
  }

  let decoded: JsonValue;
  try {
    decoded = decodeLiteral(file, declaration.initializer);
  } catch (error) {
    if (error instanceof WorkflowScriptError) throw error;
    throw metaError(file, declaration.initializer, error instanceof Error ? error.message : String(error));
  }

  let meta;
  try {
    meta = validateWorkflowMeta(decoded);
  } catch (error) {
    throw metaError(file, declaration.initializer, error instanceof Error ? error.message : String(error));
  }

  for (const statement of file.statements.slice(1)) {
    if (ts.isImportDeclaration(statement) || ts.isImportEqualsDeclaration(statement)
      || ts.isExportAssignment(statement) || hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
      throw new WorkflowScriptError(
        "WORKFLOW_SOURCE_INVALID",
        "Workflow scripts cannot contain imports or additional exports.",
        locationAt(file, statement.getStart(file)),
      );
    }
  }
  visit(file, (node) => {
    if (node.kind === ts.SyntaxKind.ImportKeyword || ts.isImportTypeNode(node)) {
      throw new WorkflowScriptError(
        "WORKFLOW_SOURCE_INVALID",
        "Workflow scripts cannot import modules.",
        locationAt(file, node.getStart(file)),
      );
    }
  });

  return {
    source,
    body: blankRange(source, first.getStart(file), first.end),
    meta,
    filename,
    sourceBytes,
  };
}

export function renameWorkflowMeta(source: string, newName: string, filename = "workflow.js"): string {
  parseWorkflowScript(source, { filename });
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(newName) || newName.length > 128) {
    throw new WorkflowScriptError("WORKFLOW_META_INVALID", "Workflow name must be a 1..128 character kebab-case name.");
  }
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const statement = file.statements[0] as ts.VariableStatement;
  let initializer = statement.declarationList.declarations[0]!.initializer!;
  while (ts.isParenthesizedExpression(initializer)) initializer = initializer.expression;
  if (!ts.isObjectLiteralExpression(initializer)) {
    throw new WorkflowScriptError("WORKFLOW_META_INVALID", "Workflow metadata must be an object literal.");
  }
  const property = initializer.properties.find((candidate) =>
    ts.isPropertyAssignment(candidate) && propertyName(file, candidate.name) === "name");
  if (!property || !ts.isPropertyAssignment(property)) {
    throw new WorkflowScriptError("WORKFLOW_META_INVALID", "Workflow metadata must contain a name property.");
  }
  const renamed = source.slice(0, property.initializer.getStart(file))
    + JSON.stringify(newName)
    + source.slice(property.initializer.end);
  parseWorkflowScript(renamed, { filename });
  return renamed;
}

function decodeLiteral(file: ts.SourceFile, node: ts.Expression): JsonValue {
  if (ts.isParenthesizedExpression(node)) return decodeLiteral(file, node.expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isNumericLiteral(node)) {
    const value = Number(node.text);
    if (!Number.isFinite(value)) throw metaError(file, node, "Metadata numbers must be finite.");
    return value;
  }
  if (ts.isPrefixUnaryExpression(node)
    && (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken)
    && ts.isNumericLiteral(node.operand)) {
    const value = Number(`${node.operator === ts.SyntaxKind.MinusToken ? "-" : ""}${node.operand.text}`);
    if (!Number.isFinite(value)) throw metaError(file, node, "Metadata numbers must be finite.");
    return value;
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) {
    if (node.elements.some(ts.isSpreadElement)) throw metaError(file, node, "Metadata arrays cannot contain spreads.");
    return node.elements.map((element) => decodeLiteral(file, element as ts.Expression));
  }
  if (ts.isObjectLiteralExpression(node)) {
    const object: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) {
        throw metaError(file, property, "Metadata objects can contain property assignments only.");
      }
      const key = propertyName(file, property.name);
      if (FORBIDDEN_KEYS.has(key)) throw metaError(file, property.name, `Metadata key '${key}' is forbidden.`);
      if (Object.hasOwn(object, key)) throw metaError(file, property.name, `Duplicate metadata key '${key}'.`);
      object[key] = decodeLiteral(file, property.initializer);
    }
    return object;
  }
  throw metaError(file, node, "Metadata must contain literal JSON-compatible values only.");
}

function propertyName(file: ts.SourceFile, name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  throw metaError(file, name, "Computed metadata keys are not allowed.");
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (kind === ts.SyntaxKind.ConstKeyword && ts.isVariableStatement(node)) {
    return (node.declarationList.flags & ts.NodeFlags.Const) !== 0;
  }
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false);
}

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}

function blankRange(source: string, start: number, end: number): string {
  return source.slice(0, start) + source.slice(start, end).replace(/[^\r\n]/g, " ") + source.slice(end);
}

function locationAt(file: ts.SourceFile, offset: number): WorkflowLocation {
  const location = file.getLineAndCharacterOfPosition(offset);
  return { line: location.line + 1, column: location.character + 1 };
}

function metaError(file: ts.SourceFile, node: ts.Node | undefined, message: string): WorkflowScriptError {
  return new WorkflowScriptError(
    "WORKFLOW_META_INVALID",
    message,
    node ? locationAt(file, node.getStart(file)) : undefined,
  );
}
