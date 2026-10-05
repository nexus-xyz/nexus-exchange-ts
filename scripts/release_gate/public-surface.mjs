#!/usr/bin/env node
/**
 * Public-surface snapshot (ENG-18798). Lists the public API of the package
 * exactly as `pnpm pack` packs it (the tarball a publish uploads, unpacked) and
 * compares it with the committed `public-api.txt`.
 *
 *   node scripts/release_gate/public-surface.mjs          check: fail on any difference (CI, `prepublish-surface`)
 *   node scripts/release_gate/public-surface.mjs --write  regenerate public-api.txt after a deliberate API change
 *
 * Any difference fails, additions included, so the snapshot moves in the same
 * PR as the code. A removed or changed item then shows up as a `-` line in the
 * diff a reviewer reads, instead of first surfacing in a consumer's build.
 *
 * The listing comes from the packed `.d.ts` files, read with the TypeScript
 * compiler API (already a devDependency). The entry is the tarball's own
 * `exports["."].types`, and the checker resolves what it exports, `export *`
 * included. Each export is one line with its kind and its type as the
 * declaration file spells it. Interfaces, classes, enums and object type
 * aliases also get one line per member with its type, so a reshaped type (a
 * field renamed, retyped or made optional) changes the snapshot, not only a
 * dropped name. Comments are not part of it; private members are left out.
 *
 * A constant is listed with its widened type (`const SDK_VERSION: string`),
 * not its literal value. release-please rewrites SDK_VERSION, and with it
 * DEFAULT_USER_AGENT, on the release PR, which must not fail this check for
 * moving the version. cargo-public-api lists the Rust SDK's constants the same
 * way: the type is the surface, the value is not.
 */
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { REPO, pack, run } from "./pack.mjs";

const SNAPSHOT = "public-api.txt";
const WRITE_CMD = "node scripts/release_gate/public-surface.mjs --write";

const printer = ts.createPrinter({
  removeComments: true,
  newLine: ts.NewLineKind.LineFeed,
});

/** One node as a single line: printed without comments, whitespace collapsed. */
function text(node) {
  return printer
    .printNode(ts.EmitHint.Unspecified, node, node.getSourceFile())
    .replace(/\s+/g, " ")
    .trim()
    .replace(/;$/, "");
}

const list = (nodes) => (nodes ?? []).map(text).join(", ");
const typeParams = (node) =>
  node.typeParameters ? `<${list(node.typeParameters)}>` : "";
const heritage = (node) =>
  (node.heritageClauses ?? []).map((clause) => ` ${text(clause)}`).join("");

function hasModifier(node, kind) {
  return (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some(
    (modifier) => modifier.kind === kind,
  );
}

/** Private members are not public surface. A private constructor is: it stops `new`. */
function isPublicMember(member) {
  if (member.name && ts.isPrivateIdentifier(member.name)) return false;
  if (ts.isConstructorDeclaration(member)) return true;
  return !hasModifier(member, ts.SyntaxKind.PrivateKeyword);
}

/** A literal initializer's widened type; see the header for why. */
function widenedType(initializer) {
  if (!initializer) return "unknown";
  if (ts.isStringLiteralLike(initializer)) return "string";
  if (ts.isNumericLiteral(initializer)) return "number";
  if (ts.isBigIntLiteral(initializer)) return "bigint";
  if (
    initializer.kind === ts.SyntaxKind.TrueKeyword ||
    initializer.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return "boolean";
  }
  if (
    ts.isPrefixUnaryExpression(initializer) &&
    ts.isNumericLiteral(initializer.operand)
  ) {
    return "number";
  }
  return text(initializer);
}

/**
 * A header line, then one line per member that repeats the header's name, so
 * each line still says what it belongs to once the listing is sorted.
 */
function withMembers(head, suffix, members) {
  return [
    `${head}${suffix}`,
    ...members.map((member) => `${head} { ${text(member)} }`),
  ];
}

/** The lines for one declaration of the export called `name`. */
function linesFor(name, decl) {
  if (ts.isClassDeclaration(decl)) {
    const abstract = hasModifier(decl, ts.SyntaxKind.AbstractKeyword)
      ? "abstract "
      : "";
    return withMembers(
      `${abstract}class ${name}${typeParams(decl)}`,
      heritage(decl),
      decl.members.filter(isPublicMember),
    );
  }
  if (ts.isInterfaceDeclaration(decl)) {
    return withMembers(
      `interface ${name}${typeParams(decl)}`,
      heritage(decl),
      decl.members,
    );
  }
  if (ts.isTypeAliasDeclaration(decl)) {
    const head = `type ${name}${typeParams(decl)}`;
    if (ts.isTypeLiteralNode(decl.type)) {
      return withMembers(head, " = { ... }", decl.type.members);
    }
    return [`${head} = ${text(decl.type)}`];
  }
  if (ts.isEnumDeclaration(decl)) {
    const kind = hasModifier(decl, ts.SyntaxKind.ConstKeyword)
      ? "const enum"
      : "enum";
    return withMembers(`${kind} ${name}`, "", decl.members);
  }
  if (ts.isFunctionDeclaration(decl)) {
    const returns = decl.type ? `: ${text(decl.type)}` : "";
    return [
      `function ${name}${typeParams(decl)}(${list(decl.parameters)})${returns}`,
    ];
  }
  if (ts.isVariableDeclaration(decl)) {
    const flags = ts.getCombinedNodeFlags(decl);
    const kind =
      flags & ts.NodeFlags.Const
        ? "const"
        : flags & ts.NodeFlags.Let
          ? "let"
          : "var";
    const type = decl.type ? text(decl.type) : widenedType(decl.initializer);
    return [`${kind} ${name}: ${type}`];
  }
  if (ts.isSourceFile(decl)) {
    // `export * as ns from` has no reader here yet. Fail loudly rather than
    // print a whole module on one line, or leave it out of the snapshot.
    throw new Error(
      `export "${name}" is a whole module; teach public-surface.mjs to list it`,
    );
  }
  // Any other kind: still listed, as its full text, so a change to it shows.
  return [`${ts.SyntaxKind[decl.kind]} ${name}: ${text(decl)}`];
}

/** The sorted listing of everything the package entry at `root` exports. */
function surface(root) {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const entryTypes = manifest.exports?.["."]?.types ?? manifest.types;
  if (!entryTypes) {
    throw new Error("the packed package.json declares no types entry");
  }
  const entry = join(root, entryTypes);
  if (!existsSync(entry)) {
    throw new Error(`the packed package has no ${entryTypes}`);
  }

  // Only the export graph is resolved, so no @types are loaded: an unresolved
  // global (AbortSignal) does not change a declaration's text.
  const program = ts.createProgram([entry], {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    types: [],
    noEmit: true,
  });
  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(
    program.getSourceFile(entry),
  );
  if (!moduleSymbol) throw new Error(`${entryTypes} is not a module`);

  const lines = [];
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const name = ts.symbolName(exported);
    const target =
      exported.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(exported)
        : exported;
    const declarations = target.declarations ?? [];
    if (declarations.length === 0) {
      throw new Error(`export "${name}" resolves to no declaration`);
    }
    for (const decl of declarations) lines.push(...linesFor(name, decl));
  }
  // Code-unit order, not localeCompare: the same bytes on every machine.
  return lines.sort();
}

