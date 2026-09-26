/**
 * closure-audit-ast.ts — rule (b) over the TypeScript syntax tree. The line
 * rules in closure-audit-core.ts match one-line shapes at column 0; this pass
 * walks every module-scope statement (top level, namespace bodies and the
 * blocks of top-level control flow) and reports the module state a line
 * regex cannot see:
 *   - destructured declarations whose pattern or initializer creates a
 *     container anywhere (`destructured {` / `destructured [`);
 *   - const initialisers that are any `new` (`new Uint8Array`), a container
 *     factory call (`Object.create`), an immediately-invoked function
 *     (`iife`), or that hold a container outside a function body
 *     (`nested new Map`);
 *   - static class fields that are not readonly (`static field`), readonly
 *     static fields that hold a container (`static new Map`) and static
 *     blocks (`static block`);
 *   - `export default` / `export =` of any of the above (`export default {`).
 * Function bodies are per-call state and are not module scope, except the
 * body of an immediately-invoked function, which runs once at load.
 */
import * as ts from "typescript";

export interface AstBinding {
  line: number;
  token: string;
  text: string;
}

const FACTORY_CALLS = new Set([
  "Object.create",
  "Object.assign",
  "Object.fromEntries",
  "Array.from",
  "Array.of",
  "Buffer.alloc",
  "Buffer.allocUnsafe",
  "Buffer.from",
  "Buffer.concat",
  "structuredClone",
]);

type Report = (node: ts.Node, token: string) => void;

function scriptKind(fileName: string): ts.ScriptKind {
  return /\.[cm]?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
}

/** Peels parentheses, `as`, `satisfies`, `!` and `<T>x` off an expression. */
function unwrap(expr: ts.Expression): ts.Expression {
  let cur = expr;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isSatisfiesExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isTypeAssertionExpression(cur)
  ) {
    cur = cur.expression;
  }
  return cur;
}

function isFunctionExpr(node: ts.Node): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function isIife(node: ts.Node): boolean {
  return ts.isCallExpression(node) && isFunctionExpr(unwrap(node.expression));
}

/** The token for an expression that itself creates module state, or null. */
function directToken(expr: ts.Expression, sf: ts.SourceFile): string | null {
  if (ts.isObjectLiteralExpression(expr)) return "{";
  if (ts.isArrayLiteralExpression(expr)) return "[";
  if (ts.isNewExpression(expr)) return `new ${expr.expression.getText(sf)}`;
  if (isIife(expr)) return "iife";
  if (ts.isCallExpression(expr)) {
    const callee = unwrap(expr.expression).getText(sf);
    if (FACTORY_CALLS.has(callee)) return callee;
  }
  return null;
}

/**
 * The first container created anywhere under `node`. Function bodies are
 * skipped unless `intoFunctions` (their state is per call), but an
 * immediately-invoked function always counts: it runs once at load.
 */
function findContainer(node: ts.Node, sf: ts.SourceFile, intoFunctions: boolean): string | null {
  let found: string | null = null;
  const visit = (n: ts.Node): void => {
    if (found !== null) return;
    if (ts.isExpression(n)) {
      found = directToken(n, sf);
      if (found !== null) return;
    }
    if (!intoFunctions && (isFunctionExpr(n) || ts.isClassExpression(n))) return;
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(node, visit);
  return found;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  return (ts.getModifiers(node) ?? []).some((m) => m.kind === kind);
}

function checkClassMembers(
  members: ts.NodeArray<ts.ClassElement>,
  sf: ts.SourceFile,
  report: Report,
): void {
  for (const member of members) {
    if (ts.isClassStaticBlockDeclaration(member)) {
      report(member, "static block");
      continue;
    }
    if (!ts.isPropertyDeclaration(member) || !hasModifier(member, ts.SyntaxKind.StaticKeyword)) {
      continue;
    }
    if (!hasModifier(member, ts.SyntaxKind.ReadonlyKeyword)) {
      report(member, "static field");
      continue;
    }
    const init = member.initializer;
    if (init === undefined) continue;
    const token = directToken(unwrap(init), sf) ?? findContainer(init, sf, false);
    if (token !== null) report(member, `static ${token}`);
  }
}

/** The token for a module-scope expression bound to a name, or null. */
function initializerToken(init: ts.Expression, sf: ts.SourceFile, report: Report): string | null {
  const expr = unwrap(init);
  if (ts.isClassExpression(expr)) {
    checkClassMembers(expr.members, sf, report);
    return null;
  }
  if (isFunctionExpr(expr)) return null;
  const direct = directToken(expr, sf);
  if (direct !== null) return direct;
  const nested = findContainer(expr, sf, false);
  return nested === null ? null : `nested ${nested}`;
}

function checkDeclaration(decl: ts.VariableDeclaration, sf: ts.SourceFile, report: Report): void {
  const name = decl.name;
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    if (findContainer(decl, sf, true) !== null) {
      report(decl, ts.isObjectBindingPattern(name) ? "destructured {" : "destructured [");
    }
    return;
  }
  if (decl.initializer === undefined) return;
  const token = initializerToken(decl.initializer, sf, report);
  if (token !== null) report(decl, token);
}

