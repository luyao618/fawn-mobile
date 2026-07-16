export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | Readonly<{ [key: string]: JsonValue }>;

export class InvalidJsonValueError extends TypeError {
  constructor() {
    super("Value is not valid JSON");
    this.name = "InvalidJsonValueError";
  }
}

export const JSON_LIMITS = Object.freeze({
  maxDepth: 64,
  maxNodes: 10_000,
  maxContainerItems: 1_000,
  maxKeyLength: 1_024,
  maxStringLength: 65_536,
  maxSerializedBytes: 262_144,
});

export function validateJsonValue(value: unknown): JsonValue {
  type Assignment = Readonly<{ candidate: unknown; depth: number; assign: (validated: JsonValue) => void }>;
  let validatedRoot: JsonValue | undefined;
  let nodeCount = 0;
  let serializedByteCount = 0;
  const seen = new WeakSet<object>();
  const stack: Assignment[] = [{ candidate: value, depth: 0, assign: (validated) => { validatedRoot = validated; } }];
  const addSerializedBytes = (count: number): void => {
    serializedByteCount += count;
    if (serializedByteCount > JSON_LIMITS.maxSerializedBytes) throw new InvalidJsonValueError();
  };
  const encodedLength = (text: string): number => new TextEncoder().encode(text).byteLength;

  while (stack.length > 0) {
    const { candidate, depth, assign } = stack.pop()!;
    nodeCount += 1;
    if (nodeCount > JSON_LIMITS.maxNodes || depth > JSON_LIMITS.maxDepth) throw new InvalidJsonValueError();
    if (candidate === null || typeof candidate === "boolean") {
      addSerializedBytes(encodedLength(JSON.stringify(candidate)));
      assign(candidate);
      continue;
    }
    if (typeof candidate === "string") {
      if (candidate.length > JSON_LIMITS.maxStringLength) throw new InvalidJsonValueError();
      addSerializedBytes(encodedLength(JSON.stringify(candidate)));
      assign(candidate);
      continue;
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) throw new InvalidJsonValueError();
      addSerializedBytes(encodedLength(JSON.stringify(candidate)));
      assign(candidate);
      continue;
    }
    if (typeof candidate !== "object" || seen.has(candidate)) throw new InvalidJsonValueError();
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      if (candidate.length > JSON_LIMITS.maxContainerItems) throw new InvalidJsonValueError();
      addSerializedBytes(2 + Math.max(0, candidate.length - 1));
      const keys = Reflect.ownKeys(candidate);
      if (keys.some((key) => key !== "length" && (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key)))) {
        throw new InvalidJsonValueError();
      }
      const result: JsonValue[] = new Array(candidate.length);
      assign(result);
      for (let index = candidate.length - 1; index >= 0; index -= 1) {
        if (!Object.hasOwn(candidate, index)) throw new InvalidJsonValueError();
        const descriptor = Object.getOwnPropertyDescriptor(candidate, String(index));
        if (!descriptor?.enumerable || !("value" in descriptor)) throw new InvalidJsonValueError();
        stack.push({ candidate: descriptor.value, depth: depth + 1, assign: (validated) => { result[index] = validated; } });
      }
      continue;
    }
    if (Object.getPrototypeOf(candidate) !== Object.prototype) throw new InvalidJsonValueError();
    const keys = Reflect.ownKeys(candidate);
    if (keys.length > JSON_LIMITS.maxContainerItems || keys.some((key) => typeof key !== "string" || key.length > JSON_LIMITS.maxKeyLength)) {
      throw new InvalidJsonValueError();
    }
    addSerializedBytes(2 + Math.max(0, keys.length - 1));
    const result = Object.create(null) as Record<string, JsonValue>;
    assign(result);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index]! as string;
      addSerializedBytes(encodedLength(JSON.stringify(key)) + 1);
      const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) throw new InvalidJsonValueError();
      stack.push({ candidate: descriptor.value, depth: depth + 1, assign: (validated) => { result[key] = validated; } });
    }
  }

  return validatedRoot!;
}

export function canonicalJson(value: JsonValue): string {
  const validated = validateJsonValue(value);

  function serialize(candidate: JsonValue): string {
    if (candidate === null || typeof candidate !== "object") return JSON.stringify(candidate);
    if (Array.isArray(candidate)) return `[${candidate.map((item) => serialize(item)).join(",")}]`;
    const object = candidate as Readonly<Record<string, JsonValue>>;
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${serialize(object[key]!)}`).join(",")}}`;
  }

  const serialized = serialize(validated);
  if (new TextEncoder().encode(serialized).byteLength > JSON_LIMITS.maxSerializedBytes) throw new InvalidJsonValueError();
  return serialized;
}
