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

function memberCall(node, memberName) {
  return node?.type === "CallExpression" && propertyName(unwrapExpression(node.callee)) === memberName;
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

function dependencyBindings(module) {
  const bindings = [];
  for (const statement of module.factory.body.body) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declaration of statement.declarations) {
      const call = declaration.init?.type === "CallExpression" ? declaration.init : null;
      if (!identifier(declaration.id, declaration.id?.name) || !call || !identifier(unwrapExpression(call.callee), module.requireName)) continue;
      const dependencyIndex = dependencyMapIndex(call.arguments[0], module.dependencyMapName);
      if (dependencyIndex !== null) bindings.push({ name: declaration.id.name, dependencyIndex });
    }
  }
  return bindings;
}

function isModuleExports(node) {
  return member(node, "module", "exports");
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
  const aliases = new Set(["exports"]);
  const candidates = astNodes(module.factory.body, (node) => node.type === "VariableDeclarator" && node.id.type === "Identifier");
  const aliasDeclarations = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of candidates) {
      if (aliases.has(declaration.id.name)) continue;
      const value = unwrapExpression(declaration.init);
      if (!isModuleExports(value) && !(value?.type === "Identifier" && aliases.has(value.name))) continue;
      aliases.add(declaration.id.name);
      aliasDeclarations.push(declaration);
      changed = true;
    }
  }
  assert.equal(aliasDeclarations.length, 0, `${label} export object must not escape through an alias`);

  const exportReference = (node) => {
    const value = unwrapExpression(node);
    return isModuleExports(value) || (value?.type === "Identifier" && aliases.has(value.name));
  };
  const definitions = new Map();
  walkAst(module.factory.body, (node) => {
    if (node.type === "AssignmentExpression") {
      assert(!isModuleExports(node.left), `${label} must not replace module.exports`);
      const target = unwrapExpression(node.left);
      if (target?.type !== "MemberExpression" || !exportReference(target.object)) return;
      const name = propertyName(target);
      assert(node.operator === "=" && name && allowed.has(name), `${label} contains an unrecognized export assignment`);
      definitions.set(name, (definitions.get(name) ?? 0) + 1);
      return;
    }
    if (node.type === "UpdateExpression" || node.type === "UnaryExpression" && node.operator === "delete") {
      const target = unwrapExpression(node.argument);
      assert(!(target?.type === "MemberExpression" && exportReference(target.object)), `${label} contains an unrecognized export mutation`);
      return;
    }
    if (node.type !== "CallExpression") return;
    const call = unwrapExpression(node);
    const defineProperty = member(call.callee, "Object", "defineProperty") && exportReference(call.arguments[0]);
    if (defineProperty) {
      const name = call.arguments[1]?.value;
      assert(typeof name === "string" && allowed.has(name), `${label} defines an unrecognized export`);
      definitions.set(name, (definitions.get(name) ?? 0) + 1);
      return;
    }
    const receiver = unwrapExpression(call.callee)?.type === "MemberExpression" ? unwrapExpression(call.callee).object : null;
    const exposesExports = exportReference(receiver) || call.arguments.some(exportReference);
    assert(!exposesExports, `${label} contains an unrecognized export mutation path`);
  });
  for (const [name, count] of definitions) assert.equal(count, 1, `${label} export ${name} must have one final definition`);
}

function functionDeclaration(module, name) {
  const declarations = module.factory.body.body.filter((statement) => statement.type === "FunctionDeclaration" && statement.id?.name === name);
  if (declarations.length !== 1) return null;
  const writes = astNodes(module.factory.body, (node) => (
    (node.type === "AssignmentExpression" && identifier(node.left, name))
    || (node.type === "UpdateExpression" && identifier(node.argument, name))
    || (node.type === "VariableDeclarator" && identifier(node.id, name) && node.init !== null)
  ));
  return writes.length === 0 ? declarations[0] : null;
}