/** `var` (no block-scope flag) and `let`; `const`, `using` and `await using`
 * fall through to the initializer checks. */
function isLetOrVar(list: ts.VariableDeclarationList): boolean {
  return (list.flags & ts.NodeFlags.BlockScoped) === 0 || (list.flags & ts.NodeFlags.Let) !== 0;
}

function checkVariableList(
  list: ts.VariableDeclarationList,
  sf: ts.SourceFile,
  report: Report,
): void {
  if (isLetOrVar(list)) {
    report(list, "let|var");
    return;
  }
  for (const decl of list.declarations) checkDeclaration(decl, sf, report);
}

/** The branches of a top-level `if` or `try`; undefined for other statements. */
function branchStatements(stmt: ts.Statement): ts.Statement[] | undefined {
  if (ts.isIfStatement(stmt)) {
    return stmt.elseStatement === undefined
      ? [stmt.thenStatement]
      : [stmt.thenStatement, stmt.elseStatement];
  }
  if (ts.isTryStatement(stmt)) {
    return [stmt.tryBlock, stmt.catchClause?.block, stmt.finallyBlock].filter(
      (b): b is ts.Block => b !== undefined,
    );
  }
  return undefined;
}

/** A namespace body's statements (`namespace A.B {}` nests declarations). */
function namespaceStatements(stmt: ts.ModuleDeclaration): ts.Statement[] {
  const body = stmt.body;
  if (body === undefined) return [];
  if (ts.isModuleBlock(body)) return [...body.statements];
  return ts.isModuleDeclaration(body) ? [body] : [];
}

/** Statements nested in top-level control flow still run at module scope. */
function nestedStatements(stmt: ts.Statement): ts.Statement[] {
  if (ts.isBlock(stmt)) return [...stmt.statements];
  const branches = branchStatements(stmt);
  if (branches !== undefined) return branches;
  if (ts.isIterationStatement(stmt, false) || ts.isLabeledStatement(stmt)) {
    return [stmt.statement];
  }
  if (ts.isSwitchStatement(stmt)) return stmt.caseBlock.clauses.flatMap((c) => [...c.statements]);
  return ts.isModuleDeclaration(stmt) ? namespaceStatements(stmt) : [];
}

function loopInitializer(stmt: ts.Statement): ts.VariableDeclarationList | undefined {
  if (!(ts.isForStatement(stmt) || ts.isForInStatement(stmt) || ts.isForOfStatement(stmt))) {
    return undefined;
  }
  const init = stmt.initializer;
  return init !== undefined && ts.isVariableDeclarationList(init) ? init : undefined;
}

function checkStatement(stmt: ts.Statement, sf: ts.SourceFile, report: Report): void {
  if (ts.isVariableStatement(stmt)) {
    checkVariableList(stmt.declarationList, sf, report);
  } else if (ts.isClassDeclaration(stmt)) {
    checkClassMembers(stmt.members, sf, report);
  } else if (ts.isExportAssignment(stmt)) {
    const token = initializerToken(stmt.expression, sf, report);
    if (token !== null) report(stmt, `export default ${token}`);
  }
  const loopInit = loopInitializer(stmt);
  if (loopInit !== undefined && (loopInit.flags & ts.NodeFlags.BlockScoped) === 0) {
    report(loopInit, "let|var");
  }
  for (const inner of nestedStatements(stmt)) checkStatement(inner, sf, report);
}

/** Module-scope mutable state in one file, one entry per offending node. */
export function astMutableBindings(fileName: string, source: string): AstBinding[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(fileName),
  );
  const lines = source.split("\n");
  const out: AstBinding[] = [];
  const report: Report = (node, token) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    out.push({ line, token, text: (lines[line - 1] ?? "").trim() });
  };
  for (const stmt of sf.statements) checkStatement(stmt, sf, report);
  return out;
}
