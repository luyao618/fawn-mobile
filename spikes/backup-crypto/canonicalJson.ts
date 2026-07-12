export function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        throw new Error("Canonical JSON rejects unpaired UTF-16 surrogates");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new Error("Canonical JSON rejects unpaired UTF-16 surrogates");
    }
  }
}

function serialize(value: unknown): string {
  if (typeof value === "string") {
    assertValidUnicode(value);
    return JSON.stringify(value);
  }
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serialize).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
      .sort()
      .map((key) => {
        assertValidUnicode(key);
        return `${JSON.stringify(key)}:${serialize(record[key])}`;
      });
    return `{${fields.join(",")}}`;
  }
  throw new Error(`Canonical JSON cannot serialize ${typeof value}`);
}

export const canonicalJson = (value: unknown): string => serialize(value);
