import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Linter } from "eslint";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const FAULT_CONTROLLER_SENTINEL = "FOR_MOBILE_E2E_FAULT_CONTROLLER_REAL_V1";
export const BOOTSTRAP_TRACE_SENTINEL = "FOR_MOBILE_E2E_BOOTSTRAP_TRACE_V1";
export const FAULT_BUNDLE_PROOF_PATH = ".artifacts/fault-bundles/proof.json";
export const FAULT_BUNDLE_PLATFORMS = Object.freeze(["android", "ios"]);
export const FAULT_BUNDLE_FLAVORS = Object.freeze(["production", "e2e"]);
export const FAULT_BUNDLE_EXPORT_FLAGS = Object.freeze(["--no-bytecode", "--no-minify", "--clear"]);

const faultPoints = JSON.parse(await readFile(resolve(repoRoot, "src/testing/faultPoints.json"), "utf8"));
const faultPointGrammar = /^[a-z][a-z0-9_.]*$/;
assert(Array.isArray(faultPoints) && faultPoints.length === 13, "Fault point registry must contain exactly 13 points");
assert(
  faultPoints.every((point) => typeof point === "string" && point.length > 0 && faultPointGrammar.test(point)),
  "Fault point registry contains an empty or grammar-unsafe point",
);
assert.equal(new Set(faultPoints).size, faultPoints.length, "Fault point registry contains duplicate points");
const protocolMarker = "formobile-test:";
const modeMarker = "crash_once";
export const FAULT_BUNDLE_MARKERS = Object.freeze([
  FAULT_CONTROLLER_SENTINEL,
  BOOTSTRAP_TRACE_SENTINEL,
  protocolMarker,
  modeMarker,
  ...faultPoints,
]);
assert(FAULT_BUNDLE_MARKERS.every((marker) => marker.length > 0), "Fault bundle markers must be nonempty");
assert.equal(new Set(FAULT_BUNDLE_MARKERS).size, FAULT_BUNDLE_MARKERS.length, "Fault bundle markers must be unique");
assert.deepEqual(FAULT_BUNDLE_MARKERS.slice(4), faultPoints, "Fault bundle point markers must preserve the exact registry");

function expectedCounts(flavor) {
  // Tripwire for the current source topology: both sentinels/protocol/mode/each registry point = 1/1/2/3/1.
  return Object.freeze(Object.fromEntries(FAULT_BUNDLE_MARKERS.map((marker) => [
    marker,
    flavor === "production"
      ? 0
      : marker === FAULT_CONTROLLER_SENTINEL || marker === BOOTSTRAP_TRACE_SENTINEL
        ? 1
        : marker === protocolMarker
          ? 2
          : marker === modeMarker
            ? 3
            : 1,
  ])));
}

export const FAULT_BUNDLE_EXPECTED_MARKER_COUNTS = Object.freeze({
  production: expectedCounts("production"),
  e2e: expectedCounts("e2e"),
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function occurrences(bytes, needle) {
  let count = 0;
  let offset = 0;
  while ((offset = bytes.indexOf(needle, offset)) >= 0) {
    count += 1;
    offset += needle.length;
  }
  return count;
}

function markerCounts(bytes) {
  return Object.fromEntries(FAULT_BUNDLE_MARKERS.map((marker) => [
    marker,
    occurrences(bytes, Buffer.from(marker)),
  ]));
}

function hasExactKeys(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function assertMarkerCounts(value, label) {
  assert(hasExactKeys(value, FAULT_BUNDLE_MARKERS), `${label} contains unknown or missing marker fields`);
  for (const marker of FAULT_BUNDLE_MARKERS) {
    assert(Number.isSafeInteger(value[marker]) && value[marker] >= 0, `${label} contains an invalid marker count`);
  }
}

function assertCanonicalBundlePath(path, platform, flavor) {
  const label = `${platform} ${flavor}`;
  const prefix = `.artifacts/fault-bundles/${platform}/${flavor}/`;
  assert.equal(typeof path, "string", `${label} bundle path is absent`);
  assert(path.startsWith(prefix), `${label} bundle path is outside its canonical export directory`);
  assert(!path.split(/[\\/]/).includes(".."), `${label} bundle path contains traversal`);
  assert(
    new RegExp(`^\\.artifacts/fault-bundles/${platform}/${flavor}/_expo/static/js/${platform}/index-[0-9a-f]{32}\\.js$`).test(path),
    `${label} bundle path is not a canonical lowercase-hashed index JavaScript bundle`,
  );
}

async function canonicalBundlePath(root, platform, flavor) {
  const label = `${platform} ${flavor}`;
  const staticDirectory = `.artifacts/fault-bundles/${platform}/${flavor}/_expo/static/js`;
  const staticEntries = await readdir(resolve(root, staticDirectory), { withFileTypes: true });
  assert(
    staticEntries.length === 1 && staticEntries[0].isDirectory() && staticEntries[0].name === platform,
    `${label} export must retain only its canonical platform bundle directory`,
  );
  const directory = `${staticDirectory}/${platform}`;
  const entries = await readdir(resolve(root, directory), { withFileTypes: true });
  assert.equal(entries.length, 1, `${label} export must retain exactly one canonical JavaScript bundle`);
  const [entry] = entries;
  assert(entry.isFile() && /^index-[0-9a-f]{32}\.js$/.test(entry.name), `${label} bundle must be one canonical regular index JavaScript file`);
  return `${directory}/${entry.name}`;
}

async function assertNoSymlinkPath(root, path, label) {
  let current = resolve(root);
  assert(!(await lstat(current)).isSymbolicLink(), `${label} retained evidence root must not be a symbolic link`);
  for (const component of path.split(/[\\/]/).filter(Boolean)) {
    current = join(current, component);
    assert(!(await lstat(current)).isSymbolicLink(), `${label} retained evidence path must not contain a symbolic link`);
  }
}

async function validateFlavorExportTree(root, platform, flavor, bundlePath) {
  const label = `${platform} ${flavor}`;
  const exportRoot = `.artifacts/fault-bundles/${platform}/${flavor}`;
  await assertNoSymlinkPath(root, exportRoot, label);
  const pending = [exportRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      const stat = await lstat(resolve(root, path));
      assert(!stat.isSymbolicLink(), `${label} export must not contain symbolic links`);
      if (stat.isDirectory()) pending.push(path);
      else {
        assert(stat.isFile(), `${label} export entries must be regular files or directories`);
        if (/\.(?:[cm]?js|jsx)$/i.test(entry.name)) {
          assert.equal(path, bundlePath, `${label} export contains extra JavaScript outside the canonical bundle`);
        }
      }
    }
  }
}

function walkAst(node, visit, parent = null) {
  if (!node || typeof node !== "object" || typeof node.type !== "string") return;
  visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (key === "parent" || key === "tokens" || key === "comments") continue;
    if (Array.isArray(value)) for (const child of value) walkAst(child, visit, node);
    else walkAst(value, visit, node);
  }
}

function astNodes(node, predicate) {
  const matches = [];
  walkAst(node, (candidate, parent) => {
    if (predicate(candidate, parent)) matches.push(candidate);
  });
  return matches;
}

function identifier(node, name) {
  return node?.type === "Identifier" && node.name === name;
}

function literal(node, value) {
  return node?.type === "Literal" && node.value === value;
}

function unwrapExpression(node) {
  if (node?.type === "ChainExpression") return unwrapExpression(node.expression);
  if (node?.type === "SequenceExpression") return unwrapExpression(node.expressions.at(-1));
  return node;
}

function unwrapChain(node) {
  return node?.type === "ChainExpression" ? node.expression : node;
}

function staticString(node) {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0 && node.quasis.length === 1) {
    return node.quasis[0].value.cooked;
  }
  if (node?.type !== "BinaryExpression" || node.operator !== "+") return null;
  const left = staticString(node.left);
  const right = staticString(node.right);
  return left === null || right === null ? null : left + right;
}

function propertyName(member) {
  if (member?.type !== "MemberExpression") return null;
  if (!member.computed && member.property.type === "Identifier") return member.property.name;
  return staticString(member.property);
}

function member(node, objectName, memberName) {
  const value = unwrapChain(node);
  return value?.type === "MemberExpression" && identifier(value.object, objectName) && propertyName(value) === memberName;
}

function dependencyMapIndex(node, mapName) {
  const value = unwrapChain(node);
  if (value?.type !== "MemberExpression" || !value.computed || !identifier(value.object, mapName)) return null;
  return Number.isSafeInteger(value.property?.value) && value.property.value >= 0 ? value.property.value : null;
}

function parseJavaScript(source, label) {
  let program = null;
  const linter = new Linter({ configType: "eslintrc" });
  linter.defineRule("fault-bundle-ast", {
    create() {
      return {
        Program(node) {
          program = node;
        },
      };
    },
  });
  const messages = linter.verify(source, {
    parserOptions: { ecmaVersion: "latest", sourceType: "script" },
    rules: { "fault-bundle-ast": "error" },
  });
  const fatal = messages.find((message) => message.fatal);
  assert(program, `${label} JavaScript AST parse failed${fatal ? `: ${fatal.message}` : ""}`);
  return program;
}

function parseMetroBundle(bytes, label) {
  const program = parseJavaScript(bytes.toString("utf8"), label);
  const modules = [];
  const roots = [];
  for (const statement of program.body) {
    const call = statement.type === "ExpressionStatement" ? directCall(statement.expression) : null;
    if (call?.type !== "CallExpression" || call.callee.type !== "Identifier") continue;
    if (call.callee.name === "__r") {
      assert.equal(call.arguments.length, 1, `${label} Metro __r root is malformed`);
      const moduleId = call.arguments[0]?.value;
      assert(Number.isSafeInteger(moduleId) && moduleId >= 0, `${label} Metro __r root ID is invalid`);
      roots.push(moduleId);
    }
    if (call.callee.name === "__d") {
      assert.equal(call.arguments.length, 3, `${label} Metro __d wrapper is malformed`);
      const [factory, idNode, dependencyNode] = call.arguments;
      assert(factory?.type === "FunctionExpression" && !factory.async && !factory.generator
        && factory.body.type === "BlockStatement", `${label} Metro __d factory is invalid`);
      assert(factory.params.length >= 7 && factory.params.every((parameter) => parameter.type === "Identifier"), `${label} Metro __d factory parameters are invalid`);
      const moduleId = idNode?.value;
      assert(Number.isSafeInteger(moduleId) && moduleId >= 0, `${label} Metro module ID is invalid`);
      assert(dependencyNode?.type === "ArrayExpression", `${label} Metro dependency map is invalid`);
      const dependencies = dependencyNode.elements.map((dependency) => {
        assert(dependency?.type === "Literal", `${label} Metro dependency entry is invalid`);
        assert(
          dependency.value === null || (Number.isSafeInteger(dependency.value) && dependency.value >= 0),
          `${label} Metro dependency entry is invalid`,
        );
        return dependency.value;
      });
      modules.push({
        moduleId,
        dependencies,
        factory,
        requireName: factory.params[1].name,
        moduleName: factory.params[4].name,
        exportsName: factory.params[5].name,
        dependencyMapName: factory.params[6].name,
      });
    }
  }
  const allDefinitions = astNodes(program, (node) => node.type === "CallExpression" && identifier(node.callee, "__d"));
  const allRoots = astNodes(program, (node) => node.type === "CallExpression" && identifier(node.callee, "__r"));
  assert.equal(modules.length, allDefinitions.length, `${label} every Metro __d definition must be top-level`);
  assert.equal(roots.length, allRoots.length, `${label} every Metro __r root must be top-level`);
  assert(modules.length > 0, `${label} bundle contains no Metro __d wrappers`);
  assert(roots.length > 0, `${label} bundle contains no executing Metro __r roots`);
  assert.equal(new Set(modules.map(({ moduleId }) => moduleId)).size, modules.length, `${label} Metro module IDs must be unique`);
  const byId = new Map(modules.map((module) => [module.moduleId, module]));
  for (const root of roots) assert(byId.has(root), `${label} Metro root ${root} does not resolve to a defined module`);
  for (const module of modules) {
    const staticImports = [];
    for (const statement of module.factory.body.body) {
      if (statement.type === "ReturnStatement" || statement.type === "ThrowStatement") break;
      const expressions = statement.type === "VariableDeclaration"
        ? statement.declarations.map(({ init }) => init)
        : statement.type === "ExpressionStatement" ? [directCall(statement.expression)] : [];
      for (const expression of expressions) {
        const call = expression?.type === "CallExpression" && identifier(unwrapChain(expression.callee), module.requireName)
          ? expression
          : null;
        if (!call) continue;
        assert(call.arguments.length >= 1, `${label} module ${module.moduleId} require call is malformed`);
        const dependencyIndex = dependencyMapIndex(call.arguments[0], module.dependencyMapName);
        assert.notEqual(dependencyIndex, null, `${label} module ${module.moduleId} require does not use its Metro dependency map`);
        staticImports.push(dependencyIndex);
      }
    }
    module.usedDependencyIndexes = [...new Set(staticImports)];
  }
  return { modules, roots, byId };
}

function isModuleExports(node) {
  return member(node, "module", "exports");
}

function canonicalCallee(node) {
  let value = node?.type === "ChainExpression" ? node.expression : node;
  if (value?.type !== "SequenceExpression") return value;
  if (value.expressions.length !== 2 || !literal(value.expressions[0], 0)) return null;
  value = value.expressions[1];
  return value?.type === "ChainExpression" ? value.expression : value;
}

function directCall(node) {
  const value = node?.type === "ChainExpression" ? node.expression : node;
  return value?.type === "CallExpression" ? value : null;
}

function patternContains(pattern, name) {
  if (!pattern) return false;
  if (identifier(pattern, name)) return true;
  if (pattern.type === "AssignmentPattern") return patternContains(pattern.left, name);
  if (pattern.type === "RestElement") return patternContains(pattern.argument, name);
  if (pattern.type === "ArrayPattern") return pattern.elements.some((element) => patternContains(element, name));
  if (pattern.type === "ObjectPattern") {
    return pattern.properties.some((property) => property.type === "RestElement"
      ? patternContains(property.argument, name)
      : patternContains(property.value, name));
  }
  return false;
}

function bindingDefinitions(scope, name) {
  const definitions = [];
  walkAst(scope, (node) => {
    if (node.type === "VariableDeclarator" && patternContains(node.id, name)) definitions.push(node.id);
    else if (["FunctionDeclaration", "FunctionExpression", "ClassDeclaration", "ClassExpression"].includes(node.type)
      && identifier(node.id, name)) definitions.push(node.id);
    if (["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)) {
      for (const parameter of node.params) if (patternContains(parameter, name)) definitions.push(parameter);
    }
    if (node.type === "CatchClause" && patternContains(node.param, name)) definitions.push(node.param);
  });
  return definitions;
}

function bindingWrites(scope, name) {
  return astNodes(scope, (node) => (
    node.type === "AssignmentExpression" && patternContains(node.left, name)
    || node.type === "UpdateExpression" && identifier(node.argument, name)
    || node.type === "UnaryExpression" && node.operator === "delete" && identifier(node.argument, name)
    || ["ForInStatement", "ForOfStatement"].includes(node.type)
      && node.left.type !== "VariableDeclaration" && patternContains(node.left, name)
  ));
}

function memberRoot(node) {
  let value = node?.type === "ChainExpression" ? node.expression : node;
  while (value?.type === "MemberExpression") value = unwrapExpression(value.object);
  return value?.type === "Identifier" ? value.name : null;
}

function bindingMemberWrites(scope, name) {
  return astNodes(scope, (node) => {
    if (node.type === "AssignmentExpression") return memberRoot(node.left) === name;
    if (node.type === "UpdateExpression") return memberRoot(node.argument) === name;
    return node.type === "UnaryExpression" && node.operator === "delete" && memberRoot(node.argument) === name;
  });
}

function bindingIsImmutable(scope, name, definition, includeMembers = false) {
  const definitions = bindingDefinitions(scope, name);
  return definitions.length === 1 && definitions[0] === definition
    && bindingWrites(scope, name).length === 0
    && (!includeMembers || bindingMemberWrites(scope, name).length === 0);
}

const TRACE_INTRINSICS = Object.freeze([
  "JSON",
  "console",
  "Object",
  "Number",
  "Math",
  "Map",
  "Set",
  "String",
  "Reflect",
  "Error",
  "AggregateError",
  "Function",
  "eval",
  "Proxy",
]);
const INTRINSIC_MUTATORS = new Set(["assign", "defineProperties", "defineProperty", "setPrototypeOf"]);
const DANGEROUS_MEMBER_NAMES = new Set(["__proto__", "constructor", "prototype", "toJSON"]);
const DYNAMIC_CODE_NAMES = new Set(["eval", "Function"]);

function assertNoDangerousRuntimeConstruction(module, label) {
  const scope = module.factory.body;
  const opaqueComputedMembers = astNodes(scope, (node) => node.type === "MemberExpression"
    && node.computed && propertyName(node) === null
    && dependencyMapIndex(node, module.dependencyMapName) === null);
  assert.equal(opaqueComputedMembers.length, 0,
    `${label} must not use opaque computed members outside canonical Metro dependency-map indexing`);
  const dangerousMembers = astNodes(scope, (node) => node.type === "MemberExpression"
    && DANGEROUS_MEMBER_NAMES.has(propertyName(node)));
  assert.equal(dangerousMembers.length, 0, `${label} must not use dangerous constructor, prototype, __proto__, or toJSON members`);
  const dynamicCode = astNodes(scope, (node) => {
    if (!["CallExpression", "NewExpression", "TaggedTemplateExpression"].includes(node.type)) return false;
    const target = node.type === "TaggedTemplateExpression" ? node.tag : node.callee;
    const callee = canonicalCallee(target);
    return callee?.type === "Identifier" && DYNAMIC_CODE_NAMES.has(callee.name)
      || callee?.type === "MemberExpression" && propertyName(callee) === "constructor";
  });
  assert.equal(dynamicCode.length, 0, `${label} must not evaluate dynamic code`);
}

function assertNoGlobalObjectReferences(module, label) {
  const metroGlobal = module.factory.params[0];
  assert(metroGlobal?.type === "Identifier", `${label} Metro global binding is invalid`);
  const names = new Set([metroGlobal.name, "global", "globalThis"]);
  for (const name of names) {
    const references = astNodes(module.factory.body, (node, parent) => identifier(node, name)
      && isIdentifierReference(node, parent));
    assert.equal(references.length, 0, `${label} must not reference the Metro global or globalThis`);
  }
}

function assertPristineIntrinsics(module, label) {
  const scope = module.factory.body;
  assertNoDangerousRuntimeConstruction(module, label);
  const intrinsicNames = new Set(TRACE_INTRINSICS);
  for (const name of TRACE_INTRINSICS) {
    assert.equal(bindingDefinitions(scope, name).length, 0, `${label} must not shadow the ${name} intrinsic`);
    assert.equal(bindingWrites(scope, name).length, 0, `${label} must not write the ${name} intrinsic binding`);
    assert.equal(bindingMemberWrites(scope, name).length, 0, `${label} must not monkeypatch the ${name} intrinsic or prototype`);
  }
  const mutationCalls = astNodes(scope, (node) => {
    if (node.type !== "CallExpression") return false;
    const callee = canonicalCallee(node.callee);
    if (callee?.type !== "MemberExpression" || !INTRINSIC_MUTATORS.has(propertyName(callee))) return false;
    const targetRoot = memberRoot(node.arguments[0]);
    return targetRoot !== null && intrinsicNames.has(targetRoot);
  });
  assert.equal(mutationCalls.length, 0, `${label} must not mutate trace intrinsics through helper calls`);
}

function isIdentifierReference(node, parent) {
  if (!parent) return true;
  if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) return false;
  if (parent.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand) return false;
  if (["MethodDefinition", "PropertyDefinition"].includes(parent.type) && parent.key === node && !parent.computed) return false;
  if (parent.type === "LabeledStatement" && parent.label === node) return false;
  if (["BreakStatement", "ContinueStatement"].includes(parent.type) && parent.label === node) return false;
  return true;
}

function bindingReferences(scope, name, definition) {
  const definitionNodes = new Set();
  walkAst(definition, (node) => definitionNodes.add(node));
  return astNodes(scope, (node, parent) => identifier(node, name)
    && !definitionNodes.has(node) && isIdentifierReference(node, parent));
}