function exportedFunction(module, name) {
  const exported = finalNamedExport(module, name);
  return exported?.type === "Identifier" ? functionDeclaration(module, exported.name) : null;
}

function variableDeclaration(block, name) {
  const declarations = astNodes(block, (node) => node.type === "VariableDeclarator" && identifier(node.id, name));
  return declarations.length === 1 ? declarations[0] : null;
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

function functionInvokes(fn, name) {
  if (fn.body.body.length !== 1 || fn.body.body[0].type !== "ReturnStatement") return false;
  const call = unwrapExpression(fn.body.body[0].argument);
  if (call?.type !== "CallExpression") return false;
  const callee = unwrapExpression(call.callee);
  return identifier(callee, name) || identifier(call.arguments[0], name);
}

function appEvidence(module, graph, label) {
  const appComposition = exportedFunction(module, "AppComposition");
  if (!appComposition) return null;
  assertClosedExports(module, ["AppComposition", "default"], `${label} App`);
  const defaultApp = exportedFunction(module, "default");
  if (!defaultApp || !functionInvokes(defaultApp, "AppComposition")) return null;
  const parameter = appComposition.params[0];
  if (parameter?.type !== "ObjectPattern") return null;
  const installProperty = parameter.properties.find((property) => property.type === "Property" && propertyName({
    type: "MemberExpression",
    computed: property.computed,
    property: property.key,
  }) === "installFaults");
  const defaultValue = installProperty?.value?.type === "AssignmentPattern" ? unwrapExpression(installProperty.value.right) : null;
  if (defaultValue?.type !== "MemberExpression" || propertyName(defaultValue) !== "installFaultController" || defaultValue.object.type !== "Identifier") return null;
  const binding = dependencyBindings(module).find((candidate) => candidate.name === defaultValue.object.name);
  if (!binding) return null;
  const host = functionDeclaration(module, "FaultControllerHost");
  if (!host || astNodes(host.body, (node) => node.type === "CallExpression" && identifier(unwrapExpression(node.callee), "installFaults")).length !== 1) return null;
  const installedProperties = astNodes(appComposition.body, (node) => (
    node.type === "Property" && !node.computed && identifier(node.key, "installFaults") && identifier(node.value, "installFaults")
  ));
  if (installedProperties.length < 1) return null;
  return { module, controller: resolveDependency(graph, module, binding.dependencyIndex, `${label} App controller`) };
}

function rootRegistersApp(graph, app, label) {
  const registrations = [];
  for (const rootId of graph.roots) {
    const root = graph.byId.get(rootId);
    const bindings = dependencyBindings(root);
    for (const statement of root.factory.body.body) {
      if (statement.type === "ReturnStatement" || statement.type === "ThrowStatement") break;
      const call = statement.type === "ExpressionStatement" ? unwrapExpression(statement.expression) : null;
      if (call?.type !== "CallExpression" || propertyName(unwrapExpression(call.callee)) !== "registerRootComponent") continue;
      const runtimeName = unwrapExpression(call.callee).object?.name;
      const runtimeBinding = bindings.find(({ name }) => name === runtimeName);
      const argument = unwrapExpression(call.arguments[0]);
      if (!runtimeBinding || argument?.type !== "MemberExpression" || propertyName(argument) !== "default" || argument.object.type !== "Identifier") continue;
      const interop = variableDeclaration(root.factory.body, argument.object.name)?.init;
      const importedName = interop?.type === "CallExpression" && interop.arguments.length === 1 && interop.arguments[0]?.type === "Identifier"
        ? interop.arguments[0].name
        : null;
      const appBinding = bindings.find(({ name }) => name === importedName);
      if (!appBinding) continue;
      const importedApp = resolveDependency(graph, root, appBinding.dependencyIndex, `${label} root App`);
      resolveDependency(graph, root, runtimeBinding.dependencyIndex, `${label} root runtime`);
      if (importedApp.moduleId === app.moduleId) registrations.push({ root, call });
    }
  }
  assert.equal(registrations.length, 1, `${label} one top-level Metro root must import and register the default App`);
}

function parserDelivery(module, handler, urlName, onFaultName) {
  const bindings = dependencyBindings(module);
  const matches = [];
  walkAst(handler.body, (node, parent) => {
    if (node.type !== "CallExpression") return;
    const call = node;
    const callee = unwrapExpression(call.callee);
    if (callee?.type !== "MemberExpression" || propertyName(callee) !== "parseFaultUrl") return;
    const binding = bindings.find((candidate) => identifier(callee.object, candidate.name));
    if (binding && call.arguments.length === 1 && identifier(call.arguments[0], urlName)
      && parent?.type === "VariableDeclarator" && parent.id.type === "Identifier" && parent.init === call) {
      matches.push({ binding, call, declaration: parent });
    }
  });
  if (matches.length !== 1) return null;
  const match = matches[0];
  const requestName = match.declaration.id.name;
  const declarations = astNodes(handler.body, (node) => node.type === "VariableDeclarator" && identifier(node.id, requestName));
  const writes = astNodes(handler.body, (node) => (
    node.type === "AssignmentExpression" && identifier(node.left, requestName)
    || node.type === "UpdateExpression" && identifier(node.argument, requestName)
  ));
  if (declarations.length !== 1 || writes.length !== 0) return null;
  const parseIndex = handler.body.body.findIndex((statement) => statement.type === "VariableDeclaration" && statement.declarations.includes(match.declaration));
  const deliveryIndex = handler.body.body.findIndex((statement) => statement.type === "IfStatement" && identifier(statement.test, requestName)
    && astNodes(statement.consequent, (node) => node.type === "CallExpression" && identifier(unwrapExpression(node.callee), onFaultName)
      && node.arguments.length === 1 && identifier(node.arguments[0], requestName)).length === 1);
  const allDeliveries = astNodes(handler.body, (node) => node.type === "CallExpression" && identifier(unwrapExpression(node.callee), onFaultName));
  if (parseIndex < 0 || deliveryIndex <= parseIndex || allDeliveries.length !== 1) return null;
  return match.binding;
}

function listenerEvidence(module, graph, label) {
  assertClosedExports(module, ["E2E_FAULT_CONTROLLER_BUNDLE_SENTINEL", "installFaultController"], `${label} listener`);
  const install = exportedFunction(module, "installFaultController");
  assert(install && install.params.length >= 2 && install.params.every((parameter) => parameter.type === "Identifier"),
    `${label} listener final installFaultController export is invalid`);
  const [onFaultName, signalName] = install.params.map((parameter) => parameter.name);
  const handlerCandidates = [];
  for (const statement of install.body.body) {
    if (statement.type !== "VariableDeclaration") continue;
    for (const declaration of statement.declarations) {
      const handler = declaration.init;
      const parameter = handler?.params?.[0];
      if (!identifier(declaration.id, declaration.id?.name) || !["ArrowFunctionExpression", "FunctionExpression"].includes(handler?.type) || parameter?.type !== "ObjectPattern") continue;
      const urlProperty = parameter.properties.find((property) => property.type === "Property" && identifier(property.key, "url") && identifier(property.value, "url"));
      if (!urlProperty || handler.body.type !== "BlockStatement") continue;
      const parserBinding = parserDelivery(module, handler, "url", onFaultName);
      if (parserBinding) handlerCandidates.push({ name: declaration.id.name, handler, parserBinding, declaration });
    }
  }
  assert.equal(handlerCandidates.length, 1, `${label} listener must parse URL and invoke onFault(request)`);
  const handler = handlerCandidates[0];
  const calls = astNodes(install.body, (node) => node.type === "CallExpression");
  const registration = install.body.body.flatMap((statement) => statement.type === "VariableDeclaration" ? statement.declarations : [])
    .find((declaration) => declaration.init?.type === "CallExpression" && memberCall(declaration.init, "addEventListener")
      && literal(declaration.init.arguments[0], "url") && identifier(declaration.init.arguments[1], handler.name));
  assert(registration && registration.id.type === "Identifier", `${label} listener URL registration is invalid`);
  const handlerIndex = install.body.body.findIndex((statement) => statement.type === "VariableDeclaration" && statement.declarations.includes(handler.declaration));
  const registrationIndex = install.body.body.findIndex((statement) => statement.type === "VariableDeclaration" && statement.declarations.includes(registration));
  assert(handlerIndex >= 0 && registrationIndex > handlerIndex, `${label} listener installation statement order is invalid`);
  const preInstallation = install.body.body.slice(0, registrationIndex);
  assert(preInstallation.every((statement) => {
    if (statement.type === "VariableDeclaration") return true;
    if (statement.type !== "IfStatement" || statement.alternate) return false;
    const abortChecks = astNodes(statement.test, (node) => node.type === "MemberExpression"
      && identifier(node.object, signalName) && propertyName(node) === "aborted");
    const returns = astNodes(statement.consequent, (node) => node.type === "ReturnStatement");
    return abortChecks.length === 1 && returns.length === 1;
  }), `${label} listener has noncanonical control flow before installation`);
  const registrationCallee = unwrapExpression(registration.init.callee);
  const registrationLinking = registrationCallee?.type === "MemberExpression" ? unwrapExpression(registrationCallee.object) : null;
  const runtimeName = registrationLinking?.type === "MemberExpression" && propertyName(registrationLinking) === "Linking"
    && registrationLinking.object.type === "Identifier" ? registrationLinking.object.name : null;
  const runtimeBinding = dependencyBindings(module).find(({ name }) => name === runtimeName);
  assert(runtimeBinding, `${label} listener Linking registration is not bound to an imported runtime namespace`);
  resolveDependency(graph, module, runtimeBinding.dependencyIndex, `${label} listener runtime`);
  const initialUrl = variableDeclaration(install.body, "url");
  assert(initialUrl?.init?.type === "AwaitExpression" && memberCall(initialUrl.init.argument, "getInitialURL"),
    `${label} listener initial URL lookup is invalid`);
  const initialCallee = unwrapExpression(initialUrl.init.argument.callee);
  const initialLinking = initialCallee?.type === "MemberExpression" ? unwrapExpression(initialCallee.object) : null;
  assert(initialLinking?.type === "MemberExpression" && propertyName(initialLinking) === "Linking"
    && identifier(initialLinking.object, runtimeName), `${label} listener Linking calls must share one imported runtime namespace`);
  const initialStatementIndex = install.body.body.findIndex((statement) => astNodes(statement, (node) => node === initialUrl).length === 1);
  assert(initialStatementIndex > registrationIndex, `${label} listener initial URL lookup must follow listener installation`);
  const initialDispatch = astNodes(install.body, (node) => node.type === "IfStatement" && identifier(node.test, "url")
    && astNodes(node.consequent, (candidate) => candidate.type === "CallExpression" && identifier(unwrapExpression(candidate.callee), handler.name)
      && candidate.arguments[0]?.type === "ObjectExpression"
      && candidate.arguments[0].properties.some((property) => property.type === "Property" && identifier(property.key, "url") && identifier(property.value, "url"))).length === 1);
  assert.equal(initialDispatch.length, 1, `${label} listener initial URL dispatch is invalid`);
  const abortRegistration = calls.find((call) => memberCall(call, "addEventListener") && literal(call.arguments[0], "abort")
    && call.arguments[1]?.type === "Identifier" && call.arguments[2]?.type === "ObjectExpression"
    && call.arguments[2].properties.some((property) => property.type === "Property" && identifier(property.key, "once") && literal(property.value, true)));
  const disposeName = abortRegistration?.arguments[1]?.name;
  const dispose = disposeName ? variableDeclaration(install.body, disposeName)?.init : null;
  assert(dispose && dispose.body?.type === "BlockStatement", `${label} listener abort registration is invalid`);
  const disposeCalls = astNodes(dispose.body, (node) => node.type === "CallExpression");
  assert(disposeCalls.some((call) => memberCall(call, "removeEventListener") && literal(call.arguments[0], "abort") && identifier(call.arguments[1], disposeName)),
    `${label} listener abort removal is invalid`);
  assert(disposeCalls.some((call) => memberCall(call, "remove") && identifier(unwrapExpression(call.callee).object, registration.id.name)),
    `${label} listener subscription disposal is invalid`);
  const abortChecks = astNodes(install.body, (node) => {
    return node.type === "MemberExpression" && identifier(node.object, signalName) && propertyName(node) === "aborted";
  });
  assert(abortChecks.length >= 2, `${label} listener abort guards are invalid`);
  assert(astNodes(install.body, (node) => node.type === "ReturnStatement" && identifier(node.argument, disposeName)).length,
    `${label} listener must return its disposer`);
  assert(calls.filter((call) => identifier(unwrapExpression(call.callee), disposeName)).length >= 1,
    `${label} listener error path must dispose`);
  const sentinelLiterals = astNodes(module.factory.body, (node) => literal(node, FAULT_CONTROLLER_SENTINEL));
  assert.equal(sentinelLiterals.length, 1, `${label} listener sentinel must be one live literal`);
  return {
    module,
    parser: resolveDependency(graph, module, handler.parserBinding.dependencyIndex, `${label} listener parser`),
  };
}

function allowedHas(node, argumentCheck) {
  const call = unwrapExpression(node);
  return call?.type === "CallExpression" && member(call.callee, "allowed", "has") && call.arguments.length === 1 && argumentCheck(call.arguments[0]);
}

function matchIndexOne(node) {
  const value = unwrapExpression(node);
  return value?.type === "MemberExpression" && value.computed && identifier(value.object, "match") && literal(value.property, 1);
}

function parserEvidence(module, graph, label) {
  assertClosedExports(module, ["FAULT_POINTS", "canonicalFaultUrl", "parseFaultUrl"], `${label} parser`);
  const canonical = exportedFunction(module, "canonicalFaultUrl");
  const parser = exportedFunction(module, "parseFaultUrl");
  if (!canonical || !parser || !identifier(canonical.params[0], "point") || !identifier(parser.params[0], "value")) return null;
  if (canonical.body.body.length !== 2 || parser.body.body.length !== 4) return null;
  const [canonicalGuard, canonicalReturn] = canonical.body.body;
  if (canonicalGuard.type !== "IfStatement" || canonicalGuard.test.type !== "UnaryExpression" || canonicalGuard.test.operator !== "!"
    || !allowedHas(canonicalGuard.test.argument, (argument) => identifier(argument, "point")) || canonicalGuard.consequent.type !== "ThrowStatement") return null;
  const template = canonicalReturn.type === "ReturnStatement" ? canonicalReturn.argument : null;
  if (template?.type !== "TemplateLiteral" || template.expressions.length !== 1 || !identifier(template.expressions[0], "point")
    || template.quasis[0].value.raw !== "formobile-test://fault?point=" || template.quasis[1].value.raw !== "&mode=crash_once") return null;
  const [matchStatement, parseGuard, requestStatement, parseReturn] = parser.body.body;
  const matchDeclaration = matchStatement.type === "VariableDeclaration" ? matchStatement.declarations[0] : null;
  const matchCall = matchDeclaration?.init;
  const regex = matchCall?.callee?.type === "MemberExpression" ? matchCall.callee.object : null;
  if (!identifier(matchDeclaration?.id, "match") || matchStatement.declarations.length !== 1 || matchCall?.type !== "CallExpression"
    || propertyName(matchCall.callee) !== "exec" || regex?.type !== "Literal"
    || regex.regex?.pattern !== String.raw`^formobile-test:\/\/fault\?point=([a-z][a-z0-9_.]*)&mode=crash_once$`
    || regex.regex.flags !== "" || !identifier(matchCall.arguments[0], "value")) return null;
  const guardTest = parseGuard.type === "IfStatement" ? parseGuard.test : null;
  const guardReturn = parseGuard.type === "IfStatement" ? parseGuard.consequent : null;
  if (guardTest?.type !== "LogicalExpression" || guardTest.operator !== "||" || guardTest.left.type !== "UnaryExpression"
    || guardTest.left.operator !== "!" || !identifier(guardTest.left.argument, "match") || guardTest.right.type !== "UnaryExpression"
    || guardTest.right.operator !== "!" || !allowedHas(guardTest.right.argument, matchIndexOne)
    || guardReturn.type !== "ReturnStatement" || !literal(guardReturn.argument, null)) return null;
  const requestDeclaration = requestStatement.type === "VariableDeclaration" ? requestStatement.declarations[0] : null;
  const requestProperties = requestDeclaration?.init?.type === "ObjectExpression" ? requestDeclaration.init.properties : [];
  if (!identifier(requestDeclaration?.id, "request") || requestStatement.declarations.length !== 1 || requestProperties.length !== 2
    || !requestProperties.some((property) => property.type === "Property" && identifier(property.key, "point") && matchIndexOne(property.value))
    || !requestProperties.some((property) => property.type === "Property" && identifier(property.key, "mode") && literal(property.value, "crash_once"))) return null;
  const conditional = parseReturn.type === "ReturnStatement" ? parseReturn.argument : null;
  const equality = conditional?.type === "ConditionalExpression" ? conditional.test : null;
  const canonicalCall = equality?.type === "BinaryExpression" ? equality.left : null;
  if (equality?.operator !== "===" || canonicalCall?.type !== "CallExpression" || !identifier(unwrapExpression(canonicalCall.callee), "canonicalFaultUrl")
    || canonicalCall.arguments[0]?.type !== "MemberExpression" || !identifier(canonicalCall.arguments[0].object, "request")
    || propertyName(canonicalCall.arguments[0]) !== "point" || !identifier(equality.right, "value")
    || !identifier(conditional.consequent, "request") || !literal(conditional.alternate, null)) return null;
  const registryBinding = dependencyBindings(module).find(({ name }) => name === "_faultPointsJson");
  const faultPointsImport = variableDeclaration(module.factory.body, "faultPoints")?.init;
  const frozenPoints = variableDeclaration(module.factory.body, "FAULT_POINTS")?.init;
  const allowed = variableDeclaration(module.factory.body, "allowed")?.init;
  if (!registryBinding || faultPointsImport?.type !== "CallExpression" || !identifier(unwrapExpression(faultPointsImport.callee), "_interopDefault")
    || !identifier(faultPointsImport.arguments[0], "_faultPointsJson") || frozenPoints?.type !== "CallExpression"
    || !member(frozenPoints.callee, "Object", "freeze") || frozenPoints.arguments[0]?.type !== "ArrayExpression"
    || frozenPoints.arguments[0].elements[0]?.type !== "SpreadElement" || !member(frozenPoints.arguments[0].elements[0].argument, "faultPoints", "default")
    || allowed?.type !== "NewExpression" || !identifier(allowed.callee, "Set") || !identifier(allowed.arguments[0], "FAULT_POINTS")) return null;
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
  const declaration = variableDeclaration(module.factory.body, noOpName);
  const initializer = declaration?.init;
  if (!["ArrowFunctionExpression", "FunctionExpression"].includes(initializer?.type) || initializer.body.type !== "BlockStatement" || initializer.body.body.length !== 0) return false;
  return astNodes(module.factory.body, (node) => node.type === "AssignmentExpression" && identifier(node.left, noOpName)).length === 0;
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
