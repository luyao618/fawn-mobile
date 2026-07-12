export const G016_CRYPTO_PROOF_PREFIX = "G016_CRYPTO_PROOF ";
export const G016_CRYPTO_PROOF_MAX_BYTES = 900;

export const G016_VECTOR_IDS = {
  rfcScrypt: "RFC7914-1",
  nodeScrypt: "G016-SCRYPT-N32768-r8-p1-dk32",
  aesGcm: "NIST-AES256-GCM-EMPTY+SLICED",
  fmbk: "FMBK-v1",
} as const;

export const G016_FAILURE = {
  platform: 1,
  release: 2,
  hermes: 3,
  adapter: 4,
  backend: 5,
  cryptoGlobal: 6,
  bufferGlobal: 7,
  processNextTick: 8,
  capabilities: 9,
  rfcScrypt: 10,
  nodeScrypt: 11,
  aesKnownAnswer: 12,
  aesSlicedViews: 13,
  aesRejections: 14,
  productionTamper: 15,
  queueOwnership: 16,
  vector: 17,
  wrongPassphrase: 18,
  productionHeaders: 19,
  aesFraming: 20,
  scryptP95: 21,
  scryptMax: 22,
  aesEncryptP95: 23,
  aesDecryptP95: 24,
  heartbeat: 25,
  uncaught: 26,
  provenance: 27,
} as const;

export type G016FailureCode = typeof G016_FAILURE[keyof typeof G016_FAILURE];
export const G016_ALL_FAILURE_CODES = Object.freeze(Object.values(G016_FAILURE));

export type CompactProofInput = Readonly<{
  failures: readonly G016FailureCode[];
  platform: "android" | "ios" | "unsupported";
  release: boolean;
  hermes: boolean;
  newArchitecture: boolean;
  integrity: Readonly<{ sourceSha256: string; resolutionSha256: string }>;
  backend: Readonly<{
    adapter: string;
    native: string;
    rootImports: boolean;
    installCalled: boolean;
    rng: string;
    cryptoGlobal: boolean;
    bufferGlobal: boolean;
    nextTick: boolean;
    transition: "I" | "P" | "X";
  }>;
  vector: Readonly<{ bytes: number; sha256: string }>;
  selfTest: Readonly<{
    ok: boolean;
    count: number;
    rfc: boolean;
    node: boolean;
    aes: boolean;
    sliced: boolean;
    rejections: boolean;
    tamper: boolean;
    queue: boolean;
    framing: boolean;
  }>;
  runs: Readonly<{ warmup: number; scrypt: number; aes: number }>;
  scrypt: Readonly<{ p95: number | null; max: number | null }>;
  aes: Readonly<{
    encP95: number | null;
    decP95: number | null;
    plaintextBytes: number;
    framedBytes: number | null;
    tagBytes: number;
  }>;
  heartbeat: Readonly<{ max: number | null; limit: number }>;
}>;

function finiteOrNull(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizedFailures(values: readonly G016FailureCode[]): G016FailureCode[] {
  const known = new Set<number>(G016_ALL_FAILURE_CODES);
  const unique = [...new Set(values)];
  if (unique.some((value) => !Number.isInteger(value) || !known.has(value))) {
    throw new Error("G016 compact proof contains an unknown failure code");
  }
  return unique.sort((left, right) => left - right);
}

export function compactProofRecord(input: CompactProofInput) {
  const failures = normalizedFailures(input.failures);
  return {
    v: 2,
    st: failures.length === 0 ? "IN_PROCESS_PASS" : "IN_PROCESS_FAIL",
    f: failures,
    p: input.platform,
    rel: input.release,
    h: input.hermes,
    na: input.newArchitecture,
    i: { s: input.integrity.sourceSha256, r: input.integrity.resolutionSha256 },
    be: {
      a: input.backend.adapter === "BackupCryptoPort/nativeCryptoPort@1" ? "B1" : "X",
      n: input.backend.native === "react-native-quick-crypto@1.1.6/OpenSSL" ? "Q1" : "X",
      ri: input.backend.rootImports,
      i: input.backend.installCalled,
      r: input.backend.rng === "expo-crypto@57.0.0" ? "E57" : "X",
      cg: input.backend.cryptoGlobal,
      bg: input.backend.bufferGlobal,
      nt: input.backend.nextTick,
      tr: input.backend.transition,
    },
    vec: {
      r: "R1",
      n: "S1",
      a: "A1",
      f: "F1",
      b: input.vector.bytes,
      h: input.vector.sha256,
    },
    self: {
      ok: input.selfTest.ok,
      n: input.selfTest.count,
      r: input.selfTest.rfc,
      d: input.selfTest.node,
      a: input.selfTest.aes,
      s: input.selfTest.sliced,
      x: input.selfTest.rejections,
      t: input.selfTest.tamper,
      q: input.selfTest.queue,
      f: input.selfTest.framing,
    },
    runs: { w: input.runs.warmup, s: input.runs.scrypt, a: input.runs.aes },
    sc: { p95: finiteOrNull(input.scrypt.p95), max: finiteOrNull(input.scrypt.max) },
    ag: {
      ep95: finiteOrNull(input.aes.encP95),
      dp95: finiteOrNull(input.aes.decP95),
      p: input.aes.plaintextBytes,
      c: finiteOrNull(input.aes.framedBytes),
      t: input.aes.tagBytes,
    },
    hb: { max: finiteOrNull(input.heartbeat.max), lim: input.heartbeat.limit },
  } as const;
}

export function compactProofByteLength(serialized: string): number {
  let bytes = 0;
  for (let index = 0; index < serialized.length; index += 1) {
    const code = serialized.charCodeAt(index);
    if (code <= 0x7f) bytes += 1;
    else if (code <= 0x7ff) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = serialized.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

export function serializeCompactProof(input: CompactProofInput): string {
  const serialized = G016_CRYPTO_PROOF_PREFIX + JSON.stringify(compactProofRecord(input));
  const byteLength = compactProofByteLength(serialized);
  if (byteLength >= G016_CRYPTO_PROOF_MAX_BYTES) {
    throw new Error(`G016 compact proof is ${byteLength} bytes; expected fewer than ${G016_CRYPTO_PROOF_MAX_BYTES}`);
  }
  return serialized;
}