function directIntrinsicCall(node, objectName, methodName, argumentCount) {
  const call = directCall(node);
  const callee = call ? unwrapChain(call.callee) : null;
  return call && callee?.type === "MemberExpression" && !callee.computed
    && identifier(callee.object, objectName) && propertyName(callee) === methodName
    && call.arguments.length === argumentCount ? { call, object: callee.object } : null;
}

function assertExactIntrinsicReferences(module, expectedByName, label) {
  assertNoGlobalObjectReferences(module, label);
  assertPristineIntrinsics(module, label);
  const scope = module.factory.body;
  for (const name of TRACE_INTRINSICS) {
    const expected = new Set(expectedByName[name] ?? []);
    assert([...expected].every((node) => identifier(node, name)), `${label} ${name} expected reference set is invalid`);
    const actual = astNodes(scope, (node, parent) => identifier(node, name) && isIdentifierReference(node, parent));
    assert(actual.length === expected.size && actual.every((node) => expected.has(node)),
      `${label} ${name} intrinsic must be closed to its exact canonical references`);
  }
}

function assertExactSelectedIntrinsicReferences(module, expectedByName, label) {
  assertNoGlobalObjectReferences(module, label);
  assertPristineIntrinsics(module, label);
  const scope = module.factory.body;
  for (const [name, expectedNodes] of Object.entries(expectedByName)) {
    const expected = new Set(expectedNodes);
    assert([...expected].every((node) => identifier(node, name)), `${label} ${name} expected reference set is invalid`);
    const actual = astNodes(scope, (node, parent) => identifier(node, name) && isIdentifierReference(node, parent));
    assert(actual.length === expected.size && actual.every((node) => expected.has(node)),
      `${label} ${name} intrinsic must be closed to its exact canonical references`);
  }
}

function assertExactReferences(scope, name, definition, expectedReferences, label) {
  const definitions = bindingDefinitions(scope, name);
  assert(definitions.length === 1 && definitions[0] === definition, `${label} binding must be unique and unshadowed`);
  const expected = new Set(expectedReferences);
  assert([...expected].every((node) => identifier(node, name)), `${label} expected reference set is invalid`);
  const actual = bindingReferences(scope, name, definition);
  assert(actual.length === expected.size && actual.every((node) => expected.has(node)),
    `${label} binding must be closed to its exact allowed references`);
}

function assertExactBindingReferences(scope, name, definition, expectedReferences, label) {
  assert(bindingIsImmutable(scope, name, definition), `${label} binding must be immutable and unshadowed`);
  assertExactReferences(scope, name, definition, expectedReferences, label);
}

function hasFunctionFlags(fn, isAsync, isGenerator = false) {
  return Boolean(fn) && Boolean(fn.async) === isAsync && Boolean(fn.generator) === isGenerator;
}

function assertCanonicalMetroImports(module, label) {
  const requireDefinition = module.factory.params[1];
  const mapDefinition = module.factory.params[6];
  assert(identifier(requireDefinition, module.requireName) && identifier(mapDefinition, module.dependencyMapName)
    && new Set(module.factory.params.map((parameter) => parameter.name)).size === module.factory.params.length,
  `${label} Metro factory parameters must be distinct canonical bindings`);
  const requireReferences = [];
  const mapReferences = [];
  const addCanonicalCall = (call) => {
    assert.equal(call.arguments.length, 1, `${label} Metro dependency import must have one argument`);
    const dependencyIndex = dependencyMapIndex(call.arguments[0], module.dependencyMapName);
    assert.notEqual(dependencyIndex, null, `${label} Metro dependency import must use a direct dependency-map member`);
    requireReferences.push(call.callee);
    mapReferences.push(unwrapChain(call.arguments[0]).object);
  };
  const addCanonicalCalls = (scope) => {
    for (const call of astNodes(scope, (node) => node.type === "CallExpression" && identifier(node.callee, module.requireName))) {
      addCanonicalCall(call);
    }
  };
  let terminated = false;
  for (const statement of module.factory.body.body) {
    if (terminated) {
      addCanonicalCalls(statement);
      continue;
    }
    if (statement.type === "ReturnStatement" || statement.type === "ThrowStatement") {
      terminated = true;
      continue;
    }
    if (statement.type === "IfStatement" && literal(statement.test, false) && !statement.alternate) {
      addCanonicalCalls(statement.consequent);
      continue;
    }
    if (statement.type !== "VariableDeclaration") continue;
    for (const declaration of statement.declarations) {
      const call = directCall(declaration.init);
      if (!call || !identifier(call.callee, module.requireName)) continue;
      addCanonicalCall(call);
    }
  }
  assertExactBindingReferences(
    module.factory,
    module.requireName,
    requireDefinition,
    requireReferences,
    `${label} Metro require parameter`,
  );
  assertExactBindingReferences(
    module.factory,
    module.dependencyMapName,
    mapDefinition,
    mapReferences,
    `${label} Metro dependency-map parameter`,
  );
}

function topLevelVariable(module, name, label, { before, includeMembers = false } = {}) {
  const matches = [];
  for (const [statementIndex, statement] of module.factory.body.body.entries()) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declaration of statement.declarations) {
      if (identifier(declaration.id, name)) matches.push({ declaration, statement, statementIndex });
    }
  }
  assert.equal(matches.length, 1, `${label} binding must have one top-level declaration`);
  const match = matches[0];
  assert.equal(match.statement.declarations.length, 1, `${label} binding declaration must be standalone`);
  assert(bindingIsImmutable(module.factory.body, name, match.declaration.id, includeMembers), `${label} binding must be immutable and unshadowed`);
  if (before) {
    const beforeIndex = module.factory.body.body.findIndex((statement) => statement === before || astNodes(statement, (node) => node === before).length === 1);
    assert(beforeIndex >= 0 && match.statementIndex < beforeIndex, `${label} binding must precede its use`);
  }
  return match;
}

function dependencyBinding(module, name, label, before, expectedReferences) {
  assertCanonicalMetroImports(module, label);
  const binding = topLevelVariable(module, name, label, { before, includeMembers: true });
  const call = binding.declaration.init;
  assert(call?.type === "CallExpression" && identifier(call.callee, module.requireName) && call.arguments.length === 1,
    `${label} must be one direct Metro dependency import`);
  const dependencyIndex = dependencyMapIndex(call.arguments[0], module.dependencyMapName);
  assert.notEqual(dependencyIndex, null, `${label} must use the Metro dependency map`);
  assert(module.usedDependencyIndexes.includes(dependencyIndex), `${label} import must be reachable before termination`);
  if (expectedReferences) {
    assertExactBindingReferences(module.factory.body, name, binding.declaration.id, expectedReferences, label);
  }
  return { ...binding, name, dependencyIndex };
}

function canonicalInteropFunction(module, name, label, before, callReference) {
  const fn = functionDeclaration(module, name);
  assert(hasFunctionFlags(fn, false) && fn.params.length === 1 && fn.params[0].type === "Identifier" && fn.body.body.length === 1,
    `${label} interop helper must be one immutable top-level function`);
  const beforeIndex = module.factory.body.body.findIndex((statement) => statement === before || astNodes(statement, (node) => node === before).length === 1);
  const functionIndex = module.factory.body.body.indexOf(fn);
  assert(beforeIndex >= 0 && functionIndex >= 0 && functionIndex < beforeIndex, `${label} interop helper must precede its use`);
  const parameterName = fn.params[0].name;
  const returned = fn.body.body[0].type === "ReturnStatement" ? fn.body.body[0].argument : null;
  const test = returned?.type === "ConditionalExpression" ? returned.test : null;
  const alternate = returned?.type === "ConditionalExpression" ? returned.alternate : null;
  const properties = alternate?.type === "ObjectExpression" ? alternate.properties : [];
  assert(test?.type === "LogicalExpression" && test.operator === "&&" && identifier(test.left, parameterName)
    && test.right.type === "MemberExpression" && !test.right.computed && identifier(test.right.object, parameterName)
    && propertyName(test.right) === "__esModule" && identifier(returned.consequent, parameterName)
    && properties.length === 1 && properties[0].type === "Property" && properties[0].kind === "init"
    && !properties[0].computed && propertyName({ type: "MemberExpression", computed: false, property: properties[0].key }) === "default"
    && identifier(properties[0].value, parameterName), `${label} interop helper is noncanonical`);
  assertExactBindingReferences(module.factory.body, name, fn.id, [callReference], `${label} interop helper`);
  return fn;
}

function namedExportTarget(node, name) {
  const value = unwrapExpression(node);
  if (value?.type !== "MemberExpression" || propertyName(value) !== name) return false;
  return identifier(value.object, "exports") || isModuleExports(value.object);
}

function plainObjectProperty(property, name) {
  return property?.type === "Property" && property.kind === "init" && !property.computed
    && !property.method && !property.shorthand
    && propertyName({ type: "MemberExpression", computed: false, property: property.key }) === name;
}

function namedExportGetterValue(descriptor) {
  if (descriptor?.type !== "ObjectExpression" || descriptor.properties.length !== 2) return null;
  const enumerable = descriptor.properties.find((property) => plainObjectProperty(property, "enumerable"));
  const getterProperty = descriptor.properties.find((property) => plainObjectProperty(property, "get"));
  const getter = getterProperty?.value;
  if (!enumerable || !literal(enumerable.value, true) || !hasFunctionFlags(getter, false)
    || getter.type !== "FunctionExpression" || getter.id !== null || getter.params.length !== 0
    || getter.body.body.length !== 1 || getter.body.body[0].type !== "ReturnStatement"
    || getter.body.body[0].argument?.type !== "Identifier") return null;
  return getter.body.body[0].argument;
}

function finalNamedExport(module, name) {
  let value = null;
  let exportsDetached = false;
  for (const statement of module.factory.body.body) {
    const expression = statement.type === "ExpressionStatement" ? unwrapExpression(statement.expression) : null;
    if (expression?.type === "AssignmentExpression" && expression.operator === "=") {
      if (isModuleExports(expression.left)) {
        value = null;
        exportsDetached = true;
      } else if (namedExportTarget(expression.left, name)) {
        if (!identifier(unwrapExpression(expression.left).object, "exports") || !exportsDetached) value = expression.right;
      }
      continue;
    }
    if (expression?.type !== "CallExpression" || !member(expression.callee, "Object", "defineProperty")
      || !literal(expression.arguments[1], name) || expression.arguments[2]?.type !== "ObjectExpression") continue;
    const target = unwrapExpression(expression.arguments[0]);
    const targetsLiveExports = isModuleExports(target) || (identifier(target, "exports") && !exportsDetached);
    if (!targetsLiveExports) continue;
    value = namedExportGetterValue(expression.arguments[2]);
  }
  return value;
}

function assertClosedExports(module, allowedNames, label) {
  const allowed = new Set(["__esModule", ...allowedNames]);
  const definitions = new Map();
  const moduleReferences = [];
  const exportsReferences = [];
  const exportObject = (node) => {
    const value = unwrapChain(node);
    if (identifier(value, module.exportsName)) return { moduleReference: null, exportsReference: value };
    if (value?.type === "MemberExpression" && identifier(value.object, module.moduleName)
      && propertyName(value) === "exports") return { moduleReference: value.object, exportsReference: null };
    return null;
  };
  for (const statement of module.factory.body.body) {
    const assignment = statement.type === "ExpressionStatement" && statement.expression.type === "AssignmentExpression"
      ? statement.expression : null;
    if (assignment) {
      const target = assignment.left?.type === "MemberExpression" ? exportObject(assignment.left.object) : null;
      if (!target) continue;
      const name = propertyName(assignment.left);
      assert(assignment.operator === "=" && name && allowed.has(name),
        `${label} contains an unrecognized top-level export assignment`);
      if (name === "__esModule") assert(literal(assignment.right, true), `${label} __esModule export assignment is invalid`);
      if (target.moduleReference) moduleReferences.push(target.moduleReference);
      if (target.exportsReference) exportsReferences.push(target.exportsReference);
      definitions.set(name, (definitions.get(name) ?? 0) + 1);
      continue;
    }
    const call = expressionCall(statement);
    const target = call?.arguments.length === 3 ? exportObject(call.arguments[0]) : null;
    if (!call || !target || !member(call.callee, "Object", "defineProperty")) continue;
    const name = call.arguments[1]?.value;
    assert(typeof name === "string" && allowed.has(name) && call.arguments[2]?.type === "ObjectExpression",
      `${label} contains an unrecognized top-level export definition`);
    if (name === "__esModule") {
      const descriptor = call.arguments[2];
      assert(descriptor.properties.length === 1 && plainObjectProperty(descriptor.properties[0], "value")
        && literal(descriptor.properties[0].value, true), `${label} __esModule export descriptor is invalid`);
    } else {
      assert(namedExportGetterValue(call.arguments[2]), `${label} named export getter descriptor is invalid`);
    }
    if (target.moduleReference) moduleReferences.push(target.moduleReference);
    if (target.exportsReference) exportsReferences.push(target.exportsReference);
    definitions.set(name, (definitions.get(name) ?? 0) + 1);
  }
  for (const name of allowed) assert.equal(definitions.get(name), 1, `${label} export ${name} must have one top-level definition`);
  assertExactBindingReferences(
    module.factory,
    module.moduleName,
    module.factory.params[4],
    moduleReferences,
    `${label} module object`,
  );
  assertExactBindingReferences(
    module.factory,
    module.exportsName,
    module.factory.params[5],
    exportsReferences,
    `${label} exports object`,
  );
}

function functionDeclaration(module, name) {
  const declarations = module.factory.body.body.filter((statement) => statement.type === "FunctionDeclaration" && statement.id?.name === name);
  if (declarations.length !== 1) return null;
  return bindingIsImmutable(module.factory.body, name, declarations[0].id) ? declarations[0] : null;
}

function exportedFunction(module, name) {
  const exported = finalNamedExport(module, name);
  return exported?.type === "Identifier" ? functionDeclaration(module, exported.name) : null;
}

function resolveDependency(graph, module, dependencyIndex, label) {
  assert(Number.isSafeInteger(dependencyIndex) && dependencyIndex >= 0, `${label} dependency index is invalid`);
  assert(dependencyIndex < module.dependencies.length, `${label} dependency index is out of range`);
  const moduleId = module.dependencies[dependencyIndex];
  assert.notEqual(moduleId, null, `${label} dependency edge is null`);
  const target = graph.byId.get(moduleId);
  assert(target, `${label} dependency ${moduleId} does not resolve to a defined module`);
  return target;
}

function reachableModules(graph, label) {
  const reachable = new Map();
  const pending = [...graph.roots];
  while (pending.length > 0) {
    const moduleId = pending.pop();
    if (reachable.has(moduleId)) continue;
    const module = graph.byId.get(moduleId);
    assert(module, `${label} reachable module ${moduleId} is undefined`);
    reachable.set(moduleId, module);
    for (const dependencyIndex of module.usedDependencyIndexes) {
      pending.push(resolveDependency(graph, module, dependencyIndex, `${label} module ${moduleId}`).moduleId);
    }
  }
  return reachable;
}

function objectProperties(node, name) {
  if (node?.type !== "ObjectExpression") return [];
  return node.properties.filter((property) => property.type === "Property" && property.kind === "init" && !property.computed
    && propertyName({ type: "MemberExpression", computed: false, property: property.key }) === name);
}

function jsxCall(node) {
  const call = directCall(node);
  const callee = call ? canonicalCallee(call.callee) : null;
  const method = propertyName(callee);
  if (!call || callee?.type !== "MemberExpression" || !["jsx", "jsxs"].includes(method)
    || callee.object.type !== "Identifier" || call.arguments.length !== 2 || call.arguments[1]?.type !== "ObjectExpression") return null;
  return {
    call,
    runtimeName: callee.object.name,
    runtimeReference: callee.object,
    component: call.arguments[0],
    props: call.arguments[1],
  };
}

function renderedComponent(expression, componentName) {
  const matches = [];
  const runtimeReferences = [];
  const matchesComponent = (node) => identifier(node, componentName)
    || node?.type === "MemberExpression" && !node.computed && propertyName(node) === componentName;
  const visit = (value) => {
    if (value?.type === "ArrayExpression") {
      return value.elements.every((element) => element && visit(element));
    }
    const call = directCall(value);
    if (!call) return false;
    const callee = canonicalCallee(call.callee);
    if (matchesComponent(callee)) {
      if (call.arguments.length !== 1 || call.arguments[0]?.type !== "ObjectExpression") return false;
      matches.push({ call, props: call.arguments[0], componentReference: callee });
      return true;
    }
    const jsx = jsxCall(call);
    if (!jsx) return false;
    if (jsx.props.properties.some((property) => property.type !== "Property" || property.kind !== "init" || property.computed)) return false;
    runtimeReferences.push(jsx.runtimeReference);
    if (matchesComponent(jsx.component)) {
      matches.push({ call, props: jsx.props, componentReference: jsx.component });
    }
    const children = objectProperties(jsx.props, "children");
    if (children.length > 1) return false;
    if (children.length === 1 && !visit(children[0].value)) return false;
    return true;
  };
  const validRoot = visit(expression);
  return { matches, runtimeReferences, validRoot };
}

function assertJsxRuntimeBinding(module, renders, before, label) {
  const references = renders.flatMap((render) => render.runtimeReferences);
  const names = new Set(references.map((reference) => reference.name));
  assert(names.size <= 1, `${label} must use one JSX runtime namespace`);
  if (names.size === 1) {
    const [name] = names;
    dependencyBinding(module, name, `${label} JSX runtime`, before, references);
  }
}

function statementAssignment(statement) {
  return statement?.type === "ExpressionStatement" && statement.expression.type === "AssignmentExpression"
    ? statement.expression : null;
}

