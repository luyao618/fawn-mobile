import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson, InvalidJsonValueError, JSON_LIMITS } from "../../../src/infrastructure/db/repositories/json.ts";

test("canonical JSON recursively sorts valid snapshots", () => {
  assert.equal(canonicalJson({ z: [3, { b: true, a: null }], a: "value" }), '{"a":"value","z":[3,{"a":null,"b":true}]}');
});

test("canonical JSON preserves prototype-named own properties", () => {
  const value = JSON.parse('{"prototype":{"z":3},"constructor":{"y":2},"__proto__":{"x":1}}');
  const serialized = canonicalJson(value);
  const roundTripped = JSON.parse(serialized);
  assert.equal(Object.hasOwn(roundTripped, "__proto__"), true);
  assert.deepEqual(roundTripped.__proto__, { x: 1 });
  assert.deepEqual(roundTripped.constructor, { y: 2 });
  assert.deepEqual(roundTripped.prototype, { z: 3 });
  assert.notDeepEqual(roundTripped, {});
});

test("canonical JSON rejects every non-JSON shape", () => {
  const hole = [1, 2];
  delete hole[0];
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  class Custom { value = 1; }
  const symbolKey = { safe: true, [Symbol("hidden")]: true };
  const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => 1 });
  const invalid: unknown[] = [
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    BigInt(1),
    Symbol("x"),
    () => undefined,
    new Date(),
    new Custom(),
    Object.assign(Object.create(null) as Record<string, number>, { value: 1 }),
    symbolKey,
    accessor,
    hole,
    cycle,
    { nested: undefined },
  ];
  for (const value of invalid) {
    assert.throws(() => canonicalJson(value as never), InvalidJsonValueError);
  }
});

test("canonical JSON enforces depth, node, container, key, string, and byte boundaries", () => {
  const nested = (depth: number): unknown => {
    let value: unknown = null;
    for (let index = 0; index < depth; index += 1) value = [value];
    return value;
  };
  assert.doesNotThrow(() => canonicalJson(nested(JSON_LIMITS.maxDepth) as never));
  assert.throws(() => canonicalJson(nested(JSON_LIMITS.maxDepth + 1) as never), InvalidJsonValueError);
  assert.throws(() => canonicalJson(nested(20_000) as never), InvalidJsonValueError);

  const exactNodes = Array.from({ length: 999 }, (_, index) => Array(index < 9 ? 10 : 9).fill(null));
  assert.equal(1 + exactNodes.length + exactNodes.reduce((total, values) => total + values.length, 0), JSON_LIMITS.maxNodes);
  assert.doesNotThrow(() => canonicalJson(exactNodes));
  exactNodes[9]!.push(null);
  assert.throws(() => canonicalJson(exactNodes), InvalidJsonValueError);

  assert.doesNotThrow(() => canonicalJson(Array(JSON_LIMITS.maxContainerItems).fill(null)));
  assert.throws(() => canonicalJson(Array(JSON_LIMITS.maxContainerItems + 1).fill(null)), InvalidJsonValueError);
  const exactObject = Object.fromEntries(Array.from({ length: JSON_LIMITS.maxContainerItems }, (_, index) => [`k${index}`, null]));
  assert.doesNotThrow(() => canonicalJson(exactObject));
  assert.throws(() => canonicalJson({ ...exactObject, overflow: null }), InvalidJsonValueError);

  assert.doesNotThrow(() => canonicalJson({ ["k".repeat(JSON_LIMITS.maxKeyLength)]: "x".repeat(JSON_LIMITS.maxStringLength) }));
  assert.throws(() => canonicalJson({ ["k".repeat(JSON_LIMITS.maxKeyLength + 1)]: "x" }), InvalidJsonValueError);
  assert.throws(() => canonicalJson("x".repeat(JSON_LIMITS.maxStringLength + 1)), InvalidJsonValueError);

  const byteBoundary = [
    "x".repeat(JSON_LIMITS.maxStringLength),
    "x".repeat(JSON_LIMITS.maxStringLength),
    "x".repeat(JSON_LIMITS.maxStringLength),
    "x".repeat(JSON_LIMITS.maxSerializedBytes - (JSON_LIMITS.maxStringLength * 3) - 13),
  ];
  assert.equal(new TextEncoder().encode(JSON.stringify(byteBoundary)).byteLength, JSON_LIMITS.maxSerializedBytes);
  assert.doesNotThrow(() => canonicalJson(byteBoundary));
  byteBoundary[3] += "x";
  assert.throws(() => canonicalJson(byteBoundary), InvalidJsonValueError);
});

test("canonical JSON rejects shared references without expanding them", () => {
  const shared = { value: "x" };
  assert.throws(() => canonicalJson({ left: shared, right: shared }), InvalidJsonValueError);
});
