import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Every page and route handler except the public ones checks the session
 * itself (#4), so a gap in the proxy matcher can't expose one. Server actions
 * are public endpoints whatever the matcher says, so each one is checked on
 * its own (#8).
 */
const webDir = join(import.meta.dirname, '..');
const appDir = join(webDir, 'app');

/** Keep in step with PUBLIC_PATHS in access.ts. */
const PUBLIC_FILES = new Set([
  'sign-in/page.tsx',
  'not-authorized/page.tsx',
  'api/auth/[...nextauth]/route.ts',
]);

/**
 * Inline actions that may run without a session, as `file#function` (paths
 * from apps/web). Signing in and out is what someone without a session does.
 */
const PUBLIC_ACTIONS = new Set([
  'app/sign-in/page.tsx#signInWithGitHub',
  'app/page.tsx#signOutAction',
  'app/not-authorized/page.tsx#signOutAction',
]);

const SESSION_CHECK = /\b(requireUser|currentLogin)\(/;

function entryFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entryFiles(path);
    return /^(page|route)\.tsx?$/.test(entry.name) ? [relative(appDir, path)] : [];
  });
}

/** Every source file in the web app, wherever an action could be declared. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/.test(entry.name) || /\.(test|d)\.tsx?$/.test(entry.name)) return [];
    return [relative(webDir, path)];
  });
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(join(webDir, file), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** The string directives at the top of a file or function body, comments ignored. */
function directives(statements: ts.NodeArray<ts.Statement>): string[] {
  const found: string[] = [];
  for (const statement of statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) break;
    found.push(statement.expression.text);
  }
  return found;
}

type FunctionLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;

/**
 * Whether the first statement after the directives checks the session, so
 * nothing runs before it. An expression body counts as one statement.
 */
function checksSessionFirst(fn: FunctionLike): boolean {
  const body = fn.body;
  if (!body) return false;
  if (!ts.isBlock(body)) return SESSION_CHECK.test(body.getText());
  const first = body.statements[directives(body.statements).length];
  return first !== undefined && SESSION_CHECK.test(first.getText());
}

interface Action {
  /** `file#name`, as PUBLIC_ACTIONS lists them. */
  id: string;
  /** Null when the export isn't a function the test can read. */
  fn: FunctionLike | null;
}

const isExported = (node: ts.Node) =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

function isFunctionLike(node: ts.Node | undefined): node is FunctionLike {
  return (
    node !== undefined &&
    (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node))
  );
}

/** Each export of a `'use server'` file. Types are erased, so they're skipped. */
function exportedActions(file: string, source: ts.SourceFile): Action[] {
  const actions: Action[] = [];
  for (const statement of source.statements) {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) continue;
    if (ts.isFunctionDeclaration(statement) && isExported(statement)) {
      actions.push({ id: `${file}#${statement.name?.text ?? 'default'}`, fn: statement });
    } else if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const decl of statement.declarationList.declarations) {
        const init = decl.initializer;
        actions.push({
          id: `${file}#${decl.name.getText()}`,
          fn: isFunctionLike(init) ? init : null,
        });
      }
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      // `export { x }` and `export * from`: write the action as an exported function instead.
      actions.push({ id: `${file}#${statement.getText()}`, fn: null });
    } else if (ts.isExportAssignment(statement)) {
      const expr = statement.expression;
      actions.push({ id: `${file}#default`, fn: isFunctionLike(expr) ? expr : null });
    }
  }
  return actions;
}

/** Functions anywhere in the file with their own `'use server'` directive. */
function inlineActions(file: string, source: ts.SourceFile): Action[] {
  const actions: Action[] = [];
  const visit = (node: ts.Node) => {
    if (isFunctionLike(node) && node.body && ts.isBlock(node.body)) {
      if (directives(node.body.statements).includes('use server')) {
        let name = node.name?.getText();
        if (!name && ts.isVariableDeclaration(node.parent)) name = node.parent.name.getText();
        actions.push({ id: `${file}#${name ?? `line ${node.getStart()}`}`, fn: node });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return actions;
}

function serverActions(): Action[] {
  return sourceFiles(webDir).flatMap((file) => {
    const source = parse(file);
    const moduleLevel = directives(source.statements).includes('use server');
    return [...(moduleLevel ? exportedActions(file, source) : []), ...inlineActions(file, source)];
  });
}

describe('server actions', () => {
  const actions = serverActions();
  const ids = actions.map((action) => action.id);

  it('finds the actions', () => {
    expect(ids).toContain('app/actions.ts#startScan');
    for (const id of PUBLIC_ACTIONS) expect(ids).toContain(id);
  });

  it.each(actions.filter((action) => !PUBLIC_ACTIONS.has(action.id)))(
    '$id checks the session before doing anything',
    ({ fn }) => {
      expect(fn, 'export a function declaration or a const arrow function').not.toBeNull();
      expect(fn && checksSessionFirst(fn)).toBe(true);
    },
  );
});

describe('the test of server actions', () => {
  const check = (code: string) => {
    const source = ts.createSourceFile('x.ts', code, ts.ScriptTarget.Latest, true);
    return exportedActions('x.ts', source).map(({ id, fn }) => [
      id,
      fn !== null && checksSessionFirst(fn),
    ]);
  };

  it('checks every export, not just the file', () => {
    expect(
      check(`'use server';
        export async function a() { await requireUser(); return 1; }
        export async function wipe() { return 1; }`),
    ).toEqual([
      ['x.ts#a', true],
      ['x.ts#wipe', false],
    ]);
  });

  it('wants the check first', () => {
    expect(check(`export async function a() { await db.delete(); await requireUser(); }`)).toEqual([
      ['x.ts#a', false],
    ]);
  });

  it('cannot read re-exports or values made by a call', () => {
    expect(check(`export { a } from './a'; export const b = wrap(f);`)).toEqual([
      [`x.ts#export { a } from './a';`, false],
      ['x.ts#b', false],
    ]);
  });

  it('finds a directive below a comment', () => {
    const source = parse('app/actions.ts');
    expect(directives(source.statements)).toContain('use server');
    const commented = ts.createSourceFile(
      'x.ts',
      `// A comment.\n/* Another. */\n'use server';\nexport async function a() {}`,
      ts.ScriptTarget.Latest,
      true,
    );
    expect(directives(commented.statements)).toEqual(['use server']);
  });
});

describe('session checks', () => {
  const files = entryFiles(appDir);

  it('finds the app entry files', () => {
    expect(files).toContain('page.tsx');
    for (const file of PUBLIC_FILES) expect(files).toContain(file);
  });

  it.each(files.filter((file) => !PUBLIC_FILES.has(file)))('%s checks the session', (file) => {
    const source = readFileSync(join(appDir, file), 'utf8');
    expect(source).toMatch(SESSION_CHECK);
  });

  // A page that calls `requireUser()` with no path sends a stale session to
  // `/` after signing in again, instead of back to the page.
  it.each(files.filter((file) => /^page\.tsx?$/.test(file.split('/').at(-1) ?? '')))(
    '%s passes its path to requireUser',
    (file) => {
      const source = readFileSync(join(appDir, file), 'utf8');
      expect(source).not.toMatch(/\brequireUser\(\s*\)/);
    },
  );
});