function hostInstallationEvidence(module, host, label) {
  const hostParameter = host.params.length === 1 && host.params[0].type === "ObjectPattern" ? host.params[0] : null;
  const parameterNames = hostParameter?.properties.map((property) => property.type === "Property"
    && !property.computed && property.key.type === "Identifier" && identifier(property.value, property.key.name)
    ? property.key.name : null);
  if (!hostParameter || hostParameter.properties.length !== 2
    || parameterNames[0] !== "installFaults" || parameterNames[1] !== "children"
    || host.body.body.length !== 4) return null;

  const useState = [];
  const useEffects = [];
  for (const [statementIndex, statement] of host.body.body.entries()) {
    if (statement.type === "VariableDeclaration") {
      for (const declaration of statement.declarations) {
        const call = directCall(declaration.init);
        const callee = call ? canonicalCallee(call.callee) : null;
        if (callee?.type === "MemberExpression" && callee.object.type === "Identifier" && propertyName(callee) === "useState") {
          useState.push({ call, runtimeReference: callee.object, declaration, statementIndex });
        }
      }
    }
    const call = expressionCall(statement);
    const callee = call ? canonicalCallee(call.callee) : null;
    if (callee?.type === "MemberExpression" && callee.object.type === "Identifier" && propertyName(callee) === "useEffect") {
      useEffects.push({ call, runtimeReference: callee.object, statementIndex });
    }
  }
  if (useState.length !== 1 || useEffects.length !== 1) return null;
  const state = useState[0];
  if (state.statementIndex !== 0 || useEffects[0].statementIndex !== 1
    || state.declaration.id.type !== "ArrayPattern" || state.declaration.id.elements.length !== 2
    || state.declaration.id.elements.some((element) => element?.type !== "Identifier")
    || state.call.arguments.length !== 1 || !literal(state.call.arguments[0], null)) return null;
  const [setupError, setSetupError] = state.declaration.id.elements;
  const setupGuard = host.body.body[2];
  const childrenReturn = host.body.body[3];
  if (setupGuard.type !== "IfStatement" || setupGuard.alternate || !identifier(setupGuard.test, setupError.name)
    || setupGuard.consequent.type !== "ThrowStatement" || !identifier(setupGuard.consequent.argument, setupError.name)
    || childrenReturn.type !== "ReturnStatement" || !identifier(childrenReturn.argument, "children")) return null;
  const effectCall = useEffects[0].call;
  const effect = effectCall.arguments[0];
  const dependencies = effectCall.arguments[1];
  if (useEffects[0].runtimeReference.name !== state.runtimeReference.name || effectCall.arguments.length !== 2
    || effect?.type !== "ArrowFunctionExpression" || !hasFunctionFlags(effect, false) || effect.params.length !== 0
    || effect.body.type !== "BlockStatement" || dependencies?.type !== "ArrayExpression"
    || dependencies.elements.length !== 1 || !identifier(dependencies.elements[0], "installFaults")) return null;

  const body = effect.body.body;
  if (body.length !== 5) return null;
  const activeDeclaration = standaloneVariable(body[0], "active");
  const disposeDeclaration = standaloneVariable(body[1], "dispose");
  const abortDeclaration = standaloneVariable(body[2], "abortController");
  const disposeInitializer = disposeDeclaration?.init;
  const abortInitializer = abortDeclaration?.init;
  if (!activeDeclaration || !literal(activeDeclaration.init, true)
    || !disposeDeclaration || disposeInitializer?.type !== "ArrowFunctionExpression"
    || !hasFunctionFlags(disposeInitializer, false) || disposeInitializer.params.length !== 0
    || disposeInitializer.body.type !== "BlockStatement" || disposeInitializer.body.body.length !== 0
    || !abortDeclaration || abortInitializer?.type !== "NewExpression" || !identifier(abortInitializer.callee, "AbortController")
    || abortInitializer.arguments.length !== 0) return null;
  const abortControllerReferences = astNodes(module.factory.body, (node, parent) => identifier(node, "AbortController")
    && isIdentifierReference(node, parent));
  if (abortControllerReferences.length !== 1 || abortControllerReferences[0] !== abortInitializer.callee
    || bindingDefinitions(module.factory.body, "AbortController").length !== 0
    || bindingWrites(module.factory.body, "AbortController").length !== 0) return null;

  const installExpression = body[3]?.type === "ExpressionStatement" ? body[3].expression : null;
  const catchCall = installExpression?.type === "UnaryExpression" && installExpression.operator === "void"
    ? directCall(installExpression.argument) : null;
  const catchCallee = catchCall ? canonicalCallee(catchCall.callee) : null;
  const thenCall = catchCallee?.type === "MemberExpression" && propertyName(catchCallee) === "catch"
    ? directCall(catchCallee.object) : null;
  const thenCallee = thenCall ? canonicalCallee(thenCall.callee) : null;
  const installCall = thenCallee?.type === "MemberExpression" && propertyName(thenCallee) === "then"
    ? directCall(thenCallee.object) : null;
  const onFault = installCall?.arguments[0];
  const signal = installCall?.arguments[1];
  const thenCallback = thenCall?.arguments[0];
  const catchCallback = catchCall?.arguments[0];
  if (!catchCall || catchCall.arguments.length !== 1 || catchCallback?.type !== "ArrowFunctionExpression"
    || !hasFunctionFlags(catchCallback, false) || catchCallback.params.length !== 1 || catchCallback.body.type !== "BlockStatement"
    || catchCallback.body.body.length !== 1 || catchCallback.body.body[0].type !== "IfStatement"
    || !identifier(catchCallback.body.body[0].test, "active") || catchCallback.body.body[0].alternate
    || !thenCall || thenCall.arguments.length !== 1 || thenCallback?.type !== "ArrowFunctionExpression"
    || !hasFunctionFlags(thenCallback, false) || thenCallback.params.length !== 1 || thenCallback.params[0].type !== "Identifier"
    || thenCallback.body.type !== "BlockStatement" || thenCallback.body.body.length !== 1
    || !installCall || !identifier(installCall.callee, "installFaults") || installCall.arguments.length !== 2
    || onFault?.type !== "ArrowFunctionExpression" || !hasFunctionFlags(onFault, false) || onFault.body.type !== "BlockStatement"
    || signal?.type !== "MemberExpression" || signal.computed || !identifier(signal.object, "abortController")
    || propertyName(signal) !== "signal") return null;

  const installedDisposeName = thenCallback.params[0].name;
  const installedFlow = thenCallback.body.body[0];
  const assignDispose = installedFlow?.type === "IfStatement" ? statementAssignment(installedFlow.consequent) : null;
  const disposeLate = installedFlow?.type === "IfStatement" ? expressionCall(installedFlow.alternate) : null;
  const catchFlow = catchCallback.body.body[0];
  const setErrorCall = expressionCall(catchFlow.consequent);
  if (installedFlow?.type !== "IfStatement" || !identifier(installedFlow.test, "active") || !installedFlow.alternate
    || !assignDispose || assignDispose.operator !== "=" || !identifier(assignDispose.left, "dispose")
    || !identifier(assignDispose.right, installedDisposeName) || !disposeLate
    || !identifier(canonicalCallee(disposeLate.callee), installedDisposeName) || disposeLate.arguments.length !== 0
    || !setErrorCall || !identifier(canonicalCallee(setErrorCall.callee), setSetupError.name)
    || setErrorCall.arguments.length !== 1) return null;

  const cleanupReturn = body[4];
  const cleanup = cleanupReturn?.type === "ReturnStatement" ? cleanupReturn.argument : null;
  if (cleanup?.type !== "ArrowFunctionExpression" || !hasFunctionFlags(cleanup, false) || cleanup.params.length !== 0
    || cleanup.body.type !== "BlockStatement" || cleanup.body.body.length !== 3) return null;
  const deactivate = statementAssignment(cleanup.body.body[0]);
  const abortCall = expressionCall(cleanup.body.body[1]);
  const disposeCall = expressionCall(cleanup.body.body[2]);
  if (!deactivate || deactivate.operator !== "=" || !identifier(deactivate.left, "active") || !literal(deactivate.right, false)
    || !abortCall || !callOnIdentifier(abortCall, "abortController", "abort") || abortCall.arguments.length !== 0
    || !disposeCall || !identifier(canonicalCallee(disposeCall.callee), "dispose") || disposeCall.arguments.length !== 0) return null;

  assertExactReferences(
    effect,
    "active",
    activeDeclaration.id,
    [installedFlow.test, catchFlow.test, deactivate.left],
    `${label} host active state`,
  );
  const activeWrites = bindingWrites(effect, "active");
  assert(activeWrites.length === 1 && activeWrites[0] === deactivate, `${label} host active writes are invalid`);
  assertExactReferences(effect, "dispose", disposeDeclaration.id, [assignDispose.left, disposeCall.callee], `${label} host disposer`);
  const disposeWrites = bindingWrites(effect, "dispose");
  assert(disposeWrites.length === 1 && disposeWrites[0] === assignDispose, `${label} host disposer writes are invalid`);
  assertExactBindingReferences(
    effect,
    "abortController",
    abortDeclaration.id,
    [signal.object, canonicalCallee(abortCall.callee).object],
    `${label} host AbortController`,
  );
  assertExactBindingReferences(
    thenCallback,
    installedDisposeName,
    thenCallback.params[0],
    [assignDispose.right, canonicalCallee(disposeLate.callee)],
    `${label} installed disposer`,
  );
  assertExactBindingReferences(
    host,
    "installFaults",
    hostParameter,
    [dependencies.elements[0], installCall.callee],
    `${label} host installFaults`,
  );
  assertExactBindingReferences(
    host,
    setupError.name,
    state.declaration.id,
    [setupGuard.test, setupGuard.consequent.argument],
    `${label} host setup error`,
  );
  assertExactBindingReferences(
    host,
    setSetupError.name,
    state.declaration.id,
    [canonicalCallee(setErrorCall.callee)],
    `${label} host setup error setter`,
  );
  assertExactBindingReferences(
    host,
    "children",
    hostParameter,
    [childrenReturn.argument],
    `${label} host children`,
  );
  return {
    runtimeName: state.runtimeReference.name,
    runtimeReferences: [state.runtimeReference, useEffects[0].runtimeReference],
  };
}

function cleanupFailureEvidence(module, label) {
  const helperLabel = `${label} cleanup failure dependency`;
  const scope = module.factory.body;
  const logicalOperands = (node, operator) => node?.type === "LogicalExpression" && node.operator === operator
    ? [...logicalOperands(node.left, operator), ...logicalOperands(node.right, operator)] : [node];
  const property = (object, name) => object?.type === "ObjectExpression"
    ? object.properties.find((candidate) => plainObjectProperty(candidate, name)) : null;
  const memberOn = (node, objectName, propertyNameValue) => {
    const value = unwrapChain(node);
    return value?.type === "MemberExpression" && identifier(value.object, objectName)
      && propertyName(value) === propertyNameValue ? value : null;
  };

  assertClosedExports(module, ["cleanupFailure", "isCleanupFailure"], helperLabel);
  assertCanonicalMetroImports(module, helperLabel);
  assertNoGlobalObjectReferences(module, helperLabel);
  assertPristineIntrinsics(module, helperLabel);
  for (const name of ["console", "JSON", "fetch", "XMLHttpRequest", "WebSocket", "navigator", "network", "output"]) {
    assert.equal(astNodes(scope, (node) => identifier(node, name)).length, 0,
      `${helperLabel} must not reference ${name}`);
  }

  const marker = topLevelVariable(module, "CLEANUP_FAILURE_MARKER", `${helperLabel} marker`);
  assert(literal(marker.declaration.init, "fawn.cleanup-failure.v1"), `${helperLabel} marker is invalid`);

  const create = exportedFunction(module, "cleanupFailure");
  assert(hasFunctionFlags(create, false) && create.params.length === 2
    && create.params.every((parameter) => parameter.type === "Identifier") && create.body.body.length === 3,
  `${helperLabel} cleanupFailure export must be one synchronous two-parameter function`);
  const [errorsParameter, messageParameter] = create.params;
  const failure = standaloneVariable(create.body.body[0], "failure");
  const aggregate = failure?.init;
  const define = expressionCall(create.body.body[1]);
  const defineIntrinsic = directIntrinsicCall(define, "Object", "defineProperty", 3);
  const descriptor = define?.arguments[2];
  const configurable = property(descriptor, "configurable");
  const enumerable = property(descriptor, "enumerable");
  const markerProperty = property(descriptor, "value");
  const writable = property(descriptor, "writable");
  const returnedFailure = create.body.body[2]?.type === "ReturnStatement" ? create.body.body[2].argument : null;
  assert(failure && aggregate?.type === "NewExpression" && identifier(aggregate.callee, "AggregateError")
    && aggregate.arguments.length === 2 && identifier(aggregate.arguments[0], errorsParameter.name)
    && identifier(aggregate.arguments[1], messageParameter.name)
    && defineIntrinsic && identifier(define.arguments[0], "failure") && literal(define.arguments[1], "cleanupFailure")
    && descriptor?.type === "ObjectExpression" && descriptor.properties.length === 4
    && configurable && literal(configurable.value, false)
    && enumerable && literal(enumerable.value, false)
    && markerProperty && identifier(markerProperty.value, "CLEANUP_FAILURE_MARKER")
    && writable && literal(writable.value, false)
    && identifier(returnedFailure, "failure"),
  `${helperLabel} cleanupFailure construction must use the exact non-enumerable fixed marker`);
  assertExactBindingReferences(create, errorsParameter.name, errorsParameter, [aggregate.arguments[0]], `${helperLabel} errors parameter`);
  assertExactBindingReferences(create, messageParameter.name, messageParameter, [aggregate.arguments[1]], `${helperLabel} message parameter`);
  assertExactBindingReferences(create, "failure", failure.id, [define.arguments[0], returnedFailure], `${helperLabel} created failure`);

  const classify = exportedFunction(module, "isCleanupFailure");
  assert(hasFunctionFlags(classify, false) && classify.params.length === 1 && classify.params[0].type === "Identifier"
    && classify.body.body.length === 3, `${helperLabel} isCleanupFailure export must be one synchronous one-parameter function`);
  const valueParameter = classify.params[0];
  const guard = classify.body.body[0];
  const guardChecks = guard?.type === "IfStatement" ? logicalOperands(guard.test, "||") : [];
  const typeCheck = guardChecks.find((node) => node.type === "BinaryExpression" && node.operator === "!=="
    && node.left.type === "UnaryExpression" && node.left.operator === "typeof"
    && identifier(node.left.argument, valueParameter.name) && literal(node.right, "object"));
  const nullCheck = guardChecks.find((node) => node.type === "BinaryExpression" && node.operator === "==="
    && identifier(node.left, valueParameter.name) && literal(node.right, null));
  assert(guardChecks.length === 2 && typeCheck && nullCheck && !guard.alternate
    && guard.consequent.type === "ReturnStatement" && literal(guard.consequent.argument, false),
  `${helperLabel} isCleanupFailure input guard is invalid`);
  const descriptorBinding = standaloneVariable(classify.body.body[1], "descriptor");
  const descriptorCall = directIntrinsicCall(descriptorBinding?.init, "Object", "getOwnPropertyDescriptor", 2);
  assert(descriptorCall && identifier(descriptorCall.call.arguments[0], valueParameter.name)
    && literal(descriptorCall.call.arguments[1], "cleanupFailure"),
  `${helperLabel} isCleanupFailure must read only the fixed own marker descriptor`);
  const markerReturn = classify.body.body[2];
  const markerChecks = markerReturn?.type === "ReturnStatement" ? logicalOperands(markerReturn.argument, "&&") : [];
  const descriptorCheck = (node, field, expected) => node.type === "BinaryExpression" && node.operator === "==="
    && memberOn(node.left, "descriptor", field) && (expected === "marker"
      ? identifier(node.right, "CLEANUP_FAILURE_MARKER") : literal(node.right, expected));
  const valueCheck = markerChecks.find((node) => descriptorCheck(node, "value", "marker"));
  const configurableCheck = markerChecks.find((node) => descriptorCheck(node, "configurable", false));
  const enumerableCheck = markerChecks.find((node) => descriptorCheck(node, "enumerable", false));
  const writableCheck = markerChecks.find((node) => descriptorCheck(node, "writable", false));
  assert(markerChecks.length === 4 && valueCheck && configurableCheck && enumerableCheck && writableCheck,
    `${helperLabel} isCleanupFailure marker classifier is not exact`);
  const descriptorReferences = [valueCheck, configurableCheck, enumerableCheck, writableCheck]
    .map((check) => unwrapChain(check.left).object);
  assertExactBindingReferences(classify, valueParameter.name, valueParameter,
    [typeCheck.left.argument, nullCheck.left, descriptorCall.call.arguments[0]], `${helperLabel} classified value`);
  assertExactBindingReferences(classify, "descriptor", descriptorBinding.id, descriptorReferences,
    `${helperLabel} marker descriptor`);

  const createExport = finalNamedExport(module, "cleanupFailure");
  const classifyExport = finalNamedExport(module, "isCleanupFailure");
  assertExactBindingReferences(scope, create.id.name, create.id, [createExport], `${helperLabel} cleanupFailure final export`);
  assertExactBindingReferences(scope, classify.id.name, classify.id, [classifyExport], `${helperLabel} isCleanupFailure final export`);
  assertExactBindingReferences(scope, "CLEANUP_FAILURE_MARKER", marker.declaration.id,
    [markerProperty.value, valueCheck.right], `${helperLabel} fixed marker`);
  const exportCalls = astNodes(scope, (node) => directIntrinsicCall(node, "Object", "defineProperty", 3)?.call === node
    && identifier(node.arguments[0], module.exportsName));
  assertExactSelectedIntrinsicReferences(module, {
    Object: [...exportCalls.map((call) => directIntrinsicCall(call, "Object", "defineProperty", 3).object), defineIntrinsic.object, descriptorCall.object],
    AggregateError: [aggregate.callee],
    Error: [],
    Reflect: [],
  }, helperLabel);
}

