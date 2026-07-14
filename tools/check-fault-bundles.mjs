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
  protocolMarker,
  modeMarker,
  ...faultPoints,
]);
assert(FAULT_BUNDLE_MARKERS.every((marker) => marker.length > 0), "Fault bundle markers must be nonempty");
assert.equal(new Set(FAULT_BUNDLE_MARKERS).size, FAULT_BUNDLE_MARKERS.length, "Fault bundle markers must be unique");
assert.deepEqual(FAULT_BUNDLE_MARKERS.slice(3), faultPoints, "Fault bundle point markers must preserve the exact registry");

function expectedCounts(flavor) {
  // Tripwire for the current source topology: sentinel/protocol/mode/each registry point = 1/2/3/1.
  return Object.freeze(Object.fromEntries(FAULT_BUNDLE_MARKERS.map((marker) => [
    marker,
    flavor === "production"
      ? 0
      : marker === FAULT_CONTROLLER_SENTINEL
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

function propertyName(member) {
  if (member?.type !== "MemberExpression") return null;
  if (!member.computed && member.property.type === "Identifier") return member.property.name;
  return member.property.type === "Literal" && typeof member.property.value === "string" ? member.property.value : null;
}

function member(node, objectName, memberName) {
  const value = unwrapExpression(node);
  return value?.type === "MemberExpression" && identifier(value.object, objectName) && propertyName(value) === memberName;
}

function dependencyMapIndex(node, mapName) {
  const value = unwrapExpression(node);
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
    const call = statement.type === "ExpressionStatement" ? unwrapExpression(statement.expression) : null;
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
      assert(factory?.type === "FunctionExpression" && factory.body.type === "BlockStatement", `${label} Metro __d factory is invalid`);
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
        : statement.type === "ExpressionStatement" ? [unwrapExpression(statement.expression)] : [];
      for (const expression of expressions) {
        const call = expression?.type === "CallExpression" && identifier(unwrapExpression(expression.callee), module.requireName)
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

function dependencyBinding(module, name, label, before) {
  const binding = topLevelVariable(module, name, label, { before, includeMembers: true });
  const call = binding.declaration.init;
  assert(call?.type === "CallExpression" && identifier(call.callee, module.requireName) && call.arguments.length === 1,
    `${label} must be one direct Metro dependency import`);
  const dependencyIndex = dependencyMapIndex(call.arguments[0], module.dependencyMapName);
  assert.notEqual(dependencyIndex, null, `${label} must use the Metro dependency map`);
  assert(module.usedDependencyIndexes.includes(dependencyIndex), `${label} import must be reachable before termination`);
  return { ...binding, name, dependencyIndex };
}

function canonicalInteropFunction(module, name, label, before) {
  const fn = functionDeclaration(module, name);
  assert(fn && fn.params.length === 1 && fn.params[0].type === "Identifier" && fn.body.body.length === 1,
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
  return fn;
}

function namedExportTarget(node, name) {
  const value = unwrapExpression(node);
  if (value?.type !== "MemberExpression" || propertyName(value) !== name) return false;
  return identifier(value.object, "exports") || isModuleExports(value.object);
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
    const descriptor = expression.arguments[2];
    const valueProperty = descriptor.properties.find((property) => property.type === "Property" && identifier(property.key, "value"));
    const getProperty = descriptor.properties.find((property) => property.type === "Property" && identifier(property.key, "get"));
    const getterReturns = getProperty?.value?.body?.type === "BlockStatement"
      ? getProperty.value.body.body.filter((bodyStatement) => bodyStatement.type === "ReturnStatement")
      : [];
    if (valueProperty?.type === "Property") value = valueProperty.value;
    else if (getterReturns.length === 1) value = getterReturns[0].argument;
    else value = null;
  }
  return value;
}

function assertClosedExports(module, allowedNames, label) {
  const allowed = new Set(["__esModule", ...allowedNames]);
  const definitions = new Map();
  const parents = new Map();
  walkAst(module.factory.body, (node, parent) => parents.set(node, parent));
  const isExportObject = (node) => identifier(node, "exports") || isModuleExports(node);
  const topLevelStatement = (node) => {
    let current = node;
    while (parents.get(current) && parents.get(current) !== module.factory.body) current = parents.get(current);
    return parents.get(current) === module.factory.body ? current : null;
  };
  walkAst(module.factory.body, (node, parent) => {
    if (identifier(node, "exports") && parent?.type === "MemberExpression" && !parent.computed
      && identifier(parent.object, "module") && parent.property === node) return;
    if (!isExportObject(node)) return;
    if (parent?.type === "MemberExpression" && parent.object === node) {
      const assignment = parents.get(parent);
      const statement = topLevelStatement(assignment);
      const name = propertyName(parent);
      assert(assignment?.type === "AssignmentExpression" && assignment.left === parent && assignment.operator === "="
        && statement?.type === "ExpressionStatement" && statement.expression === assignment
        && name && allowed.has(name), `${label} contains an unrecognized or non-top-level export assignment`);
      definitions.set(name, (definitions.get(name) ?? 0) + 1);
      return;
    }
    if (parent?.type === "CallExpression" && parent.arguments[0] === node) {
      const statement = topLevelStatement(parent);
      const name = parent.arguments[1]?.value;
      assert(member(canonicalCallee(parent.callee), "Object", "defineProperty") && parent.arguments.length === 3
        && statement?.type === "ExpressionStatement" && directCall(statement.expression) === parent
        && typeof name === "string" && allowed.has(name) && parent.arguments[2]?.type === "ObjectExpression",
      `${label} contains an unrecognized or non-top-level export definition`);
      if (name === "__esModule") {
        const descriptor = parent.arguments[2];
        assert(descriptor.properties.length === 1 && descriptor.properties[0].type === "Property"
          && propertyName({ type: "MemberExpression", computed: descriptor.properties[0].computed, property: descriptor.properties[0].key }) === "value"
          && literal(descriptor.properties[0].value, true), `${label} __esModule export descriptor is invalid`);
      }
      definitions.set(name, (definitions.get(name) ?? 0) + 1);
      return;
    }
    assert.fail(`${label} export object must not be rebound, read, aliased, wrapped, or escaped`);
  });
  for (const name of allowed) assert.equal(definitions.get(name), 1, `${label} export ${name} must have one top-level definition`);
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
  return { call, runtimeName: callee.object.name, component: call.arguments[0], props: call.arguments[1] };
}

function renderedComponent(expression, componentName) {
  const matches = [];
  const runtimeNames = new Set();
  const visit = (value, root = false) => {
    if (value?.type === "ArrayExpression") {
      for (const element of value.elements) visit(element);
      return true;
    }
    const call = directCall(value);
    if (!call) return false;
    const callee = canonicalCallee(call.callee);
    if (identifier(callee, componentName)) {
      if (call.arguments.length === 1 && call.arguments[0]?.type === "ObjectExpression") matches.push({ call, props: call.arguments[0] });
      return true;
    }
    const jsx = jsxCall(call);
    if (!jsx) return false;
    runtimeNames.add(jsx.runtimeName);
    if (identifier(jsx.component, componentName)) matches.push({ call, props: jsx.props });
    for (const property of jsx.props.properties) {
      if (property.type !== "Property" || property.kind !== "init") return false;
      visit(property.value);
    }
    return true;
  };
  const validRoot = visit(expression, true);
  return { matches, runtimeNames: [...runtimeNames], validRoot };
}

function assertJsxRuntimeBindings(module, runtimeNames, before, label) {
  assert(runtimeNames.length <= 1, `${label} must use one JSX runtime namespace`);
  if (runtimeNames.length === 1) dependencyBinding(module, runtimeNames[0], `${label} JSX runtime`, before);
}

function appEvidence(module, graph, label) {
  const appComposition = exportedFunction(module, "AppComposition");
  if (!appComposition) return null;
  assertClosedExports(module, ["AppComposition", "default"], `${label} App`);
  const defaultApp = exportedFunction(module, "default");
  if (!defaultApp || defaultApp.params.length !== 0 || defaultApp.body.body.length !== 1
    || defaultApp.body.body[0].type !== "ReturnStatement") return null;
  const appRender = renderedComponent(defaultApp.body.body[0].argument, "AppComposition");
  if (!appRender.validRoot || appRender.matches.length !== 1 || appRender.matches[0].props.properties.length !== 0) return null;
  assertJsxRuntimeBindings(module, appRender.runtimeNames, defaultApp, `${label} default App`);

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
  const controllerBinding = dependencyBinding(module, defaultValue.object.name, `${label} App controller`, appComposition);

  if (appComposition.body.body.length !== 1 || appComposition.body.body[0].type !== "ReturnStatement") return null;
  const hostRender = renderedComponent(appComposition.body.body[0].argument, "FaultControllerHost");
  if (!hostRender.validRoot || hostRender.matches.length !== 1) return null;
  assertJsxRuntimeBindings(module, hostRender.runtimeNames, appComposition, `${label} AppComposition`);
  const installProperties = objectProperties(hostRender.matches[0].props, "installFaults");
  if (installProperties.length !== 1 || !identifier(installProperties[0].value, "installFaults")) return null;

  const host = functionDeclaration(module, "FaultControllerHost");
  if (!host) return null;
  const hostParameter = host.params.find((candidate) => candidate.type === "ObjectPattern" && patternContains(candidate, "installFaults"));
  if (!hostParameter || !bindingIsImmutable(host, "installFaults", hostParameter)) return null;
  const installs = astNodes(host.body, (node) => node.type === "CallExpression" && identifier(canonicalCallee(node.callee), "installFaults"));
  if (installs.length !== 1) return null;
  return { module, controller: resolveDependency(graph, module, controllerBinding.dependencyIndex, `${label} App controller`) };
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
      const helperName = canonicalCallee(interopCall.callee).name;
      canonicalInteropFunction(root, helperName, `${label} root`, appInterop.statement);
      const importedName = interopCall.arguments[0].name;
      const appBinding = dependencyBinding(root, importedName, `${label} root App import`, appInterop.statement);
      const runtimeBinding = dependencyBinding(root, callee.object.name, `${label} root runtime import`, statement);
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
  const linking = callee?.type === "MemberExpression" ? unwrapExpression(callee.object) : null;
  return propertyName(callee) === methodName && linking?.type === "MemberExpression" && !linking.computed
    && propertyName(linking) === "Linking" && identifier(linking.object, runtimeName);
}

function expressionCall(statement) {
  return statement?.type === "ExpressionStatement" ? directCall(statement.expression) : null;
}

function listenerEvidence(module, graph, label) {
  assertClosedExports(module, ["E2E_FAULT_CONTROLLER_BUNDLE_SENTINEL", "installFaultController"], `${label} listener`);
  const install = exportedFunction(module, "installFaultController");
  assert(install?.async && install.params.length === 2 && install.params.every((parameter) => parameter.type === "Identifier"),
    `${label} listener final installFaultController export is invalid`);
  const [onFaultName, signalName] = install.params.map((parameter) => parameter.name);
  assert(bindingIsImmutable(install, onFaultName, install.params[0]) && bindingIsImmutable(install, signalName, install.params[1]),
    `${label} listener parameters must be immutable and unshadowed`);
  const body = install.body.body;
  assert.equal(body.length, 8, `${label} listener control flow must use the exact installation statement sequence`);

  const noOpExport = topLevelVariable(module, "noOp", `${label} listener no-op`, { before: install });
  const noOp = noOpExport.declaration.init;
  assert(noOp?.type === "ArrowFunctionExpression" && noOp.params.length === 0 && noOp.body.type === "BlockStatement"
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
  assert(handler?.type === "ArrowFunctionExpression" && !handler.async && handlerParameter?.type === "ObjectPattern"
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
  const parserBinding = dependencyBinding(module, parserCallee.object.name, `${label} listener parser`, install);

  const delivery = handler.body.body[2];
  const deliveryCall = delivery?.type === "IfStatement" && !delivery.alternate && identifier(delivery.test, "request")
    ? expressionCall(delivery.consequent) : null;
  assert(deliveryCall && identifier(canonicalCallee(deliveryCall.callee), onFaultName) && deliveryCall.arguments.length === 1
    && identifier(deliveryCall.arguments[0], "request"), `${label} listener must directly deliver onFault(request)`);

  const registration = standaloneVariable(body[4], "subscription");
  const registrationCall = registration?.init;
  const registrationCallee = registrationCall?.type === "CallExpression" ? canonicalCallee(registrationCall.callee) : null;
  const registrationLinking = registrationCallee?.type === "MemberExpression" ? unwrapExpression(registrationCallee.object) : null;
  const runtimeName = registrationLinking?.type === "MemberExpression" && propertyName(registrationLinking) === "Linking"
    && registrationLinking.object.type === "Identifier" ? registrationLinking.object.name : null;
  assert(runtimeName && linkingCall(registrationCall, runtimeName, "addEventListener") && registrationCall.arguments.length === 2
    && literal(registrationCall.arguments[0], "url") && identifier(registrationCall.arguments[1], "handleUrl"),
  `${label} listener URL registration is invalid`);
  const runtimeBinding = dependencyBinding(module, runtimeName, `${label} listener runtime`, install);
  resolveDependency(graph, module, runtimeBinding.dependencyIndex, `${label} listener runtime`);

  const disposeDeclaration = standaloneVariable(body[5], "dispose");
  const dispose = disposeDeclaration?.init;
  assert(dispose?.type === "ArrowFunctionExpression" && dispose.params.length === 0 && dispose.body.type === "BlockStatement"
    && dispose.body.body.length === 5, `${label} listener disposer is invalid`);
  const [removedGuard, deactivate, markRemoved, abortRemoval, subscriptionRemoval] = dispose.body.body;
  assert(removedGuard.type === "IfStatement" && !removedGuard.alternate && identifier(removedGuard.test, "removed")
    && removedGuard.consequent.type === "ReturnStatement" && removedGuard.consequent.argument === null,
  `${label} listener disposer guard is invalid`);
  const deactivateAssignment = deactivate.type === "ExpressionStatement" ? unwrapExpression(deactivate.expression) : null;
  const removedAssignment = markRemoved.type === "ExpressionStatement" ? unwrapExpression(markRemoved.expression) : null;
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
  if (!canonical || !parser || canonical.params.length !== 1 || parser.params.length !== 1
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
  const registryBinding = dependencyBinding(module, "_faultPointsJson", `${label} parser registry import`, faultPointsBinding.statement);
  const faultPointsImport = faultPointsBinding.declaration.init;
  const interopName = faultPointsImport?.type === "CallExpression" && faultPointsImport.arguments.length === 1
    && identifier(faultPointsImport.arguments[0], "_faultPointsJson") && canonicalCallee(faultPointsImport.callee)?.type === "Identifier"
    ? canonicalCallee(faultPointsImport.callee).name : null;
  if (!interopName) return null;
  canonicalInteropFunction(module, interopName, `${label} parser`, faultPointsBinding.statement);

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
  return { module, registry: resolveDependency(graph, module, registryBinding.dependencyIndex, `${label} parser registry`) };
}

function registryValue(module) {
  if (module.factory.body.body.length !== 1) return null;
  const statement = module.factory.body.body[0];
  const assignment = statement.type === "ExpressionStatement" ? unwrapExpression(statement.expression) : null;
  const value = assignment?.type === "AssignmentExpression" && assignment.operator === "=" && isModuleExports(assignment.left)
    ? assignment.right
    : null;
  if (value?.type !== "ArrayExpression" || value.elements.some((element) => element?.type !== "Literal" || typeof element.value !== "string")) return null;
  return value.elements.map((element) => element.value);
}

function noOpController(module) {
  assertClosedExports(module, ["installFaultController"], "production controller");
  const install = exportedFunction(module, "installFaultController");
  if (!install?.async || install.body.body.length !== 1 || install.body.body[0].type !== "ReturnStatement" || install.body.body[0].argument?.type !== "Identifier") return false;
  const noOpName = install.body.body[0].argument.name;
  const binding = topLevelVariable(module, noOpName, "production controller no-op", { before: install });
  const initializer = binding.declaration.init;
  return ["ArrowFunctionExpression", "FunctionExpression"].includes(initializer?.type) && initializer.params.length === 0
    && initializer.body.type === "BlockStatement" && initializer.body.body.length === 0;
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
    const reachableSentinels = [...reachable.values()].flatMap((module) => astNodes(module.factory.body, (node) => literal(node, FAULT_CONTROLLER_SENTINEL)));
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