function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  }
}

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--write")) {
  console.error(
    "usage: node scripts/release_gate/public-surface.mjs [--write]",
  );
  process.exit(64);
}
const write = args[0] === "--write";

const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
const built = `packed ${pkg.name}@${pkg.version}`;
const work = mkdtempSync(join(tmpdir(), "exchange-ts-surface-"));
let code = 0;
try {
  const tarball = pack(work);
  run("tar", ["-xzf", tarball, "-C", work]);
  const listing = `${surface(join(work, "package")).join("\n")}\n`;
  const count = listing.split("\n").length - 1;
  const snapshot = join(REPO, SNAPSHOT);

  if (write) {
    writeFileSync(snapshot, listing);
    console.log(`wrote ${SNAPSHOT} (${count} items) from ${built}`);
  } else if (!existsSync(snapshot)) {
    console.log(
      `::error title=prepublish-surface::${SNAPSHOT} is missing. Run ${WRITE_CMD} and commit it.`,
    );
    code = 1;
  } else if (readFileSync(snapshot, "utf8") === listing) {
    console.log(`public surface matches ${SNAPSHOT} (${count} items)`);
  } else {
    const fresh = join(work, SNAPSHOT);
    writeFileSync(fresh, listing);
    let diff = "";
    try {
      run("diff", [
        "-u",
        "--label",
        `${SNAPSHOT} (committed)`,
        "--label",
        `${SNAPSHOT} (${built})`,
        snapshot,
        fresh,
      ]);
    } catch (err) {
      // diff exits 1 when the files differ; anything else is a real error.
      if (err.status !== 1) throw err;
      diff = err.stdout;
    }
    const body = diff.split("\n").slice(2);
    const removed = body.filter((line) => line.startsWith("-")).length;
    const added = body.filter((line) => line.startsWith("+")).length;
    process.stdout.write(diff);
    console.log(
      `::error title=prepublish-surface::The packed package's public API differs from ${SNAPSHOT}: ${removed} item(s) gone or changed, ${added} new. If that is deliberate, run ${WRITE_CMD} and commit ${SNAPSHOT} in this PR, so the change is in the diff a reviewer reads. A removal or change is breaking.`,
    );
    summary(
      [
        `### Public surface: ❌ differs from \`${SNAPSHOT}\``,
        "",
        `${removed} item(s) gone or changed (\`-\`), ${added} new (\`+\`). Regenerate with \`${WRITE_CMD}\` if deliberate.`,
        "",
        "```diff",
        diff.trimEnd(),
        "```",
        "",
      ].join("\n"),
    );
    code = 1;
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(code);