function recoverAndOpenEvidence(module, graph, label) {
  const recoveryLabel = `${label} recoverAndOpen dependency`;
  const recoveryScope = module.factory.body;
  const exactObject = (object, fields) => object?.type === "ObjectExpression"
    && object.properties.length === fields.length
    && fields.every(([name, predicate], index) => {
      const item = object.properties[index];
      return item?.type === "Property" && item.kind === "init" && !item.computed
        && propertyName({ type: "MemberExpression", computed: false, property: item.key }) === name
        && predicate(item.value);
    });
  const directIdentifierCall = (node, name, argumentCount) => {
    const call = directCall(node);
    return call && identifier(canonicalCallee(call.callee), name) && call.arguments.length === argumentCount ? call : null;
  };
  const logicalOperands = (node, operator) => node?.type === "LogicalExpression" && node.operator === operator
    ? [...logicalOperands(node.left, operator), ...logicalOperands(node.right, operator)] : [node];
  const memberOn = (node, objectName, field) => {
    const value = unwrapChain(node);
    return value?.type === "MemberExpression" && identifier(value.object, objectName)
      && propertyName(value) === field ? value : null;
  };
  const traceMember = (node, dependenciesName) => {
    const value = unwrapChain(node);
    return value?.type === "MemberExpression" && propertyName(value) === "traceTerminal"
      && identifier(value.object, dependenciesName) ? value : null;
  };
  const undefinedTest = (node, name) => node?.type === "BinaryExpression" && node.operator === "==="
    && ((identifier(node.left, name) && identifier(node.right, "undefined"))
      || (identifier(node.right, name) && identifier(node.left, "undefined")));
  const record = (node, stage, outcome, closeOutcome) => exactObject(node, [
    ["stage", (value) => stage === null ? value?.type === "Identifier" : literal(value, stage)],
    ["outcome", (value) => literal(value, outcome)],
    ["closeOutcome", (value) => literal(value, closeOutcome)],
  ]);

  assertClosedExports(module, ["recoverAndOpen"], recoveryLabel);
  assertCanonicalMetroImports(module, recoveryLabel);
  assertNoGlobalObjectReferences(module, recoveryLabel);
  assertPristineIntrinsics(module, recoveryLabel);
  for (const name of ["console", "JSON", "fetch", "XMLHttpRequest", "WebSocket", "navigator", "network", "output"]) {
    const references = astNodes(recoveryScope, (node) => identifier(node, name));
    assert.equal(references.length, 0, `${recoveryLabel} must not reference ${name}`);
  }
  const rawErrorMembers = astNodes(recoveryScope, (node) => node.type === "MemberExpression"
    && ["message", "stack", "cause", "code"].includes(propertyName(node)));
  assert.equal(rawErrorMembers.length, 0,
    `${recoveryLabel} must not project raw error message, stack, cause, or code fields`);
  const parentByNode = new Map();
  walkAst(recoveryScope, (node, parent) => parentByNode.set(node, parent));
  const importBindings = recoveryScope.body.flatMap((statement) => statement.type === "VariableDeclaration"
    ? statement.declarations.filter((declaration) => declaration.id.type === "Identifier"
      && directCall(declaration.init)?.callee?.type === "Identifier"
      && directCall(declaration.init).callee.name === module.requireName)
    : []);
  for (const binding of importBindings) {
    const references = bindingReferences(recoveryScope, binding.id.name, binding.id);
    assert(references.every((reference) => {
      const parent = parentByNode.get(reference);
      return parent?.type === "MemberExpression" && parent.object === reference && !parent.computed;
    }), `${recoveryLabel} imported namespace ${binding.id.name} must not escape through an alias`);
  }
  const recovery = exportedFunction(module, "recoverAndOpen");
  assert(hasFunctionFlags(recovery, true) && recovery.params.length === 2
    && recovery.params.every((parameter) => parameter.type === "Identifier"),
  `${recoveryLabel} final export must be one async two-parameter function`);
  const dependenciesName = recovery.params[0].name;
  const signalName = recovery.params[1].name;
  assert(bindingIsImmutable(recovery, dependenciesName, recovery.params[0])
    && bindingIsImmutable(recovery, signalName, recovery.params[1]),
  `${recoveryLabel} parameters must be immutable`);

  const category = functionDeclaration(module, "failureCategory");
  assert(hasFunctionFlags(category, false) && category.params.length === 1 && category.params[0].type === "Identifier"
    && category.body.body.length === 2, `${recoveryLabel} failure category classifier is invalid`);
  const categoryError = category.params[0];
  const categoryTry = category.body.body[0];
  const categoryFallback = category.body.body[1];
  assert(categoryTry?.type === "TryStatement" && !categoryTry.finalizer && categoryTry.handler?.param === null
    && categoryTry.block.body.length === 6 && categoryTry.handler.body.body.length === 1
    && categoryTry.handler.body.body[0].type === "ReturnStatement"
    && literal(categoryTry.handler.body.body[0].argument, "uncoded")
    && categoryFallback.type === "ReturnStatement" && literal(categoryFallback.argument, "uncoded"),
  `${recoveryLabel} failure category classifier must fail closed to uncoded`);
  const [cleanupBranch, abortBranch, codeStatement, openCodeBranch, sqliteCodeBranch, aggregateBranch] = categoryTry.block.body;
  const cleanupCall = cleanupBranch?.type === "IfStatement" ? directCall(cleanupBranch.test) : null;
  const cleanupCallee = cleanupCall ? canonicalCallee(cleanupCall.callee) : null;
  assert(cleanupCall && cleanupCallee?.type === "MemberExpression" && !cleanupCallee.computed
    && cleanupCallee.object.type === "Identifier" && propertyName(cleanupCallee) === "isCleanupFailure"
    && cleanupCall.arguments.length === 1 && identifier(cleanupCall.arguments[0], categoryError.name)
    && cleanupBranch.consequent.type === "ReturnStatement" && literal(cleanupBranch.consequent.argument, "cleanup")
    && !cleanupBranch.alternate, `${recoveryLabel} cleanup category branch is invalid`);
  const abortChecks = abortBranch?.type === "IfStatement" ? logicalOperands(abortBranch.test, "&&") : [];
  const errorInstance = abortChecks.find((node) => node.type === "BinaryExpression" && node.operator === "instanceof"
    && identifier(node.left, categoryError.name) && identifier(node.right, "Error"));
  const abortName = abortChecks.find((node) => node.type === "BinaryExpression" && node.operator === "==="
    && memberOn(node.left, categoryError.name, "name") && literal(node.right, "AbortError"));
  assert(abortChecks.length === 2 && errorInstance && abortName && abortBranch.consequent.type === "ReturnStatement"
    && literal(abortBranch.consequent.argument, "abort") && !abortBranch.alternate,
  `${recoveryLabel} abort category branch is invalid`);
  const code = standaloneVariable(codeStatement, "code");
  const codeConditional = code?.init;
  const codeGuards = codeConditional?.type === "ConditionalExpression" ? logicalOperands(codeConditional.test, "&&") : [];
  const objectGuard = codeGuards.find((node) => node.type === "BinaryExpression" && node.operator === "==="
    && node.left.type === "UnaryExpression" && node.left.operator === "typeof"
    && identifier(node.left.argument, categoryError.name) && literal(node.right, "object"));
  const nullGuard = codeGuards.find((node) => node.type === "BinaryExpression" && node.operator === "!=="
    && identifier(node.left, categoryError.name) && literal(node.right, null));
  const ownCodeGuard = codeGuards.find((node) => node.type === "BinaryExpression" && node.operator === "in"
    && literal(node.left, "code") && identifier(node.right, categoryError.name));
  const reflectGet = directIntrinsicCall(codeConditional?.consequent, "Reflect", "get", 2);
  assert(codeGuards.length === 3 && objectGuard && nullGuard && ownCodeGuard && reflectGet
    && identifier(reflectGet.call.arguments[0], categoryError.name) && literal(reflectGet.call.arguments[1], "code")
    && identifier(codeConditional.alternate, "undefined"),
  `${recoveryLabel} SQLite code extraction must use the exact guarded Reflect.get path`);
  const categoryReturn = (branch, codeValue, result) => branch?.type === "IfStatement" && !branch.alternate
    && branch.test.type === "BinaryExpression" && branch.test.operator === "==="
    && identifier(branch.test.left, "code") && literal(branch.test.right, codeValue)
    && branch.consequent.type === "ReturnStatement" && literal(branch.consequent.argument, result);
  assert(categoryReturn(openCodeBranch, "E_SQLITE_OPEN_DATABASE", "sqlite-open")
    && categoryReturn(sqliteCodeBranch, "ERR_INTERNAL_SQLITE_ERROR", "sqlite"),
  `${recoveryLabel} SQLite category allowlist is invalid`);
  const aggregateInstance = aggregateBranch?.type === "IfStatement" ? aggregateBranch.test : null;
  assert(aggregateInstance?.type === "BinaryExpression" && aggregateInstance.operator === "instanceof"
    && identifier(aggregateInstance.left, categoryError.name) && identifier(aggregateInstance.right, "AggregateError")
    && aggregateBranch.consequent.type === "ReturnStatement" && literal(aggregateBranch.consequent.argument, "aggregate")
    && !aggregateBranch.alternate, `${recoveryLabel} aggregate category branch is invalid`);
  assertExactBindingReferences(category, categoryError.name, categoryError, [
    cleanupCall.arguments[0], errorInstance.left, unwrapChain(abortName.left).object,
    objectGuard.left.argument, nullGuard.left, ownCodeGuard.right, reflectGet.call.arguments[0], aggregateInstance.left,
  ], `${recoveryLabel} classified error`);
  assertExactBindingReferences(category, "code", code.id, [openCodeBranch.test.left, sqliteCodeBranch.test.left],
    `${recoveryLabel} classified SQLite code`);

  const abortError = functionDeclaration(module, "abortError");
  assert(hasFunctionFlags(abortError, false) && abortError.params.length === 0 && abortError.body.body.length === 3,
    `${recoveryLabel} abort error helper is invalid`);
  const createdAbort = standaloneVariable(abortError.body.body[0], "error");
  const abortConstructor = createdAbort?.init;
  const abortNameWrite = abortError.body.body[1]?.type === "ExpressionStatement"
    ? abortError.body.body[1].expression : null;
  const abortReturn = abortError.body.body[2]?.type === "ReturnStatement" ? abortError.body.body[2].argument : null;
  assert(abortConstructor?.type === "NewExpression" && identifier(abortConstructor.callee, "Error")
    && abortConstructor.arguments.length === 1 && literal(abortConstructor.arguments[0], "Startup was aborted")
    && abortNameWrite?.type === "AssignmentExpression" && abortNameWrite.operator === "="
    && memberOn(abortNameWrite.left, "error", "name") && literal(abortNameWrite.right, "AbortError")
    && identifier(abortReturn, "error"), `${recoveryLabel} abort error helper construction is invalid`);
  assertExactReferences(abortError, "error", createdAbort.id,
    [unwrapChain(abortNameWrite.left).object, abortReturn], `${recoveryLabel} abort error helper value`);

  const emitTerminal = functionDeclaration(module, "emitTerminal");
  assert(hasFunctionFlags(emitTerminal, false) && emitTerminal.params.length === 2
    && emitTerminal.params.every((parameter) => parameter.type === "Identifier")
    && emitTerminal.body.body.length === 1,
  `${recoveryLabel} terminal helper is invalid`);
  const [sinkParameter, recordParameter] = emitTerminal.params;
  const sinkTry = emitTerminal.body.body[0];
  const sinkCall = sinkTry?.type === "TryStatement" && sinkTry.block.body.length === 1
    ? expressionCall(sinkTry.block.body[0]) : null;
  assert(sinkCall && identifier(canonicalCallee(sinkCall.callee), sinkParameter.name)
    && sinkCall.arguments.length === 1 && identifier(sinkCall.arguments[0], recordParameter.name)
    && !sinkTry.finalizer && sinkTry.handler?.body.body.length === 0,
  `${recoveryLabel} terminal helper must synchronously contain the selected sink`);
  assertExactBindingReferences(emitTerminal, sinkParameter.name, sinkParameter, [canonicalCallee(sinkCall.callee)],
    `${recoveryLabel} terminal helper sink`);
  assertExactBindingReferences(emitTerminal, recordParameter.name, recordParameter, [sinkCall.arguments[0]],
    `${recoveryLabel} terminal helper record`);

  const emitFailureTerminal = functionDeclaration(module, "emitFailureTerminal");
  assert(hasFunctionFlags(emitFailureTerminal, false) && emitFailureTerminal.params.length === 3
    && emitFailureTerminal.params.every((parameter) => parameter.type === "Identifier")
    && emitFailureTerminal.body.body.length === 2,
  `${recoveryLabel} failure terminal helper is invalid`);
  const [failureSink, failureRecord, failureError] = emitFailureTerminal.params;
  const failureGuard = emitFailureTerminal.body.body[0];
  const failureHelperCall = expressionCall(emitFailureTerminal.body.body[1]);
  const failureObject = failureHelperCall?.arguments[1];
  const failureCategoryProperty = failureObject?.type === "ObjectExpression" ? failureObject.properties[1] : null;
  const categoryCall = failureCategoryProperty?.type === "Property" ? directIdentifierCall(failureCategoryProperty.value, "failureCategory", 1) : null;
  const failureSinkGuardReference = failureGuard?.type === "IfStatement" && identifier(failureGuard.test?.left, failureSink.name)
    ? failureGuard.test.left
    : failureGuard?.type === "IfStatement" && identifier(failureGuard.test?.right, failureSink.name)
      ? failureGuard.test.right
      : null;
  assert(failureGuard?.type === "IfStatement" && !failureGuard.alternate
    && undefinedTest(failureGuard.test, failureSink.name)
    && failureGuard.consequent.type === "ReturnStatement" && failureGuard.consequent.argument === null
    && failureHelperCall && identifier(canonicalCallee(failureHelperCall.callee), "emitTerminal")
    && failureHelperCall.arguments.length === 2 && identifier(failureHelperCall.arguments[0], failureSink.name)
    && failureObject?.type === "ObjectExpression" && failureObject.properties.length === 2
    && failureObject.properties[0].type === "SpreadElement" && identifier(failureObject.properties[0].argument, failureRecord.name)
    && failureCategoryProperty?.type === "Property" && !failureCategoryProperty.computed
    && propertyName({ type: "MemberExpression", computed: false, property: failureCategoryProperty.key }) === "failureCategory"
    && categoryCall && identifier(categoryCall.arguments[0], failureError.name),
  `${recoveryLabel} failure terminal helper must add only the classified category`);
  assertExactBindingReferences(
    emitFailureTerminal,
    failureSink.name,
    failureSink,
    [failureSinkGuardReference, failureHelperCall.arguments[0]],
    `${recoveryLabel} failure terminal sink`,
  );
  assertExactBindingReferences(
    emitFailureTerminal,
    failureRecord.name,
    failureRecord,
    [failureObject.properties[0].argument],
    `${recoveryLabel} failure terminal record`,
  );
  assertExactBindingReferences(
    emitFailureTerminal,
    failureError.name,
    failureError,
    [categoryCall.arguments[0]],
    `${recoveryLabel} failure terminal error`,
  );
  const failureCategory = functionDeclaration(module, "failureCategory");
  assertExactBindingReferences(
    recoveryScope,
    "failureCategory",
    failureCategory.id,
    [canonicalCallee(categoryCall.callee)],
    `${recoveryLabel} failure category helper`,
  );

  const cleanupNamespace = cleanupCallee.object.name;
  const cleanupApiCalls = astNodes(recoveryScope, (node) => {
    if (node.type !== "CallExpression") return false;
    const callee = canonicalCallee(node.callee);
    return callee?.type === "MemberExpression" && !callee.computed
      && identifier(callee.object, cleanupNamespace)
      && ["cleanupFailure", "isCleanupFailure"].includes(propertyName(callee));
  });
  const cleanupCalls = cleanupApiCalls.filter((call) => propertyName(canonicalCallee(call.callee)) === "cleanupFailure");
  const cleanupChecks = cleanupApiCalls.filter((call) => propertyName(canonicalCallee(call.callee)) === "isCleanupFailure");
  assert(cleanupApiCalls.length === 3 && cleanupCalls.length === 2 && cleanupChecks.length === 1
    && cleanupChecks[0] === cleanupCall,
  `${recoveryLabel} cleanup dependency calls are not exact`);
  const runtimeCleanup = cleanupCalls.find((call) => call.arguments.length === 2
    && call.arguments[0]?.type === "ArrayExpression" && call.arguments[0].elements.length === 1
    && literal(call.arguments[1], "Closing the application database failed"));
  assert(runtimeCleanup && runtimeCleanup.arguments[0].elements[0]?.type === "Identifier",
    `${recoveryLabel} runtime cleanup failure construction is invalid`);
  const cleanupBinding = dependencyBinding(
    module,
    cleanupNamespace,
    `${recoveryLabel} cleanup helper dependency`,
    recovery,
    cleanupApiCalls.map((call) => canonicalCallee(call.callee).object),
  );
  const cleanupModule = resolveDependency(graph, module, cleanupBinding.dependencyIndex,
    `${recoveryLabel} cleanup helper dependency`);
  cleanupFailureEvidence(cleanupModule, label);
  assertExactSelectedIntrinsicReferences(module, {
    Reflect: [reflectGet.object],
    Error: [errorInstance.right, abortConstructor.callee],
    AggregateError: [aggregateInstance.right],
  }, recoveryLabel);

  const topLevelTry = recovery.body.body.filter((statement) => statement.type === "TryStatement");
  assert.equal(topLevelTry.length, 1, `${recoveryLabel} must have one startup try/catch`);
  const startupTry = topLevelTry[0];
  const startupError = startupTry.handler?.param;
  assert(startupError?.type === "Identifier" && !startupTry.finalizer, `${recoveryLabel} startup catch is invalid`);
  const readyCalls = astNodes(startupTry.block, (node) => directIdentifierCall(node, "emitTerminal", 2) === node);
  assert.equal(readyCalls.length, 1, `${recoveryLabel} must emit one ready terminal`);
  const readyCall = readyCalls[0];
  const readySink = traceMember(readyCall.arguments[0], dependenciesName);
  assert(readySink && record(readyCall.arguments[1], "ready", "success", "not-attempted"),
    `${recoveryLabel} ready terminal is not correlated`);
  const readyStatementIndex = startupTry.block.body.findIndex((statement) => expressionCall(statement) === readyCall);
  assert(readyStatementIndex === startupTry.block.body.length - 2
    && startupTry.block.body.at(-1)?.type === "ReturnStatement",
  `${recoveryLabel} ready terminal must immediately precede the successful return`);

  const stageDeclarations = astNodes(recovery.body, (node) => node.type === "VariableDeclarator" && identifier(node.id, "stage"));
  assert.equal(stageDeclarations.length, 1, `${recoveryLabel} stage binding must be unique`);
  const stage = stageDeclarations[0];
  assert(literal(stage.init, "open-configure"), `${recoveryLabel} stage must start at open-configure`);
  const stageWrites = astNodes(recovery.body, (node) => node.type === "AssignmentExpression"
    && node.operator === "=" && identifier(node.left, "stage"));
  assert(stageWrites.length === 2 && literal(stageWrites[0].right, "migrate")
    && literal(stageWrites[1].right, "post-migrate"),
  `${recoveryLabel} stage must have only the migrate and post-migrate transitions`);
  const tryStatements = startupTry.block.body;
  const awaitedCall = (statement) => statement?.type === "ExpressionStatement"
    && statement.expression.type === "AwaitExpression" ? directCall(statement.expression.argument) : null;
  const openIndex = tryStatements.findIndex((statement) => {
    const assignment = statement?.type === "ExpressionStatement" ? statement.expression : null;
    const call = assignment?.type === "AssignmentExpression" && assignment.operator === "="
      && assignment.right.type === "AwaitExpression" ? directCall(assignment.right.argument) : null;
    const callee = call ? canonicalCallee(call.callee) : null;
    return identifier(assignment?.left, "database") && callee?.type === "MemberExpression"
      && memberOn(callee.object, dependenciesName, "database") && propertyName(callee) === "openConfigured"
      && call.arguments.length === 1 && identifier(call.arguments[0], signalName);
  });
  const maintenance = (statement, name) => {
    const call = awaitedCall(statement);
    const callee = call ? canonicalCallee(call.callee) : null;
    return call && callee?.type === "MemberExpression" && propertyName(callee) === "runMaintenance"
      && memberOn(callee.object, dependenciesName, "coordinator") && call.arguments.length === 2
      && literal(call.arguments[0], name) && ["ArrowFunctionExpression", "FunctionExpression"].includes(call.arguments[1]?.type)
      ? call : null;
  };
  const migrationIndexes = tryStatements.map((statement, index) => maintenance(statement, "migration") ? index : -1)
    .filter((index) => index >= 0);
  const albumIndexes = tryStatements.map((statement, index) => maintenance(statement, "album") ? index : -1)
    .filter((index) => index >= 0);
  const migrateIndex = tryStatements.findIndex((statement) => astNodes(statement, (node) => node === stageWrites[0]).length === 1);
  const postMigrateIndex = tryStatements.findIndex((statement) => astNodes(statement, (node) => node === stageWrites[1]).length === 1);
  assert(openIndex >= 0 && migrateIndex === openIndex + 1 && migrationIndexes.length === 1
    && migrationIndexes[0] > migrateIndex && postMigrateIndex === migrationIndexes[0] + 1
    && albumIndexes.length === 1 && albumIndexes[0] > postMigrateIndex,
  `${recoveryLabel} stage transitions must occur only after open-configure and migration complete`);
  const migrationCall = maintenance(tryStatements[migrationIndexes[0]], "migration");
  const migrateCalls = astNodes(migrationCall.arguments[1].body, (node) => {
    if (node.type !== "CallExpression") return false;
    const callee = canonicalCallee(node.callee);
    return callee?.type === "MemberExpression" && identifier(callee.object, "database")
      && propertyName(callee) === "migrate" && node.arguments.length === 1 && identifier(node.arguments[0], signalName);
  });
  const albumCall = maintenance(tryStatements[albumIndexes[0]], "album");
  const reconcileCalls = astNodes(albumCall.arguments[1].body, (node) => {
    if (node.type !== "CallExpression") return false;
    const callee = canonicalCallee(node.callee);
    return callee?.type === "MemberExpression" && propertyName(callee) === "reconcile"
      && memberOn(callee.object, dependenciesName, "album") && node.arguments.length === 2
      && identifier(node.arguments[0], "database") && identifier(node.arguments[1], signalName);
  });
  assert(migrateCalls.length === 1 && reconcileCalls.length === 1,
    `${recoveryLabel} stage transition sites must guard the exact migration and album operations`);

  const catchBody = startupTry.handler.body.body;
  assert.equal(catchBody.length, 4, `${recoveryLabel} failure control flow is invalid`);
  const [noDatabase, closeTry, succeededStatement, startupThrow] = catchBody;
  assert(noDatabase.type === "IfStatement" && !noDatabase.alternate
    && noDatabase.test.type === "UnaryExpression" && noDatabase.test.operator === "!"
    && noDatabase.test.argument.type === "Identifier" && noDatabase.consequent.type === "BlockStatement"
    && noDatabase.consequent.body.length === 2,
  `${recoveryLabel} pre-open failure branch is invalid`);
  const unobservedCall = expressionCall(noDatabase.consequent.body[0]);
  assert(unobservedCall && directIdentifierCall(unobservedCall, "emitFailureTerminal", 3) === unobservedCall
    && traceMember(unobservedCall.arguments[0], dependenciesName)
    && record(unobservedCall.arguments[1], null, "failure", "unobserved")
    && identifier(unobservedCall.arguments[2], startupError.name)
    && noDatabase.consequent.body[1].type === "ThrowStatement"
    && identifier(noDatabase.consequent.body[1].argument, startupError.name),
  `${recoveryLabel} pre-open failure terminal is not correlated`);

  const closeCall = closeTry?.type === "TryStatement" && closeTry.block.body.length === 1
    && closeTry.block.body[0].type === "ExpressionStatement"
    && closeTry.block.body[0].expression.type === "AwaitExpression"
    ? directCall(closeTry.block.body[0].expression.argument) : null;
  const closeError = closeTry?.handler?.param;
  const closeBody = closeTry?.handler?.body.body;
  assert(closeCall && canonicalCallee(closeCall.callee)?.type === "MemberExpression"
    && propertyName(canonicalCallee(closeCall.callee)) === "close" && closeCall.arguments.length === 0
    && closeError?.type === "Identifier" && Array.isArray(closeBody) && closeBody.length === 3 && !closeTry.finalizer,
  `${recoveryLabel} close observation branch is invalid`);
  const failureDeclaration = standaloneVariable(closeBody[0], "failure");
  const startupCleanup = directCall(failureDeclaration?.init);
  const startupCleanupCallee = startupCleanup ? canonicalCallee(startupCleanup.callee) : null;
  const failedCall = expressionCall(closeBody[1]);
  assert(failureDeclaration && startupCleanup && startupCleanupCallee?.type === "MemberExpression"
    && identifier(startupCleanupCallee.object, cleanupNamespace) && propertyName(startupCleanupCallee) === "cleanupFailure"
    && startupCleanup.arguments.length === 2 && startupCleanup.arguments[0]?.type === "ArrayExpression"
    && startupCleanup.arguments[0].elements.length === 2
    && identifier(startupCleanup.arguments[0].elements[0], startupError.name)
    && identifier(startupCleanup.arguments[0].elements[1], closeError.name)
    && literal(startupCleanup.arguments[1], "Application startup failed and closing the database also failed")
    && cleanupCalls.includes(startupCleanup) && failedCall
    && directIdentifierCall(failedCall, "emitFailureTerminal", 3) === failedCall
    && traceMember(failedCall.arguments[0], dependenciesName)
    && record(failedCall.arguments[1], null, "failure", "failed")
    && identifier(failedCall.arguments[2], "failure")
    && closeBody[2].type === "ThrowStatement" && identifier(closeBody[2].argument, "failure"),
  `${recoveryLabel} failed-close terminal is not correlated`);

  const succeededCall = expressionCall(succeededStatement);
  assert(succeededCall && directIdentifierCall(succeededCall, "emitFailureTerminal", 3) === succeededCall
    && traceMember(succeededCall.arguments[0], dependenciesName)
    && record(succeededCall.arguments[1], null, "failure", "succeeded")
    && identifier(succeededCall.arguments[2], startupError.name)
    && startupThrow.type === "ThrowStatement" && identifier(startupThrow.argument, startupError.name),
  `${recoveryLabel} successful-close failure terminal is not correlated`);

  const failureCalls = [unobservedCall, failedCall, succeededCall];
  const failureStageReferences = failureCalls.flatMap((call) => {
    const property = call.arguments[1].properties[0];
    return property.shorthand ? [property.key, property.value] : [property.value];
  });
  assertExactReferences(recovery, "stage", stage.id,
    [...stageWrites.map((assignment) => assignment.left), ...failureStageReferences], `${recoveryLabel} stage state`);
  const traceReferences = astNodes(recovery, (node) => traceMember(node, dependenciesName));
  const expectedTraceReferences = [readyCall.arguments[0], ...failureCalls.map((call) => call.arguments[0])];
  assert(traceReferences.length === expectedTraceReferences.length
    && traceReferences.every((reference) => expectedTraceReferences.includes(reference)),
  `${recoveryLabel} trace dependency must be consumed only by correlated terminals`);
  assertExactBindingReferences(
    module.factory.body,
    "emitTerminal",
    emitTerminal.id,
    [canonicalCallee(failureHelperCall.callee), canonicalCallee(readyCall.callee)],
    `${recoveryLabel} terminal helper`,
  );
  assertExactBindingReferences(
    module.factory.body,
    "emitFailureTerminal",
    emitFailureTerminal.id,
    failureCalls.map((call) => canonicalCallee(call.callee)),
    `${recoveryLabel} failure terminal helper`,
  );
  const recoveryExport = finalNamedExport(module, "recoverAndOpen");
  assertExactBindingReferences(module.factory.body, recovery.id.name, recovery.id, [recoveryExport],
    `${recoveryLabel} final export`);
}

