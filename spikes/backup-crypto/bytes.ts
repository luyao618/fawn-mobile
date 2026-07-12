export const utf8 = (value: string): Uint8Array => new TextEncoder().encode(value);

export const decodeUtf8 = (value: Uint8Array): string =>
  new TextDecoder("utf-8", { fatal: true }).decode(value);

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function u16(value: number): Uint8Array {
  const output = new Uint8Array(2);
  new DataView(output.buffer).setUint16(0, value, false);
  return output;
}

export function u32(value: number): Uint8Array {
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, value, false);
  return output;
}

export function u64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("FMBK integer exceeds the safe unsigned range");
  }
  const output = new Uint8Array(8);
  new DataView(output.buffer).setBigUint64(0, BigInt(value), false);
  return output;
}

export function fromHex(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(hex)) {
    throw new Error("Invalid hex");
  }
  return Uint8Array.from(hex.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16));
}

export function toHex(value: Uint8Array): string {
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function toBase64(value: Uint8Array): string {
  let output = "";
  for (let index = 0; index < value.length; index += 3) {
    const a = value[index] ?? 0;
    const b = value[index + 1] ?? 0;
    const c = value[index + 2] ?? 0;
    const bits = (a << 16) | (b << 8) | c;
    output += BASE64[(bits >>> 18) & 63];
    output += BASE64[(bits >>> 12) & 63];
    output += index + 1 < value.length ? BASE64[(bits >>> 6) & 63] : "=";
    output += index + 2 < value.length ? BASE64[bits & 63] : "=";
  }
  return output;
}

export function fromBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Invalid base64");
  }
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 4) {
    const a = BASE64.indexOf(value[index]);
    const b = BASE64.indexOf(value[index + 1]);
    const c = value[index + 2] === "=" ? 0 : BASE64.indexOf(value[index + 2]);
    const d = value[index + 3] === "=" ? 0 : BASE64.indexOf(value[index + 3]);
    const bits = (a << 18) | (b << 12) | (c << 6) | d;
    bytes.push((bits >>> 16) & 255);
    if (value[index + 2] !== "=") bytes.push((bits >>> 8) & 255);
    if (value[index + 3] !== "=") bytes.push(bits & 255);
  }
  return Uint8Array.from(bytes);
}