function productionBootstrapEvidence(module, graph, label) {
  const undefinedValue = (node) => identifier(node, "undefined")
    || node?.type === "UnaryExpression" && node.operator === "void" && literal(node.argument, 0);
  const undefinedTest = (node, name) => {
    if (node?.type !== "BinaryExpression" || node.operator !== "===") return null;
    if (identifier(node.left, name) && undefinedValue(node.right)) return node.left;
    if (undefinedValue(node.left) && identifier(node.right, name)) return node.right;
    return null;
  };
  const namedVariables = (scope, name) => astNodes(scope, (node) => node.type === "VariableDeclarator" && identifier(node.id, name));
  const property = (object, name) => object?.type === "ObjectExpression"
    ? object.properties.filter((candidate) => candidate.type === "Property" && !candidate.computed
      && propertyName({ type: "MemberExpression", computed: false, property: candidate.key }) === name) : [];

  assertClosedExports(module, ["createProductionBootstrap"], `${label} live bootstrap module`);
  const factory = exportedFunction(module, "createProductionBootstrap");
  assert(hasFunctionFlags(factory, false) && factory.params.length === 1 && factory.params[0].type === "Identifier",
    `${label} live bootstrap factory must be one synchronous single-sink export`);
  const traceName = factory.params[0].name;
  assert(bindingIsImmutable(factory, traceName, factory.params[0]), `${label} live bootstrap trace parameter must be immutable`);

  const tracingMatches = namedVariables(factory.body, "tracing");
  assert.equal(tracingMatches.length, 1, `${label} live bootstrap tracing binding must be unique`);
  const tracing = tracingMatches[0];
  const guardReference = tracing.init?.type === "ConditionalExpression" ? undefinedTest(tracing.init.test, traceName) : null;
  const setupCall = tracing.init?.type === "ConditionalExpression" ? directCall(tracing.init.alternate) : null;
  const setup = setupCall && setupCall.arguments.length === 0 ? unwrapChain(setupCall.callee) : null;
  assert(guardReference && undefinedValue(tracing.init.consequent)
    && ["ArrowFunctionExpression", "FunctionExpression"].includes(setup?.type)
    && hasFunctionFlags(setup, false) && setup.params.length === 0 && setup.body.type === "BlockStatement",
  `${label} live bootstrap tracing must be created only when its sink is defined`);

  const emitMatches = namedVariables(setup.body, "emit");
  assert.equal(emitMatches.length, 1, `${label} live bootstrap emit binding must be unique`);
  const emit = emitMatches[0];
  const emitFunction = emit.init;
  const sinkTry = emitFunction?.body?.type === "BlockStatement" && emitFunction.body.body.length === 1
    ? emitFunction.body.body[0] : null;
  const sinkStatement = sinkTry?.type === "TryStatement" && sinkTry.block.body.length === 1 ? sinkTry.block.body[0] : null;
  const sinkCall = sinkStatement?.type === "ExpressionStatement" ? directCall(sinkStatement.expression) : null;
  assert(["ArrowFunctionExpression", "FunctionExpression"].includes(emitFunction?.type)
    && hasFunctionFlags(emitFunction, false) && emitFunction.params.length === 1 && emitFunction.params[0].type === "Identifier"
    && sinkCall && identifier(unwrapChain(sinkCall.callee), traceName) && sinkCall.arguments.length === 1
    && identifier(sinkCall.arguments[0], emitFunction.params[0].name)
    && !sinkTry.finalizer && sinkTry.handler?.body.body.length === 0,
  `${label} live bootstrap emit wrapper must contain and call only the selected sink`);

  const setupReturns = setup.body.body.filter((statement) => statement.type === "ReturnStatement");
  const setupObject = setupReturns.length === 1 ? setupReturns[0].argument : null;
  const startProperties = property(setupObject, "startAttempt");
  const startAttempt = startProperties.length === 1 ? startProperties[0].value : null;
  assert(setupObject?.type === "ObjectExpression" && setupObject.properties.length === 1
    && ["ArrowFunctionExpression", "FunctionExpression"].includes(startAttempt?.type)
    && hasFunctionFlags(startAttempt, false) && startAttempt.params.length === 0 && startAttempt.body.type === "BlockStatement",
  `${label} live bootstrap setup must expose exactly one startAttempt path`);
  const emitCalls = astNodes(startAttempt.body, (node) => node.type === "CallExpression" && identifier(unwrapChain(node.callee), "emit"));
  assert.equal(emitCalls.length, 2, `${label} live bootstrap start and terminal must share one emit sink`);
  const startCall = emitCalls.find((call) => property(call.arguments[0], "kind").some((item) => literal(item.value, "start")));
  const terminalReturns = astNodes(startAttempt.body, (node) => node.type === "ReturnStatement"
    && ["ArrowFunctionExpression", "FunctionExpression"].includes(node.argument?.type));
  const terminalFunction = terminalReturns.length === 1 ? terminalReturns[0].argument : null;
  const terminalBody = terminalFunction?.body?.type === "BlockStatement"
    ? terminalFunction.body.body.find((statement) => statement.type === "ReturnStatement")?.argument
    : terminalFunction?.body;
  const terminalCall = directCall(terminalBody);
  const terminalRecord = terminalCall?.arguments.length === 1 ? terminalCall.arguments[0] : null;
  assert(startCall && startCall.arguments.length === 1
    && terminalFunction?.params.length === 1 && terminalFunction.params[0].type === "Identifier"
    && terminalCall && identifier(unwrapChain(terminalCall.callee), "emit")
    && property(terminalRecord, "kind").some((item) => literal(item.value, "terminal"))
    && terminalRecord.properties.some((item) => item.type === "SpreadElement" && identifier(item.argument, terminalFunction.params[0].name)),
  `${label} live bootstrap terminal must flow through the shared sink`);
  assertExactBindingReferences(setup.body, "emit", emit.id, [unwrapChain(startCall.callee), unwrapChain(terminalCall.callee)],
    `${label} live bootstrap shared emit sink`);

  const factoryReturns = factory.body.body.filter((statement) => statement.type === "ReturnStatement");
  const live = factoryReturns.length === 1 ? factoryReturns[0].argument : null;
  assert(["ArrowFunctionExpression", "FunctionExpression"].includes(live?.type)
    && hasFunctionFlags(live, true) && live.params.length === 1 && live.params[0].type === "Identifier"
    && live.body.type === "BlockStatement", `${label} live bootstrap factory must return one async bootstrap`);
  const terminalMatches = namedVariables(live.body, "traceTerminal");
  assert.equal(terminalMatches.length, 1, `${label} live bootstrap terminal binding must be unique`);
  const terminal = terminalMatches[0];
  const startTerminalCall = directCall(terminal.init);
  const startTerminalCallee = startTerminalCall ? unwrapChain(startTerminalCall.callee) : null;
  const tracingReference = startTerminalCallee?.type === "MemberExpression" ? unwrapChain(startTerminalCallee.object) : null;
  assert(terminal.init?.type === "ChainExpression" && startTerminalCall?.arguments.length === 0
    && startTerminalCallee?.type === "MemberExpression" && propertyName(startTerminalCallee) === "startAttempt"
    && identifier(tracingReference, "tracing"), `${label} live bootstrap start sink must be optional`);

  const recoveryCalls = astNodes(live.body, (node) => node.type === "CallExpression"
    && canonicalCallee(node.callee)?.type === "MemberExpression"
    && !canonicalCallee(node.callee).computed && propertyName(canonicalCallee(node.callee)) === "recoverAndOpen");
  assert.equal(recoveryCalls.length, 1, `${label} live bootstrap must call one recoverAndOpen`);
  const recoveryCall = recoveryCalls[0];
  const recoveryCallee = canonicalCallee(recoveryCall.callee);
  assert(recoveryCallee.object.type === "Identifier" && recoveryCall.arguments.length === 2
    && recoveryCall.arguments[0].type === "ObjectExpression" && identifier(recoveryCall.arguments[1], live.params[0].name),
  `${label} live bootstrap recoverAndOpen call is malformed`);
  const terminalSpreads = recoveryCall.arguments[0].properties.filter((item) => item.type === "SpreadElement"
    && item.argument?.type === "ConditionalExpression" && undefinedTest(item.argument.test, "traceTerminal"));
  assert.equal(terminalSpreads.length, 1, `${label} live bootstrap must conditionally pass traceTerminal`);
  const terminalConditional = terminalSpreads[0].argument;
  const terminalTestReference = undefinedTest(terminalConditional.test, "traceTerminal");
  const terminalProperties = property(terminalConditional.alternate, "traceTerminal");
  assert(terminalConditional.consequent?.type === "ObjectExpression" && terminalConditional.consequent.properties.length === 0
    && terminalConditional.alternate?.type === "ObjectExpression" && terminalConditional.alternate.properties.length === 1
    && terminalProperties.length === 1 && identifier(terminalProperties[0].value, "traceTerminal"),
  `${label} live bootstrap must pass the exact terminal sink only when defined`);
  const recoveryBinding = dependencyBinding(module, recoveryCallee.object.name, `${label} recoverAndOpen dependency`, factory, [recoveryCallee.object]);
  const recoveryModule = resolveDependency(graph, module, recoveryBinding.dependencyIndex, `${label} recoverAndOpen dependency`);
  recoverAndOpenEvidence(recoveryModule, graph, label);
  assertExactBindingReferences(factory, traceName, factory.params[0], [guardReference, unwrapChain(sinkCall.callee)], `${label} selected trace sink`);
  assertExactBindingReferences(factory, "tracing", tracing.id, [tracingReference], `${label} tracing path`);
  const terminalReferences = new Set(bindingReferences(live, "traceTerminal", terminal.id));
  const expectedTerminalReferences = new Set([terminalTestReference, terminalProperties[0].value]);
  if (terminalProperties[0].shorthand) expectedTerminalReferences.add(terminalProperties[0].key);
  assert(bindingIsImmutable(live, "traceTerminal", terminal.id)
    && terminalReferences.size === expectedTerminalReferences.size
    && [...terminalReferences].every((reference) => expectedTerminalReferences.has(reference)),
  `${label} terminal sink must be closed to recoverAndOpen`);

  const processNonce = topLevelVariable(module, "processNonce", `${label} process nonce`, { before: factory });
  const randomCalls = astNodes(processNonce.declaration.init, (node) => directIntrinsicCall(node, "Math", "random", 0)?.call === node);
  const freezeCalls = astNodes(factory.body, (node) => directIntrinsicCall(node, "Object", "freeze", 1)?.call === node
    && node.arguments[0]?.type === "ObjectExpression");
  const exportCalls = astNodes(module.factory.body, (node) => directIntrinsicCall(node, "Object", "defineProperty", 3)?.call === node
    && identifier(node.arguments[0], module.exportsName));
  assert.equal(randomCalls.length, 1, `${label} live bootstrap Math.random site is invalid`);
  assert.equal(freezeCalls.length, 2, `${label} live bootstrap Object.freeze sites are invalid`);
  assertExactIntrinsicReferences(module, {
    Math: [directIntrinsicCall(randomCalls[0], "Math", "random", 0).object],
    Object: [
      ...exportCalls.map((call) => directIntrinsicCall(call, "Object", "defineProperty", 3).object),
      ...freezeCalls.map((call) => directIntrinsicCall(call, "Object", "freeze", 1).object),
    ],
  }, `${label} live bootstrap module`);
}

function appEvidence(module, graph, label) {
  const appComposition = exportedFunction(module, "AppComposition");
  if (!appComposition) return null;
  assertClosedExports(module, ["AppComposition", "default"], `${label} App`);
  const defaultApp = exportedFunction(module, "default");
  if (!hasFunctionFlags(appComposition, false) || !hasFunctionFlags(defaultApp, false)
    || defaultApp.params.length !== 0 || defaultApp.body.body.length !== 1
    || defaultApp.body.body[0].type !== "ReturnStatement") return null;
  const appRender = renderedComponent(defaultApp.body.body[0].argument, "AppComposition");
  if (!appRender.validRoot || appRender.matches.length !== 1 || appRender.matches[0].props.properties.length !== 0) return null;

  const parameter = appComposition.params.length === 1 ? appComposition.params[0] : null;
  if (parameter?.type !== "ObjectPattern" || parameter.properties.length !== 1) return null;
  const installProperty = parameter.properties[0];
  const installPattern = installProperty?.type === "Property" && installProperty.kind === "init" && !installProperty.computed
    && propertyName({ type: "MemberExpression", computed: false, property: installProperty.key }) === "installFaults"
    ? installProperty.value : null;
  const defaultValue = installPattern?.type === "AssignmentPattern" && identifier(installPattern.left, "installFaults")
    ? installPattern.right : null;
  if (defaultValue?.type !== "MemberExpression" || defaultValue.computed || propertyName(defaultValue) !== "installFaultController"
    || defaultValue.object.type !== "Identifier" || !bindingIsImmutable(appComposition, "installFaults", parameter)) return null;
  const bootstrapDeclaration = topLevelVariable(module, "productionBootstrap", `${label} App production bootstrap`, { before: appComposition });
  const bootstrapCall = directCall(bootstrapDeclaration.declaration.init);
  const bootstrapCallee = bootstrapCall ? canonicalCallee(bootstrapCall.callee) : null;
  const traceArgument = bootstrapCall?.arguments.length === 1 ? unwrapChain(bootstrapCall.arguments[0]) : null;
  if (bootstrapCallee?.type !== "MemberExpression" || bootstrapCallee.object.type !== "Identifier"
    || propertyName(bootstrapCallee) !== "createProductionBootstrap"
    || traceArgument?.type !== "MemberExpression" || traceArgument.computed
    || traceArgument.object.type !== "Identifier" || traceArgument.object.name !== defaultValue.object.name
    || propertyName(traceArgument) !== "traceBootstrap") return null;
  const controllerBinding = dependencyBinding(
    module,
    defaultValue.object.name,
    `${label} App controller`,
    appComposition,
    [traceArgument.object, defaultValue.object],
  );
  const bootstrapBinding = dependencyBinding(
    module,
    bootstrapCallee.object.name,
    `${label} App bootstrap factory`,
    bootstrapDeclaration.statement,
    [bootstrapCallee.object],
  );
  const bootstrapModule = resolveDependency(graph, module, bootstrapBinding.dependencyIndex, `${label} App bootstrap factory`);
  productionBootstrapEvidence(bootstrapModule, graph, label);

  if (appComposition.body.body.length !== 1 || appComposition.body.body[0].type !== "ReturnStatement") return null;
  const hostRender = renderedComponent(appComposition.body.body[0].argument, "FaultControllerHost");
  if (!hostRender.validRoot || hostRender.matches.length !== 1) return null;
  const installProperties = objectProperties(hostRender.matches[0].props, "installFaults");
  const childrenProperties = objectProperties(hostRender.matches[0].props, "children");
  if (installProperties.length !== 1 || !identifier(installProperties[0].value, "installFaults")
    || childrenProperties.length !== 1) return null;
  const navigatorRender = renderedComponent(childrenProperties[0].value, "RootNavigator");
  if (!navigatorRender.validRoot || navigatorRender.matches.length !== 1) return null;
  const navigatorMatch = navigatorRender.matches[0];
  const navigatorReference = navigatorMatch.componentReference;
  const navigatorNamespace = navigatorReference?.type === "MemberExpression" && !navigatorReference.computed
    && propertyName(navigatorReference) === "RootNavigator" && navigatorReference.object.type === "Identifier"
    ? navigatorReference.object : null;
  const bootstrapProperties = objectProperties(navigatorMatch.props, "bootstrap");
  if (!navigatorNamespace || bootstrapProperties.length !== 1
    || !identifier(bootstrapProperties[0].value, "productionBootstrap")) return null;
  const navigatorBinding = dependencyBinding(
    module,
    navigatorNamespace.name,
    `${label} App RootNavigator`,
    appComposition,
    [navigatorNamespace],
  );
  resolveDependency(graph, module, navigatorBinding.dependencyIndex, `${label} App RootNavigator`);
  assertExactBindingReferences(
    module.factory.body,
    "productionBootstrap",
    bootstrapDeclaration.declaration.id,
    [bootstrapProperties[0].value],
    `${label} App live production bootstrap`,
  );

  const host = functionDeclaration(module, "FaultControllerHost");
  if (!hasFunctionFlags(host, false)) return null;
  const hostInstallation = hostInstallationEvidence(module, host, label);
  if (!hostInstallation) return null;
  dependencyBinding(
    module,
    hostInstallation.runtimeName,
    `${label} App React runtime`,
    host,
    hostInstallation.runtimeReferences,
  );
  assertJsxRuntimeBinding(module, [appRender, hostRender, navigatorRender], host, `${label} App render chain`);

  const appCompositionExport = finalNamedExport(module, "AppComposition");
  const defaultExport = finalNamedExport(module, "default");
  assertExactBindingReferences(
    module.factory.body,
    "AppComposition",
    appComposition.id,
    [appCompositionExport, appRender.matches[0].componentReference],
    `${label} AppComposition`,
  );
  assertExactBindingReferences(module.factory.body, "App", defaultApp.id, [defaultExport], `${label} default App`);
  assertExactBindingReferences(
    module.factory.body,
    "FaultControllerHost",
    host.id,
    [hostRender.matches[0].componentReference],
    `${label} FaultControllerHost`,
  );
  assertExactBindingReferences(
    appComposition,
    "installFaults",
    parameter,
    [installProperties[0].value],
    `${label} AppComposition installFaults`,
  );
  return {
    module,
    bootstrap: bootstrapModule,
    controller: resolveDependency(graph, module, controllerBinding.dependencyIndex, `${label} App controller`),
  };
}

function rootRegistersApp(graph, app, label) {
  const registrations = [];
  for (const rootId of graph.roots) {
    const root = graph.byId.get(rootId);
    for (const statement of root.factory.body.body) {
      if (statement.type === "ReturnStatement" || statement.type === "ThrowStatement") break;
      const call = statement.type === "ExpressionStatement" ? directCall(statement.expression) : null;
      const callee = call ? canonicalCallee(call.callee) : null;
      if (callee?.type !== "MemberExpression" || propertyName(callee) !== "registerRootComponent") continue;
      assert(callee.object.type === "Identifier" && call.arguments.length === 1, `${label} root registration call is malformed`);
      const argument = call.arguments[0];
      assert(argument?.type === "MemberExpression" && !argument.computed && propertyName(argument) === "default"
        && argument.object.type === "Identifier", `${label} root must register the imported default App binding`);

      const appInterop = topLevelVariable(root, argument.object.name, `${label} root App interop`, { before: statement, includeMembers: true });
      const interopCall = appInterop.declaration.init;
      assert(interopCall?.type === "CallExpression" && interopCall.arguments.length === 1
        && interopCall.arguments[0]?.type === "Identifier" && canonicalCallee(interopCall.callee)?.type === "Identifier",
      `${label} root App interop call is invalid`);
      const helperReference = canonicalCallee(interopCall.callee);
      const helperName = helperReference.name;
      canonicalInteropFunction(root, helperName, `${label} root`, appInterop.statement, helperReference);
      const importedName = interopCall.arguments[0].name;
      const appBinding = dependencyBinding(
        root,
        importedName,
        `${label} root App import`,
        appInterop.statement,
        [interopCall.arguments[0]],
      );
      const runtimeBinding = dependencyBinding(
        root,
        callee.object.name,
        `${label} root runtime import`,
        statement,
        [callee.object],
      );
      assertExactBindingReferences(
        root.factory.body,
        argument.object.name,
        appInterop.declaration.id,
        [argument.object],
        `${label} root App interop result`,
      );
      const importedApp = resolveDependency(graph, root, appBinding.dependencyIndex, `${label} root App`);
      resolveDependency(graph, root, runtimeBinding.dependencyIndex, `${label} root runtime`);
      if (importedApp.moduleId === app.moduleId) registrations.push({ root, call });
    }
  }
  assert.equal(registrations.length, 1, `${label} one top-level Metro root must import and register the default App`);
}

function standaloneVariable(statement, name) {
  if (statement?.type !== "VariableDeclaration" || statement.declarations.length !== 1) return null;
  const declaration = statement.declarations[0];
  return identifier(declaration.id, name) ? declaration : null;
}

function callOnIdentifier(call, objectName, methodName) {
  const callee = call ? canonicalCallee(call.callee) : null;
  return callee?.type === "MemberExpression" && identifier(callee.object, objectName) && propertyName(callee) === methodName;
}

function linkingCall(call, runtimeName, methodName) {
  const callee = call ? canonicalCallee(call.callee) : null;
  const linking = callee?.type === "MemberExpression" ? unwrapChain(callee.object) : null;
  return propertyName(callee) === methodName && linking?.type === "MemberExpression" && !linking.computed
    && propertyName(linking) === "Linking" && identifier(linking.object, runtimeName);
}

function expressionCall(statement) {
  return statement?.type === "ExpressionStatement" ? directCall(statement.expression) : null;
}

function bootstrapTraceEvidence(module, label) {
  assertPristineIntrinsics(module, `${label} bootstrap trace module`);
  const trace = exportedFunction(module, "traceBootstrap");
  assert(hasFunctionFlags(trace, false) && trace.params.length === 1 && trace.params[0].type === "Identifier",
    `${label} bootstrap trace export must be one synchronous function`);
  const recordName = trace.params[0].name;
  const variable = (name) => {
    const matches = astNodes(trace.body, (node) => node.type === "VariableDeclarator" && identifier(node.id, name));
    assert.equal(matches.length, 1, `${label} bootstrap trace ${name} binding must be unique`);
    return matches[0];
  };
  const callMethod = (node, objectName, methodName, argumentCount) => {
    const call = directCall(node);
    const callee = call ? canonicalCallee(call.callee) : null;
    return call && callee?.type === "MemberExpression" && identifier(callee.object, objectName)
      && propertyName(callee) === methodName && call.arguments.length === argumentCount ? call : null;
  };
  const recordMember = (node, field) => node?.type === "MemberExpression" && !node.computed
    && identifier(node.object, recordName) && propertyName(node) === field;
  const bareReturn = (statement) => statement?.type === "ReturnStatement" && statement.argument === null;
  const expressionStatementCall = (statement, objectName, methodName, argumentCount) => {
    const call = expressionCall(statement);
    return callMethod(call, objectName, methodName, argumentCount);
  };
  const binary = (node, operator, left, right) => node?.type === "BinaryExpression" && node.operator === operator
    && left(node.left) && right(node.right);
  const logicalOperands = (node, operator) => node?.type === "LogicalExpression" && node.operator === operator
    ? [...logicalOperands(node.left, operator), ...logicalOperands(node.right, operator)] : [node];
  const objectField = (object, name) => object?.type === "ObjectExpression"
    ? object.properties.find((property) => property.type === "Property" && property.kind === "init" && !property.computed
      && propertyName({ type: "MemberExpression", computed: false, property: property.key }) === name) : null;
  const exactObject = (object, fields) => object?.type === "ObjectExpression" && object.properties.length === fields.length
    && fields.every(([name, predicate]) => {
      const property = objectField(object, name);
      return property && predicate(property.value);
    });

  const allowedRecordFields = new Set(["attempt", "kind", "stage", "outcome", "closeOutcome", "failureCategory"]);
  const recordMembers = astNodes(trace.body, (node) => node.type === "MemberExpression"
    && !node.computed && identifier(node.object, recordName));
  assert(recordMembers.length > 0, `${label} bootstrap trace must read its typed record`);
  for (const reference of recordMembers) {
    assert(allowedRecordFields.has(propertyName(reference)),
      `${label} bootstrap trace record access is outside the serialization whitelist`);
  }
  assert.equal(astNodes(trace.body, (node) => identifier(node, "global")).length, 0,
    `${label} bootstrap trace must not alias global payloads`);
  const spreads = astNodes(trace.body, (node) => node.type === "SpreadElement" || node.type === "ExperimentalSpreadProperty");
  assert.equal(spreads.length, 0, `${label} bootstrap trace must not spread untrusted records`);

  const maximum = topLevelVariable(module, "MAX_BOOTSTRAP_ATTEMPTS", `${label} bootstrap trace attempt bound`, { before: trace });
  assert(literal(maximum.declaration.init, 32), `${label} bootstrap trace attempt bound must remain 32`);
  const session = topLevelVariable(module, "traceSession", `${label} bootstrap trace session`, { before: trace });
  const padEnd = directCall(session.declaration.init);
  const padEndCallee = padEnd ? canonicalCallee(padEnd.callee) : null;
  const slice = padEndCallee?.type === "MemberExpression" && propertyName(padEndCallee) === "padEnd"
    ? directCall(padEndCallee.object) : null;
  const sliceCallee = slice ? canonicalCallee(slice.callee) : null;
  const toString = sliceCallee?.type === "MemberExpression" && propertyName(sliceCallee) === "slice"
    ? directCall(sliceCallee.object) : null;
  const toStringCallee = toString ? canonicalCallee(toString.callee) : null;
  const random = toStringCallee?.type === "MemberExpression" && propertyName(toStringCallee) === "toString"
    ? directCall(toStringCallee.object) : null;
  assert(padEnd?.arguments.length === 2 && literal(padEnd.arguments[0], 12) && literal(padEnd.arguments[1], "0")
    && slice?.arguments.length === 2 && literal(slice.arguments[0], 2) && literal(slice.arguments[1], 14)
    && toString?.arguments.length === 1 && literal(toString.arguments[0], 36)
    && random?.arguments.length === 0 && member(canonicalCallee(random.callee), "Math", "random"),
  `${label} bootstrap trace session must use the bounded random 12-character construction`);

  const attempts = topLevelVariable(module, "traceAttempts", `${label} bootstrap trace attempt state`, { before: trace });
  assert(attempts.declaration.init?.type === "NewExpression" && identifier(attempts.declaration.init.callee, "Map")
    && attempts.declaration.init.arguments.length === 0, `${label} bootstrap trace attempt state must be a private Map`);
  const expectedSets = [
    ["traceFailureStages", ["open-configure", "migrate", "post-migrate"]],
    ["traceFailureCloseOutcomes", ["unobserved", "succeeded", "failed"]],
    ["traceFailureCategories", ["abort", "cleanup", "sqlite-open", "sqlite", "aggregate", "uncoded"]],
  ];
  const validationSets = new Map();
  for (const [name, values] of expectedSets) {
    const binding = topLevelVariable(module, name, `${label} bootstrap trace ${name}`, { before: trace });
    const init = binding.declaration.init;
    assert(init?.type === "NewExpression" && identifier(init.callee, "Set") && init.arguments.length === 1
      && init.arguments[0]?.type === "ArrayExpression"
      && init.arguments[0].elements.length === values.length
      && init.arguments[0].elements.every((element, index) => literal(element, values[index])),
    `${label} bootstrap trace ${name} validation set is invalid`);
    validationSets.set(name, binding);
  }
  const sequenceMatches = module.factory.body.body.flatMap((statement) => statement.type === "VariableDeclaration"
    ? statement.declarations.filter((declaration) => identifier(declaration.id, "traceSequence")) : []);
  assert.equal(sequenceMatches.length, 1, `${label} bootstrap trace sequence binding must be unique`);
  assert(literal(sequenceMatches[0].init, 0), `${label} bootstrap trace sequence must start at zero`);

  const attempt = variable("attempt");
  assert(recordMember(attempt.init, "attempt") && bindingIsImmutable(trace.body, "attempt", attempt.id),
    `${label} bootstrap trace attempt must be an immutable typed-record projection`);
  const attemptGuard = trace.body.body.find((statement) => statement.type === "IfStatement"
    && statement.consequent.type === "ReturnStatement" && statement.consequent.argument === null
    && logicalOperands(statement.test, "||").length === 3);
  const attemptChecks = attemptGuard ? logicalOperands(attemptGuard.test, "||") : [];
  const safeInteger = attemptChecks.some((node) => node.type === "UnaryExpression" && node.operator === "!"
    && callMethod(node.argument, "Number", "isSafeInteger", 1)?.arguments.some((argument) => identifier(argument, "attempt")));
  const lowerBound = attemptChecks.some((node) => binary(node, "<", (value) => identifier(value, "attempt"), (value) => literal(value, 1)));
  const upperBound = attemptChecks.some((node) => binary(node, ">", (value) => identifier(value, "attempt"),
    (value) => identifier(value, "MAX_BOOTSTRAP_ATTEMPTS")));
  assert(attemptGuard && safeInteger && lowerBound && upperBound,
    `${label} bootstrap trace attempt validation must remain safe, one-based, and bounded`);

  const startBranch = trace.body.body.find((statement) => statement.type === "IfStatement"
    && binary(statement.test, "===", (value) => recordMember(value, "kind"), (value) => literal(value, "start")));
  assert(startBranch?.consequent.type === "BlockStatement" && startBranch.alternate?.type === "IfStatement",
    `${label} bootstrap trace must preserve explicit start and terminal-kind branches`);
  const startBody = startBranch.consequent.body;
  const duplicateGuard = startBody.find((statement) => statement.type === "IfStatement" && bareReturn(statement.consequent)
    && callMethod(statement.test, "traceAttempts", "has", 1)?.arguments.some((argument) => identifier(argument, "attempt")));
  const duplicateCall = duplicateGuard ? callMethod(duplicateGuard.test, "traceAttempts", "has", 1) : null;
  const startTransition = startBody.map((statement) => expressionStatementCall(statement, "traceAttempts", "set", 2))
    .find((call) => call && identifier(call.arguments[0], "attempt") && literal(call.arguments[1], "started"));
  assert(duplicateCall && startTransition, `${label} bootstrap trace start-state validation is invalid`);

  const terminalBranch = startBranch.alternate;
  assert(binary(terminalBranch.test, "===", (value) => recordMember(value, "kind"), (value) => literal(value, "terminal"))
    && terminalBranch.consequent.type === "BlockStatement"
    && terminalBranch.alternate?.type === "BlockStatement"
    && terminalBranch.alternate.body.length === 1 && bareReturn(terminalBranch.alternate.body[0]),
  `${label} bootstrap trace must reject every non-terminal alternate kind`);
  const terminalBody = terminalBranch.consequent.body;
  const terminalGuard = terminalBody.find((statement) => statement.type === "IfStatement" && bareReturn(statement.consequent));
  const terminalChecks = terminalGuard ? logicalOperands(terminalGuard.test, "||") : [];
  const stateCheck = terminalChecks.find((node) => binary(node, "!==", (value) => {
    const call = callMethod(value, "traceAttempts", "get", 1);
    return call && identifier(call.arguments[0], "attempt");
  }, (value) => literal(value, "started")));
  const stateGet = stateCheck ? callMethod(stateCheck.left, "traceAttempts", "get", 1) : null;
  const truthCheck = terminalChecks.find((node) => node.type === "UnaryExpression" && node.operator === "!"
    && logicalOperands(node.argument, "||").length === 2);
  const truthArms = truthCheck ? logicalOperands(truthCheck.argument, "||") : [];
  const recordEquals = (node, field, value) => binary(node, "===",
    (candidate) => recordMember(candidate, field), (candidate) => literal(candidate, value));
  const successArm = truthArms.find((arm) => logicalOperands(arm, "&&")
    .some((node) => recordEquals(node, "outcome", "success")));
  const failureArm = truthArms.find((arm) => logicalOperands(arm, "&&")
    .some((node) => recordEquals(node, "outcome", "failure")));
  const successChecks = successArm ? logicalOperands(successArm, "&&") : [];
  const failureChecks = failureArm ? logicalOperands(failureArm, "&&") : [];
  const categoryAbsent = successChecks.some((node) => node.type === "UnaryExpression" && node.operator === "!"
    && node.argument?.type === "BinaryExpression" && node.argument.operator === "in"
    && literal(node.argument.left, "failureCategory") && identifier(node.argument.right, recordName));
  const setCheck = (checks, setName, field) => checks.map((node) => callMethod(node, setName, "has", 1))
    .find((call) => call && recordMember(call.arguments[0], field));
  const stageCall = setCheck(failureChecks, "traceFailureStages", "stage");
  const closeCall = setCheck(failureChecks, "traceFailureCloseOutcomes", "closeOutcome");
  const categoryCall = setCheck(failureChecks, "traceFailureCategories", "failureCategory");
  assert(terminalChecks.length === 2 && stateGet && truthCheck
    && successChecks.length === 4
    && successChecks.some((node) => recordEquals(node, "outcome", "success"))
    && successChecks.some((node) => recordEquals(node, "stage", "ready"))
    && successChecks.some((node) => recordEquals(node, "closeOutcome", "not-attempted"))
    && categoryAbsent
    && failureChecks.length === 4
    && failureChecks.some((node) => recordEquals(node, "outcome", "failure"))
    && stageCall && closeCall && categoryCall,
  `${label} bootstrap trace terminal validation must preserve the exact correlated truth table`);
  const terminalTransition = terminalBody.map((statement) => expressionStatementCall(statement, "traceAttempts", "set", 2))
    .find((call) => call && identifier(call.arguments[0], "attempt") && literal(call.arguments[1], "terminal"));
  assert(terminalTransition, `${label} bootstrap trace terminal state transition is invalid`);

  const callReceiver = (call) => canonicalCallee(call.callee).object;
  assertExactBindingReferences(
    module.factory.body,
    "traceAttempts",
    attempts.declaration.id,
    [callReceiver(duplicateCall), callReceiver(startTransition), callReceiver(stateGet), callReceiver(terminalTransition)],
    `${label} bootstrap trace attempt state`,
  );
  for (const [name, call] of [
    ["traceFailureStages", stageCall],
    ["traceFailureCloseOutcomes", closeCall],
    ["traceFailureCategories", categoryCall],
  ]) {
    assertExactBindingReferences(
      module.factory.body,
      name,
      validationSets.get(name).declaration.id,
      [callReceiver(call)],
      `${label} bootstrap trace ${name} validation set`,
    );
  }

  const allowedOutputFields = new Set([
    "schemaVersion", "session", "sequence", "attempt", "kind", "stage", "outcome", "closeOutcome", "failureCategory",
  ]);
  const outputObjects = astNodes(trace.body, (node) => node.type === "ObjectExpression");
  for (const object of outputObjects) {
    for (const property of object.properties) {
      assert(property.type === "Property" && !property.computed && allowedOutputFields.has(propertyName({
        type: "MemberExpression",
        computed: false,
        property: property.key,
      })), `${label} bootstrap trace output contains a non-whitelist field`);
    }
  }
  const output = variable("output");
  assert(output.init === null, `${label} bootstrap trace output must be built only in validated branches`);
  const outputAssignments = astNodes(trace.body, (node) => node.type === "AssignmentExpression"
    && node.operator === "=" && identifier(node.left, "output"));
  assert.equal(outputAssignments.length, 2, `${label} bootstrap trace output must have exactly two validated constructions`);
  const frozenValue = (node) => {
    const call = directCall(node);
    return callMethod(call, "Object", "freeze", 1) ? call.arguments[0] : null;
  };
  const startOutput = outputAssignments.map((assignment) => frozenValue(assignment.right))
    .find((value) => value?.type === "ObjectExpression");
  const terminal = variable("terminal");
  const terminalOutput = outputAssignments.find((assignment) => identifier(frozenValue(assignment.right), "terminal"));
  const sequenceUpdates = [];
  const sequenceValue = (value) => {
    if (value?.type !== "UpdateExpression" || value.operator !== "++" || !value.prefix || !identifier(value.argument, "traceSequence")) return false;
    sequenceUpdates.push(value.argument);
    return true;
  };
  assert(exactObject(startOutput, [
    ["schemaVersion", (value) => literal(value, 1)],
    ["session", (value) => identifier(value, "traceSession")],
    ["sequence", sequenceValue],
    ["attempt", (value) => identifier(value, "attempt")],
    ["kind", (value) => literal(value, "start")],
  ]), `${label} bootstrap trace start output is not the exact whitelist object`);
  assert(exactObject(terminal.init, [
    ["schemaVersion", (value) => literal(value, 1)],
    ["session", (value) => identifier(value, "traceSession")],
    ["sequence", sequenceValue],
    ["attempt", (value) => identifier(value, "attempt")],
    ["kind", (value) => literal(value, "terminal")],
    ["stage", (value) => recordMember(value, "stage")],
    ["outcome", (value) => recordMember(value, "outcome")],
    ["closeOutcome", (value) => recordMember(value, "closeOutcome")],
  ]) && terminalOutput, `${label} bootstrap trace terminal output is not the exact immutable whitelist object`);
  const categoryAssignments = astNodes(trace.body, (node) => node.type === "AssignmentExpression" && node.operator === "="
    && node.left.type === "MemberExpression" && !node.left.computed && identifier(node.left.object, "terminal")
    && propertyName(node.left) === "failureCategory" && recordMember(node.right, "failureCategory"));
  assert.equal(categoryAssignments.length, 1, `${label} bootstrap trace failure category projection is invalid`);
  const categoryGuard = terminalBody.find((statement) => statement.type === "IfStatement"
    && binary(statement.test, "===", (value) => recordMember(value, "outcome"), (value) => literal(value, "failure"))
    && astNodes(statement.consequent, (node) => node === categoryAssignments[0]).length === 1);
  assert(categoryGuard, `${label} bootstrap trace failure category must be emitted only for failures`);
  const sequenceReferences = bindingReferences(module.factory.body, "traceSequence", sequenceMatches[0].id);
  assert(sequenceReferences.length === 2 && sequenceReferences.every((reference) => sequenceUpdates.includes(reference)),
    `${label} bootstrap trace sequence must be used only by two prefix increments`);

  const stringifyCalls = astNodes(trace.body, (node) => directIntrinsicCall(node, "JSON", "stringify", 1)?.call === node);
  assert.equal(stringifyCalls.length, 1, `${label} bootstrap trace must serialize exactly one whitelist-built output`);
  assert(stringifyCalls[0].arguments.length === 1 && identifier(stringifyCalls[0].arguments[0], "output"),
    `${label} bootstrap trace serializer must consume the exact whitelist-built output binding`);
  const outputReferences = bindingReferences(trace.body, "output", output.id);
  const expectedOutputReferences = [...outputAssignments.map((assignment) => assignment.left), stringifyCalls[0].arguments[0]];
  assert(outputReferences.length === expectedOutputReferences.length
    && outputReferences.every((reference) => expectedOutputReferences.includes(reference)),
  `${label} bootstrap trace whitelist output must not escape through aliases or extra reads`);

  const consoleCalls = astNodes(trace.body, (node) => directIntrinsicCall(node, "console", "info", 1)?.call === node);
  assert.equal(consoleCalls.length, 1, `${label} bootstrap trace must use exactly one console sink`);
  const message = consoleCalls[0].arguments.length === 1 ? consoleCalls[0].arguments[0] : null;
  assert(message?.type === "TemplateLiteral" && message.expressions.length === 2 && message.quasis.length === 3
    && message.quasis[0].value.cooked === "" && message.quasis[1].value.cooked === " " && message.quasis[2].value.cooked === ""
    && identifier(message.expressions[0], "E2E_BOOTSTRAP_TRACE_BUNDLE_SENTINEL")
    && message.expressions[1] === stringifyCalls[0],
  `${label} bootstrap trace console argument must be exactly sentinel, one space, and the whitelist serializer`);
  const guardedSinks = astNodes(trace.body, (node) => node.type === "TryStatement"
    && !node.finalizer && node.handler?.body.body.length === 0
    && astNodes(node.block, (candidate) => candidate === consoleCalls[0]).length === 1);
  assert.equal(guardedSinks.length, 1, `${label} bootstrap trace console sink must be synchronously contained`);

  const sentinelExport = finalNamedExport(module, "E2E_BOOTSTRAP_TRACE_BUNDLE_SENTINEL");
  assert(identifier(sentinelExport, "E2E_BOOTSTRAP_TRACE_BUNDLE_SENTINEL"), `${label} bootstrap trace sentinel export is invalid`);
  const sentinel = topLevelVariable(module, "E2E_BOOTSTRAP_TRACE_BUNDLE_SENTINEL", `${label} bootstrap trace sentinel`, { before: trace });
  assert(literal(sentinel.declaration.init, BOOTSTRAP_TRACE_SENTINEL), `${label} bootstrap trace sentinel binding is invalid`);
  assertExactBindingReferences(
    module.factory.body,
    "traceBootstrap",
    trace.id,
    [finalNamedExport(module, "traceBootstrap")],
    `${label} bootstrap trace export`,
  );
  const sentinelReferences = astNodes(trace.body, (node, parent) => identifier(node, "E2E_BOOTSTRAP_TRACE_BUNDLE_SENTINEL")
    && isIdentifierReference(node, parent));
  assertExactBindingReferences(
    module.factory.body,
    "E2E_BOOTSTRAP_TRACE_BUNDLE_SENTINEL",
    sentinel.declaration.id,
    [sentinelExport, ...sentinelReferences],
    `${label} bootstrap trace sentinel`,
  );
  const sentinelLiterals = astNodes(module.factory.body, (node) => literal(node, BOOTSTRAP_TRACE_SENTINEL));
  assert.equal(sentinelLiterals.length, 1, `${label} bootstrap trace sentinel must be one live literal`);
  const randomIntrinsic = directIntrinsicCall(random, "Math", "random", 0);
  const safeIntegerCalls = attemptChecks.map((node) => node.type === "UnaryExpression" && node.operator === "!"
    ? directIntrinsicCall(node.argument, "Number", "isSafeInteger", 1) : null).filter(Boolean);
  const freezeCalls = outputAssignments.map((assignment) => directIntrinsicCall(assignment.right, "Object", "freeze", 1));
  const exportCalls = astNodes(module.factory.body, (node) => directIntrinsicCall(node, "Object", "defineProperty", 3)?.call === node
    && identifier(node.arguments[0], module.exportsName));
  assert(randomIntrinsic && safeIntegerCalls.length === 1 && freezeCalls.length === 2 && freezeCalls.every(Boolean),
    `${label} bootstrap trace intrinsic call sites are noncanonical`);
  assertExactIntrinsicReferences(module, {
    JSON: [directIntrinsicCall(stringifyCalls[0], "JSON", "stringify", 1).object],
    console: [directIntrinsicCall(consoleCalls[0], "console", "info", 1).object],
    Object: [
      ...exportCalls.map((call) => directIntrinsicCall(call, "Object", "defineProperty", 3).object),
      ...freezeCalls.map((call) => call.object),
    ],
    Number: [safeIntegerCalls[0].object],
    Math: [randomIntrinsic.object],
    Map: [attempts.declaration.init.callee],
    Set: [...validationSets.values()].map((binding) => binding.declaration.init.callee),
  }, `${label} bootstrap trace module`);
  return trace;
}

function listenerEvidence(module, graph, label) {
  assertClosedExports(module, ["E2E_BOOTSTRAP_TRACE_BUNDLE_SENTINEL", "E2E_FAULT_CONTROLLER_BUNDLE_SENTINEL", "installFaultController", "traceBootstrap"], `${label} listener`);
  bootstrapTraceEvidence(module, label);
  const install = exportedFunction(module, "installFaultController");
  assert(hasFunctionFlags(install, true) && install.params.length === 2
    && install.params.every((parameter) => parameter.type === "Identifier"),
    `${label} listener final installFaultController export is invalid`);
  const [onFaultName, signalName] = install.params.map((parameter) => parameter.name);
  assert(bindingIsImmutable(install, onFaultName, install.params[0]) && bindingIsImmutable(install, signalName, install.params[1]),
    `${label} listener parameters must be immutable and unshadowed`);
  const body = install.body.body;
  assert.equal(body.length, 8, `${label} listener control flow must use the exact installation statement sequence`);

  const noOpExport = topLevelVariable(module, "noOp", `${label} listener no-op`, { before: install });
  const noOp = noOpExport.declaration.init;
  assert(noOp?.type === "ArrowFunctionExpression" && hasFunctionFlags(noOp, false)
    && noOp.params.length === 0 && noOp.body.type === "BlockStatement"
    && noOp.body.body.length === 0, `${label} listener no-op is invalid`);
  const initialGuard = body[0];
  assert(initialGuard.type === "IfStatement" && !initialGuard.alternate && member(initialGuard.test, signalName, "aborted")
    && initialGuard.consequent.type === "ReturnStatement" && identifier(initialGuard.consequent.argument, "noOp"),
  `${label} listener initial abort guard is invalid`);

  const activeDeclaration = standaloneVariable(body[1], "active");
  const removedDeclaration = standaloneVariable(body[2], "removed");
  assert(activeDeclaration && literal(activeDeclaration.init, true) && removedDeclaration && literal(removedDeclaration.init, false),
    `${label} listener lifecycle declarations are invalid`);

  const handlerDeclaration = standaloneVariable(body[3], "handleUrl");
  const handler = handlerDeclaration?.init;
  const handlerParameter = handler?.params?.length === 1 ? handler.params[0] : null;
  assert(handler?.type === "ArrowFunctionExpression" && hasFunctionFlags(handler, false) && handlerParameter?.type === "ObjectPattern"
    && handlerParameter.properties.length === 1 && handlerParameter.properties[0].type === "Property"
    && identifier(handlerParameter.properties[0].key, "url") && identifier(handlerParameter.properties[0].value, "url")
    && handler.body.type === "BlockStatement" && handler.body.body.length === 3,
  `${label} listener URL handler is invalid`);
  assert(bindingIsImmutable(handler, "url", handlerParameter), `${label} listener URL binding must be immutable and unshadowed`);
  const handlerGuard = handler.body.body[0];
  const guardTest = handlerGuard?.type === "IfStatement" ? handlerGuard.test : null;
  assert(guardTest?.type === "LogicalExpression" && guardTest.operator === "||"
    && guardTest.left.type === "UnaryExpression" && guardTest.left.operator === "!" && identifier(guardTest.left.argument, "active")
    && member(guardTest.right, signalName, "aborted") && !handlerGuard.alternate
    && handlerGuard.consequent.type === "ReturnStatement" && handlerGuard.consequent.argument === null,
  `${label} listener handler abort guard is invalid`);

  const requestDeclaration = standaloneVariable(handler.body.body[1], "request");
  const parserCall = requestDeclaration?.init;
  const parserCallee = parserCall?.type === "CallExpression" ? canonicalCallee(parserCall.callee) : null;
  assert(parserCallee?.type === "MemberExpression" && parserCallee.object.type === "Identifier"
    && propertyName(parserCallee) === "parseFaultUrl" && parserCall.arguments.length === 1 && identifier(parserCall.arguments[0], "url"),
  `${label} listener parser delivery binding is invalid`);
  assert(bindingIsImmutable(handler, "request", requestDeclaration.id), `${label} listener parser result must be immutable and unshadowed`);
  const parserBinding = dependencyBinding(
    module,
    parserCallee.object.name,
    `${label} listener parser`,
    install,
    [parserCallee.object],
  );

  const delivery = handler.body.body[2];
  const deliveryCall = delivery?.type === "IfStatement" && !delivery.alternate && identifier(delivery.test, "request")
    ? expressionCall(delivery.consequent) : null;
  assert(deliveryCall && identifier(canonicalCallee(deliveryCall.callee), onFaultName) && deliveryCall.arguments.length === 1
    && identifier(deliveryCall.arguments[0], "request"), `${label} listener must directly deliver onFault(request)`);

  const registration = standaloneVariable(body[4], "subscription");
  const registrationCall = registration?.init;
  const registrationCallee = registrationCall?.type === "CallExpression" ? canonicalCallee(registrationCall.callee) : null;
  const registrationLinking = registrationCallee?.type === "MemberExpression" ? unwrapChain(registrationCallee.object) : null;
  const runtimeName = registrationLinking?.type === "MemberExpression" && propertyName(registrationLinking) === "Linking"
    && registrationLinking.object.type === "Identifier" ? registrationLinking.object.name : null;
  assert(runtimeName && linkingCall(registrationCall, runtimeName, "addEventListener") && registrationCall.arguments.length === 2
    && literal(registrationCall.arguments[0], "url") && identifier(registrationCall.arguments[1], "handleUrl"),
  `${label} listener URL registration is invalid`);
  const disposeDeclaration = standaloneVariable(body[5], "dispose");
  const dispose = disposeDeclaration?.init;
  assert(dispose?.type === "ArrowFunctionExpression" && hasFunctionFlags(dispose, false)
    && dispose.params.length === 0 && dispose.body.type === "BlockStatement"
    && dispose.body.body.length === 5, `${label} listener disposer is invalid`);
  const [removedGuard, deactivate, markRemoved, abortRemoval, subscriptionRemoval] = dispose.body.body;
  assert(removedGuard.type === "IfStatement" && !removedGuard.alternate && identifier(removedGuard.test, "removed")
    && removedGuard.consequent.type === "ReturnStatement" && removedGuard.consequent.argument === null,
  `${label} listener disposer guard is invalid`);
  const deactivateAssignment = statementAssignment(deactivate);
  const removedAssignment = statementAssignment(markRemoved);
  assert(deactivateAssignment?.type === "AssignmentExpression" && deactivateAssignment.operator === "="
    && identifier(deactivateAssignment.left, "active") && literal(deactivateAssignment.right, false)
    && removedAssignment?.type === "AssignmentExpression" && removedAssignment.operator === "="
    && identifier(removedAssignment.left, "removed") && literal(removedAssignment.right, true),
  `${label} listener disposer lifecycle writes are invalid`);
  const abortRemovalCall = expressionCall(abortRemoval);
  const subscriptionRemovalCall = expressionCall(subscriptionRemoval);
  assert(abortRemovalCall && callOnIdentifier(abortRemovalCall, signalName, "removeEventListener")
    && abortRemovalCall.arguments.length === 2 && literal(abortRemovalCall.arguments[0], "abort")
    && identifier(abortRemovalCall.arguments[1], "dispose"), `${label} listener abort removal is invalid`);
  assert(subscriptionRemovalCall && callOnIdentifier(subscriptionRemovalCall, "subscription", "remove")
    && subscriptionRemovalCall.arguments.length === 0, `${label} listener subscription disposal is invalid`);

  assert(bindingDefinitions(install, "active").length === 1 && bindingDefinitions(install, "active")[0] === activeDeclaration.id
    && bindingWrites(install, "active").length === 1 && bindingWrites(install, "active")[0] === deactivateAssignment,
  `${label} listener active binding writes are invalid`);
  assert(bindingDefinitions(install, "removed").length === 1 && bindingDefinitions(install, "removed")[0] === removedDeclaration.id
    && bindingWrites(install, "removed").length === 1 && bindingWrites(install, "removed")[0] === removedAssignment,
  `${label} listener removed binding writes are invalid`);
  assert(bindingIsImmutable(install, "handleUrl", handlerDeclaration.id)
    && bindingIsImmutable(install, "subscription", registration.id)
    && bindingIsImmutable(install, "dispose", disposeDeclaration.id), `${label} listener local bindings must be immutable and unshadowed`);

  const abortRegistration = expressionCall(body[6]);
  const onceProperties = abortRegistration?.arguments[2]?.type === "ObjectExpression"
    ? objectProperties(abortRegistration.arguments[2], "once") : [];
  assert(abortRegistration && callOnIdentifier(abortRegistration, signalName, "addEventListener")
    && abortRegistration.arguments.length === 3 && literal(abortRegistration.arguments[0], "abort")
    && identifier(abortRegistration.arguments[1], "dispose") && onceProperties.length === 1
    && abortRegistration.arguments[2].properties.length === 1 && literal(onceProperties[0].value, true),
  `${label} listener abort registration is invalid`);

  const initialFlow = body[7];
  assert(initialFlow.type === "TryStatement" && !initialFlow.finalizer && initialFlow.block.body.length === 3
    && initialFlow.handler?.param?.type === "Identifier" && initialFlow.handler.body.body.length === 2,
  `${label} listener initial URL control flow is invalid`);
  const initialUrl = standaloneVariable(initialFlow.block.body[0], "url");
  const initialCall = initialUrl?.init?.type === "AwaitExpression" ? directCall(initialUrl.init.argument) : null;
  assert(initialCall && linkingCall(initialCall, runtimeName, "getInitialURL") && initialCall.arguments.length === 0,
    `${label} listener initial URL lookup is invalid`);
  const initialCallee = canonicalCallee(initialCall.callee);
  const initialLinking = initialCallee?.type === "MemberExpression" ? unwrapChain(initialCallee.object) : null;
  const runtimeBinding = dependencyBinding(
    module,
    runtimeName,
    `${label} listener runtime`,
    install,
    [registrationLinking.object, initialLinking.object],
  );
  resolveDependency(graph, module, runtimeBinding.dependencyIndex, `${label} listener runtime`);
  const initialDispatch = initialFlow.block.body[1];
  const initialDispatchCall = initialDispatch.type === "IfStatement" && !initialDispatch.alternate && identifier(initialDispatch.test, "url")
    ? expressionCall(initialDispatch.consequent) : null;
  const dispatchProperties = initialDispatchCall?.arguments[0]?.type === "ObjectExpression"
    ? objectProperties(initialDispatchCall.arguments[0], "url") : [];
  assert(initialDispatchCall && identifier(canonicalCallee(initialDispatchCall.callee), "handleUrl")
    && initialDispatchCall.arguments.length === 1 && initialDispatchCall.arguments[0].properties.length === 1
    && dispatchProperties.length === 1 && identifier(dispatchProperties[0].value, "url"),
  `${label} listener initial URL dispatch is invalid`);
  assert(initialFlow.block.body[2].type === "ReturnStatement" && identifier(initialFlow.block.body[2].argument, "dispose"),
    `${label} listener must return its disposer`);
  const catchParameter = initialFlow.handler.param.name;
  const catchDispose = expressionCall(initialFlow.handler.body.body[0]);
  assert(catchDispose && identifier(canonicalCallee(catchDispose.callee), "dispose") && catchDispose.arguments.length === 0
    && initialFlow.handler.body.body[1].type === "ThrowStatement"
    && identifier(initialFlow.handler.body.body[1].argument, catchParameter), `${label} listener error path must dispose and rethrow`);

  const sentinelExport = finalNamedExport(module, "E2E_FAULT_CONTROLLER_BUNDLE_SENTINEL");
  assert(identifier(sentinelExport, "E2E_FAULT_CONTROLLER_BUNDLE_SENTINEL"), `${label} listener sentinel export is invalid`);
  const sentinel = topLevelVariable(module, "E2E_FAULT_CONTROLLER_BUNDLE_SENTINEL", `${label} listener sentinel`);
  assert(literal(sentinel.declaration.init, FAULT_CONTROLLER_SENTINEL), `${label} listener sentinel binding is invalid`);
  assertExactBindingReferences(
    module.factory.body,
    "installFaultController",
    install.id,
    [finalNamedExport(module, "installFaultController")],
    `${label} listener install export`,
  );
  assertExactBindingReferences(
    module.factory.body,
    "noOp",
    noOpExport.declaration.id,
    [initialGuard.consequent.argument],
    `${label} listener no-op`,
  );
  assertExactBindingReferences(
    module.factory.body,
    "E2E_FAULT_CONTROLLER_BUNDLE_SENTINEL",
    sentinel.declaration.id,
    [sentinelExport],
    `${label} listener sentinel`,
  );
  const sentinelLiterals = astNodes(module.factory.body, (node) => literal(node, FAULT_CONTROLLER_SENTINEL));
  assert.equal(sentinelLiterals.length, 1, `${label} listener sentinel must be one live literal`);
  return {
    module,
    parser: resolveDependency(graph, module, parserBinding.dependencyIndex, `${label} listener parser`),
  };
}

function allowedHas(node, argumentCheck) {
  const call = directCall(node);
  return call && member(canonicalCallee(call.callee), "allowed", "has") && call.arguments.length === 1 && argumentCheck(call.arguments[0]);
}

function matchIndexOne(node) {
  const value = node?.type === "ChainExpression" ? node.expression : node;
  return value?.type === "MemberExpression" && value.computed && identifier(value.object, "match") && literal(value.property, 1);
}

function parserEvidence(module, graph, label) {
  assertClosedExports(module, ["FAULT_POINTS", "canonicalFaultUrl", "parseFaultUrl"], `${label} parser`);
  const canonical = exportedFunction(module, "canonicalFaultUrl");
  const parser = exportedFunction(module, "parseFaultUrl");
  if (!hasFunctionFlags(canonical, false) || !hasFunctionFlags(parser, false)
    || canonical.params.length !== 1 || parser.params.length !== 1
    || !identifier(canonical.params[0], "point") || !identifier(parser.params[0], "value")
    || !bindingIsImmutable(canonical, "point", canonical.params[0]) || !bindingIsImmutable(parser, "value", parser.params[0])) return null;
  if (canonical.body.body.length !== 2 || parser.body.body.length !== 4) return null;
  const [canonicalGuard, canonicalReturn] = canonical.body.body;
  if (canonicalGuard.type !== "IfStatement" || canonicalGuard.test.type !== "UnaryExpression" || canonicalGuard.test.operator !== "!"
    || canonicalGuard.alternate || !allowedHas(canonicalGuard.test.argument, (argument) => identifier(argument, "point"))
    || canonicalGuard.consequent.type !== "ThrowStatement") return null;
  const template = canonicalReturn.type === "ReturnStatement" ? canonicalReturn.argument : null;
  if (template?.type !== "TemplateLiteral" || template.expressions.length !== 1 || !identifier(template.expressions[0], "point")
    || template.quasis[0].value.raw !== "formobile-test://fault?point=" || template.quasis[1].value.raw !== "&mode=crash_once") return null;
  const [matchStatement, parseGuard, requestStatement, parseReturn] = parser.body.body;
  const matchDeclaration = matchStatement.type === "VariableDeclaration" ? matchStatement.declarations[0] : null;
  const matchCall = matchDeclaration?.init;
  const regex = matchCall?.callee?.type === "MemberExpression" ? matchCall.callee.object : null;
  if (!identifier(matchDeclaration?.id, "match") || matchStatement.declarations.length !== 1 || matchCall?.type !== "CallExpression"
    || propertyName(canonicalCallee(matchCall.callee)) !== "exec" || matchCall.arguments.length !== 1 || regex?.type !== "Literal"
    || regex.regex?.pattern !== String.raw`^formobile-test:\/\/fault\?point=([a-z][a-z0-9_.]*)&mode=crash_once$`
    || regex.regex.flags !== "" || !identifier(matchCall.arguments[0], "value")) return null;
  const guardTest = parseGuard.type === "IfStatement" ? parseGuard.test : null;
  const guardReturn = parseGuard.type === "IfStatement" ? parseGuard.consequent : null;
  if (guardTest?.type !== "LogicalExpression" || guardTest.operator !== "||" || guardTest.left.type !== "UnaryExpression"
    || guardTest.left.operator !== "!" || !identifier(guardTest.left.argument, "match") || guardTest.right.type !== "UnaryExpression"
    || guardTest.right.operator !== "!" || !allowedHas(guardTest.right.argument, matchIndexOne)
    || parseGuard.alternate || guardReturn.type !== "ReturnStatement" || !literal(guardReturn.argument, null)) return null;
  const requestDeclaration = requestStatement.type === "VariableDeclaration" ? requestStatement.declarations[0] : null;
  const requestProperties = requestDeclaration?.init?.type === "ObjectExpression" ? requestDeclaration.init.properties : [];
  if (!identifier(requestDeclaration?.id, "request") || requestStatement.declarations.length !== 1 || requestProperties.length !== 2
    || !requestProperties.some((property) => property.type === "Property" && identifier(property.key, "point") && matchIndexOne(property.value))
    || !requestProperties.some((property) => property.type === "Property" && identifier(property.key, "mode") && literal(property.value, "crash_once"))) return null;
  const conditional = parseReturn.type === "ReturnStatement" ? parseReturn.argument : null;
  const equality = conditional?.type === "ConditionalExpression" ? conditional.test : null;
  const canonicalCall = equality?.type === "BinaryExpression" ? equality.left : null;
  if (equality?.operator !== "===" || canonicalCall?.type !== "CallExpression" || !identifier(canonicalCallee(canonicalCall.callee), "canonicalFaultUrl")
    || canonicalCall.arguments.length !== 1
    || canonicalCall.arguments[0]?.type !== "MemberExpression" || !identifier(canonicalCall.arguments[0].object, "request")
    || propertyName(canonicalCall.arguments[0]) !== "point" || !identifier(equality.right, "value")
    || !identifier(conditional.consequent, "request") || !literal(conditional.alternate, null)) return null;
  if (!bindingIsImmutable(parser, "match", matchDeclaration.id) || !bindingIsImmutable(parser, "request", requestDeclaration.id)) return null;

  const faultPointsBinding = topLevelVariable(module, "faultPoints", `${label} parser interop result`, { includeMembers: true });
  const faultPointsImport = faultPointsBinding.declaration.init;
  const interopReference = faultPointsImport?.type === "CallExpression" ? canonicalCallee(faultPointsImport.callee) : null;
  const interopName = faultPointsImport?.type === "CallExpression" && faultPointsImport.arguments.length === 1
    && identifier(faultPointsImport.arguments[0], "_faultPointsJson") && interopReference?.type === "Identifier"
    ? interopReference.name : null;
  if (!interopName) return null;
  const registryBinding = dependencyBinding(
    module,
    "_faultPointsJson",
    `${label} parser registry import`,
    faultPointsBinding.statement,
    [faultPointsImport.arguments[0]],
  );
  canonicalInteropFunction(module, interopName, `${label} parser`, faultPointsBinding.statement, interopReference);

  const frozenBinding = topLevelVariable(module, "FAULT_POINTS", `${label} parser frozen registry`, { includeMembers: true });
  const allowedBinding = topLevelVariable(module, "allowed", `${label} parser allowlist`, { before: canonical, includeMembers: true });
  const frozenPoints = frozenBinding.declaration.init;
  const allowed = allowedBinding.declaration.init;
  const faultPointsIndex = module.factory.body.body.indexOf(faultPointsBinding.statement);
  const frozenIndex = module.factory.body.body.indexOf(frozenBinding.statement);
  const allowedIndex = module.factory.body.body.indexOf(allowedBinding.statement);
  if (faultPointsIndex < 0 || frozenIndex <= faultPointsIndex || allowedIndex <= frozenIndex
    || frozenPoints?.type !== "CallExpression" || !member(canonicalCallee(frozenPoints.callee), "Object", "freeze")
    || frozenPoints.arguments.length !== 1 || frozenPoints.arguments[0]?.type !== "ArrayExpression"
    || frozenPoints.arguments[0].elements.length !== 1 || frozenPoints.arguments[0].elements[0]?.type !== "SpreadElement"
    || !member(frozenPoints.arguments[0].elements[0].argument, "faultPoints", "default")
    || allowed?.type !== "NewExpression" || !identifier(allowed.callee, "Set") || allowed.arguments.length !== 1
    || !identifier(allowed.arguments[0], "FAULT_POINTS") || !identifier(finalNamedExport(module, "FAULT_POINTS"), "FAULT_POINTS")) return null;
  const faultPointsReference = unwrapChain(frozenPoints.arguments[0].elements[0].argument).object;
  const canonicalAllowed = directCall(canonicalGuard.test.argument);
  const parserAllowed = directCall(guardTest.right.argument);
  assertExactBindingReferences(
    module.factory.body,
    "canonicalFaultUrl",
    canonical.id,
    [finalNamedExport(module, "canonicalFaultUrl"), canonicalCallee(canonicalCall.callee)],
    `${label} canonical fault URL`,
  );
  assertExactBindingReferences(
    module.factory.body,
    "parseFaultUrl",
    parser.id,
    [finalNamedExport(module, "parseFaultUrl")],
    `${label} parser export`,
  );
  assertExactBindingReferences(
    module.factory.body,
    "faultPoints",
    faultPointsBinding.declaration.id,
    [faultPointsReference],
    `${label} parser interop result`,
  );
  assertExactBindingReferences(
    module.factory.body,
    "FAULT_POINTS",
    frozenBinding.declaration.id,
    [finalNamedExport(module, "FAULT_POINTS"), allowed.arguments[0]],
    `${label} frozen fault points`,
  );
  assertExactBindingReferences(
    module.factory.body,
    "allowed",
    allowedBinding.declaration.id,
    [canonicalCallee(canonicalAllowed.callee).object, canonicalCallee(parserAllowed.callee).object],
    `${label} parser allowlist`,
  );
  return { module, registry: resolveDependency(graph, module, registryBinding.dependencyIndex, `${label} parser registry`) };
}

function registryValue(module) {
  if (module.factory.body.body.length !== 1) return null;
  const statement = module.factory.body.body[0];
  const assignment = statement.type === "ExpressionStatement" && statement.expression.type === "AssignmentExpression"
    ? statement.expression : null;
  const value = assignment?.type === "AssignmentExpression" && assignment.operator === "=" && isModuleExports(assignment.left)
    ? assignment.right
    : null;
  if (value?.type !== "ArrayExpression" || value.elements.some((element) => element?.type !== "Literal" || typeof element.value !== "string")) return null;
  return value.elements.map((element) => element.value);
}

function noOpController(module) {
  assertClosedExports(module, ["installFaultController", "traceBootstrap"], "production controller");
  assertCanonicalMetroImports(module, "production controller");
  assertPristineIntrinsics(module, "production controller trace module");
  const install = exportedFunction(module, "installFaultController");
  if (!hasFunctionFlags(install, true) || install.body.body.length !== 1
    || install.body.body[0].type !== "ReturnStatement" || install.body.body[0].argument?.type !== "Identifier") return false;
  const noOpName = install.body.body[0].argument.name;
  const binding = topLevelVariable(module, noOpName, "production controller no-op", { before: install });
  const initializer = binding.declaration.init;
  const valid = ["ArrowFunctionExpression", "FunctionExpression"].includes(initializer?.type)
    && hasFunctionFlags(initializer, false) && initializer.params.length === 0
    && initializer.body.type === "BlockStatement" && initializer.body.body.length === 0;
  if (!valid) return false;
  assertExactBindingReferences(
    module.factory.body,
    "installFaultController",
    install.id,
    [finalNamedExport(module, "installFaultController")],
    "production controller install export",
  );
  assertExactBindingReferences(
    module.factory.body,
    noOpName,
    binding.declaration.id,
    [install.body.body[0].argument],
    "production controller no-op",
  );
  const traceExport = unwrapExpression(finalNamedExport(module, "traceBootstrap"));
  const undefinedExpression = (value) => identifier(value, "undefined")
    || value?.type === "UnaryExpression" && value.operator === "void" && literal(value.argument, 0);
  if (bindingDefinitions(module.factory.body, "undefined").length !== 0
    || bindingWrites(module.factory.body, "undefined").length !== 0) return false;
  if (undefinedExpression(traceExport)) return true;
  if (traceExport?.type !== "Identifier") return false;
  const traceBinding = topLevelVariable(module, traceExport.name, "production controller absent trace");
  if (!undefinedExpression(traceBinding.declaration.init)) return false;
  assertExactBindingReferences(
    module.factory.body,
    traceExport.name,
    traceBinding.declaration.id,
    [traceExport],
    "production controller absent trace",
  );
  return true;
}

function moduleGraph(bytes, label, flavor) {
  const graph = parseMetroBundle(bytes, label);
  const reachable = reachableModules(graph, label);
  const apps = [...reachable.values()].map((module) => appEvidence(module, graph, label)).filter(Boolean);
  assert.equal(apps.length, 1, `${label} bundle must contain one distinct reachable App module wired to the selected controller`);
  const app = apps[0];
  rootRegistersApp(graph, app.module, label);
  assert.notEqual(app.module.moduleId, app.controller.moduleId, `${label} App and controller modules must be distinct`);
  if (flavor === "production") {
    assert(noOpController(app.controller), `${label} production App must reach the exact exported no-op controller`);
    const reachableSentinels = [...reachable.values()].flatMap((module) => astNodes(module.factory.body, (node) => literal(node, FAULT_CONTROLLER_SENTINEL) || literal(node, BOOTSTRAP_TRACE_SENTINEL)));
    const reachableParsers = [...reachable.values()].filter((module) => finalNamedExport(module, "parseFaultUrl"));
    const reachableRegistries = [...reachable.values()].filter((module) => JSON.stringify(registryValue(module)) === JSON.stringify(faultPoints));
    assert.equal(reachableSentinels.length, 0, `${label} production reachable graph contains an E2E listener sentinel`);
    assert.equal(reachableParsers.length, 0, `${label} production reachable graph contains an E2E parser export`);
    assert.equal(reachableRegistries.length, 0, `${label} production reachable graph contains an E2E registry`);
    return;
  }
  const listener = listenerEvidence(app.controller, graph, label);
  assert(listener, `${label} E2E App controller must be the live exported listener implementation`);
  assert(reachable.has(listener.parser.moduleId), `${label} E2E parser must be reachable from a Metro root`);
  const parser = parserEvidence(listener.parser, graph, label);
  assert(parser, `${label} E2E parser exports must be the checked live implementations`);
  assert(reachable.has(parser.registry.moduleId), `${label} E2E registry must be reachable from a Metro root`);
  assert.deepEqual(registryValue(parser.registry), faultPoints, `${label} E2E registry final module.exports must be the exact ordered array`);
  assert.equal(parser.registry.dependencies.length, 0, `${label} E2E registry module must not have dependencies`);
  assert.equal(new Set([app.module.moduleId, listener.module.moduleId, parser.module.moduleId, parser.registry.moduleId]).size, 4,
    `${label} App, listener, parser, and registry modules must be distinct`);
}

/**
 * @param {any} proof
 * @param {{ root?: string, expectedSha?: string }} [options]
 * @returns {Promise<Record<"android" | "ios", Record<"production" | "e2e", {
 *     path: string,
 *     bytes: number,
 *     sha256: string,
 *     sentinelOccurrences: number
 *   }>>>}
 */
export async function validateFaultBundleProof(proof, options = {}) {
  const { root = repoRoot, expectedSha } = options;
  assert(
    hasExactKeys(proof, ["schemaVersion", "checkedOutSha", "platforms", "exportFlags", "markers", "expectedMarkerCounts", "bundles"]),
    "Fault bundle proof contains unknown or missing root fields",
  );
  assert.equal(proof?.schemaVersion, 3, "Fault bundle proof schema is invalid");
  assert.equal(proof?.checkedOutSha, expectedSha, "Fault bundle proof SHA disagrees with the exact checkout");
  assert.deepEqual(proof?.platforms, FAULT_BUNDLE_PLATFORMS, "Fault bundle proof platforms are invalid");
  assert.deepEqual(proof?.exportFlags, FAULT_BUNDLE_EXPORT_FLAGS, "Fault bundle proof must use text bundles without minification");
  assert.deepEqual(proof?.markers, FAULT_BUNDLE_MARKERS, "Fault bundle proof markers are invalid");
  assert(
    hasExactKeys(proof?.expectedMarkerCounts, FAULT_BUNDLE_FLAVORS),
    "Fault bundle proof expected counts contain unknown or missing flavor fields",
  );
  for (const flavor of FAULT_BUNDLE_FLAVORS) {
    assertMarkerCounts(proof.expectedMarkerCounts[flavor], `${flavor} expected marker counts`);
    assert.deepEqual(
      proof.expectedMarkerCounts[flavor],
      FAULT_BUNDLE_EXPECTED_MARKER_COUNTS[flavor],
      "Fault bundle proof expected marker counts are invalid",
    );
  }
  assert(hasExactKeys(proof?.bundles, FAULT_BUNDLE_PLATFORMS), "Fault bundle proof contains unknown or missing platform fields");

  const bundles = {};
  for (const platform of FAULT_BUNDLE_PLATFORMS) {
    assert(hasExactKeys(proof.bundles[platform], FAULT_BUNDLE_FLAVORS), `${platform} fault bundle proof contains unknown or missing flavor fields`);
    bundles[platform] = {};
    for (const flavor of FAULT_BUNDLE_FLAVORS) {
      const label = `${platform} ${flavor}`;
      const entry = proof?.bundles?.[platform]?.[flavor];
      assert(entry && typeof entry === "object", `${label} fault bundle evidence is absent`);
      assert(
        hasExactKeys(entry, ["path", "bytes", "sha256", "observedMarkerCounts", "metadata"]),
        `${label} fault bundle entry contains unknown or missing fields`,
      );
      assertMarkerCounts(entry.observedMarkerCounts, `${label} observed marker counts`);
      assert(hasExactKeys(entry.metadata, ["path", "bytes", "sha256"]), `${label} metadata evidence contains unknown or missing fields`);
      assertCanonicalBundlePath(entry.path, platform, flavor);
      await validateFlavorExportTree(root, platform, flavor, entry.path);
      assert.equal(await canonicalBundlePath(root, platform, flavor), entry.path, `${label} proof does not identify the sole canonical bundle`);
      const absolute = resolve(root, entry.path);
      assert.equal(relative(resolve(root), absolute).split(sep)[0], ".artifacts", `${label} bundle resolves outside retained artifacts`);
      const stat = await lstat(absolute);
      assert(stat.isFile() && !stat.isSymbolicLink(), `${label} bundle must be a retained regular file`);
      const bytes = await readFile(absolute);
      assert(bytes.length > 0, `${label} bundle is empty`);
      assert.equal(entry.bytes, bytes.length, `${label} bundle byte count disagrees`);
      assert.equal(entry.sha256, sha256(bytes), `${label} bundle hash disagrees`);
      const observedMarkerCounts = markerCounts(bytes);
      for (const marker of FAULT_BUNDLE_MARKERS) {
        assert.equal(
          entry.observedMarkerCounts[marker],
          observedMarkerCounts[marker],
          `${label} observed marker count disagrees for ${JSON.stringify(marker)}`,
        );
        assert.equal(
          observedMarkerCounts[marker],
          FAULT_BUNDLE_EXPECTED_MARKER_COUNTS[flavor][marker],
          `${label} marker count is invalid for ${JSON.stringify(marker)}`,
        );
      }
      moduleGraph(bytes, label, flavor);
      const exportPrefix = `.artifacts/fault-bundles/${platform}/${flavor}/`;
      assert.equal(entry.metadata.path, `${exportPrefix}metadata.json`, `${label} metadata path is not canonical`);
      const metadataAbsolute = resolve(root, entry.metadata.path);
      const metadataStat = await lstat(metadataAbsolute);
      assert(metadataStat.isFile() && !metadataStat.isSymbolicLink(), `${label} metadata must be a retained regular file`);
      const metadataBytes = await readFile(metadataAbsolute);
      assert.equal(entry.metadata.bytes, metadataBytes.length, `${label} metadata byte count disagrees`);
      assert.equal(entry.metadata.sha256, sha256(metadataBytes), `${label} metadata hash disagrees`);
      const metadata = JSON.parse(metadataBytes.toString("utf8"));
      assert(hasExactKeys(metadata, ["version", "bundler", "fileMetadata"]), `${label} Expo metadata contains unknown or missing root fields`);
      assert.equal(metadata.version, 0, `${label} Expo metadata version must remain 0`);
      assert.equal(metadata.bundler, "metro", `${label} Expo metadata bundler must remain metro`);
      assert(hasExactKeys(metadata.fileMetadata, [platform]), `${label} Expo metadata contains unknown or missing platform fields`);
      assert(hasExactKeys(metadata.fileMetadata[platform], ["bundle", "assets"]), `${label} Expo metadata platform entry contains unknown or missing fields`);
      assert(Array.isArray(metadata.fileMetadata[platform].assets), `${label} Expo metadata assets must be an array`);
      assert.equal(`${exportPrefix}${metadata.fileMetadata[platform].bundle}`, entry.path, `${label} Expo metadata bundle does not match the validated canonical bundle`);
      bundles[platform][flavor] = {
        path: entry.path,
        bytes: bytes.length,
        sha256: entry.sha256,
        sentinelOccurrences: observedMarkerCounts[FAULT_CONTROLLER_SENTINEL],
      };
    }
  }
  return bundles;
}

function gitHead() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

export async function buildFaultBundleProof(root = repoRoot) {
  const proofPath = resolve(root, FAULT_BUNDLE_PROOF_PATH);
  await rm(dirname(proofPath), { recursive: true, force: true });
  await mkdir(dirname(proofPath), { recursive: true });
  const proof = {
    schemaVersion: 3,
    checkedOutSha: gitHead(),
    platforms: FAULT_BUNDLE_PLATFORMS,
    exportFlags: FAULT_BUNDLE_EXPORT_FLAGS,
    markers: FAULT_BUNDLE_MARKERS,
    expectedMarkerCounts: FAULT_BUNDLE_EXPECTED_MARKER_COUNTS,
    bundles: {},
  };
  for (const platform of FAULT_BUNDLE_PLATFORMS) {
    proof.bundles[platform] = {};
    for (const flavor of FAULT_BUNDLE_FLAVORS) {
      const output = resolve(root, `.artifacts/fault-bundles/${platform}/${flavor}`);
      const args = ["--no-install", "expo", "export", "--output-dir", output, "--platform", platform, ...FAULT_BUNDLE_EXPORT_FLAGS];
      const result = spawnSync("npx", args, {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, EXPO_PUBLIC_FOR_MOBILE_BUILD_FLAVOR: flavor },
        maxBuffer: 32 * 1024 * 1024,
      });
      assert.equal(result.status, 0, `${platform} ${flavor} text export failed:\n${result.stdout}\n${result.stderr}`);
      const path = await canonicalBundlePath(root, platform, flavor);
      const bytes = await readFile(resolve(root, path));
      const metadataPath = relative(root, resolve(output, "metadata.json")).split(sep).join("/");
      const metadataBytes = await readFile(resolve(output, "metadata.json"));
      proof.bundles[platform][flavor] = {
        path,
        bytes: bytes.length,
        sha256: sha256(bytes),
        observedMarkerCounts: markerCounts(bytes),
        metadata: { path: metadataPath, bytes: metadataBytes.length, sha256: sha256(metadataBytes) },
      };
    }
  }
  await validateFaultBundleProof(proof, { root, expectedSha: proof.checkedOutSha });
  await writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify({ faultBundles: "pass", proof: FAULT_BUNDLE_PROOF_PATH, checkedOutSha: proof.checkedOutSha }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildFaultBundleProof();
