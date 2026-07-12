import { getRandomBytes } from "expo-crypto";
import { Platform } from "react-native";

import appConfiguration from "./app.json";
import { runAesGcmBenchmark } from "./aesBenchmark.ts";
import { fromHex, toHex, utf8 } from "./bytes.ts";
import {
  G016_FAILURE,
  type G016FailureCode,
  type CompactProofInput,
  serializeCompactProof,
} from "./compactProof.ts";
import type { BackupCryptoPort } from "./cryptoPort.ts";
import { isFmbkAuthenticationFailure, readFmbk, vectorHeader, writeFmbk } from "./fmbk.ts";
import { wipeBytes } from "./nativeCryptoPortValidation.ts";
import {
  VECTOR_ARCHIVE_LENGTH,
  VECTOR_ARCHIVE_SHA256,
  VECTOR_DERIVED_KEY_HEX,
  VECTOR_PASSPHRASE,
  vectorEntries,
} from "./vector.ts";

const EXPECTED_ADAPTER = "BackupCryptoPort/nativeCryptoPort@1";
const EXPECTED_BACKEND = "react-native-quick-crypto@1.1.6/OpenSSL";
const EXPECTED_RNG = "expo-crypto@57.0.0";
const SOURCE_FINGERPRINT_SHA256 = process.env.EXPO_PUBLIC_G016_SOURCE_SHA256 ?? "";
const RESOLUTION_SHA256 = process.env.EXPO_PUBLIC_G016_RESOLUTION_SHA256 ?? "";
const EXPO_BUILD_CONTRACT = appConfiguration.expo.extra.g016BuildContract;
const SCRYPT_PARAMETERS = { N: 32768, r: 8, p: 1 } as const;
const CONFIGURED_SCRYPT_MEMORY_BYTES = 64 * 1024 * 1024;
const ACCOUNTED_SCRYPT_MEMORY_BYTES = 33_556_480;
const AES_SAMPLE_BYTES = 4 * 1024 * 1024;
const AES_TAG_BYTES = 16;
const MEASURED_RUNS = 10;
const BUDGETS = {
  scryptP95Ms: 2_000,
  scryptMaxMs: 3_000,
  aesEncryptP95Ms: 200,
  aesDecryptP95Ms: 200,
  heartbeatMaxGapMs: 250,
} as const;

type TimingSummary = Readonly<{
  samplesMs: readonly number[];
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}>;

type ProcessSnapshot = Readonly<{
  value: unknown;
  nextTick: unknown;
  properties: ReadonlyMap<string, unknown>;
}>;

type ProcessShimProof = ReturnType<typeof processNextTickShimProof>;

type SelfTestState = {
  ok: boolean;
  count: 8;
  rfc: boolean;
  node: boolean;
  aes: boolean;
  sliced: boolean;
  rejections: boolean;
  tamper: boolean;
  queue: boolean;
  framing: boolean;
  failures: readonly string[];
};

type ProofState = {
  failures: string[];
  failureCodes: Set<G016FailureCode>;
  platform: "android" | "ios" | "unsupported";
  release: boolean;
  hermes: boolean;
  newArchitecture: boolean;
  backend: {
    adapter: string;
    native: string;
    rootImports: boolean;
    installCalled: boolean;
    rng: string;
    cryptoGlobal: boolean;
    bufferGlobal: boolean;
    nextTick: boolean;
    processShim: ProcessShimProof | null;
  };
  capabilities: Record<string, boolean>;
  vector: {
    archiveLength: number;
    archiveSha256: string;
    derivedKeyHex: string;
    wrongPassphraseRejected: boolean;
  };
  productionHeaders: {
    archivesDiffer: boolean;
    bothRoundTrip: boolean;
    noncePrefixBytes: 8;
    saltBytes: 16;
  };
  selfTest: SelfTestState;
  scrypt: {
    warmupMs: number | null;
    timing: TimingSummary | null;
  };
  aes: {
    ciphertextAndTagBytes: number | null;
    encrypt: TimingSummary | null;
    decrypt: TimingSummary | null;
  };
  heartbeatMaxGapMs: number | null;
};

const now = (): number => performance.now();
const round = (value: number): number => Math.round(value * 100) / 100;
const delay = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function timingSummary(samples: readonly number[]): TimingSummary {
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (fraction: number): number => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
  return {
    samplesMs: samples.map(round),
    p50Ms: round(percentile(0.5)),
    p95Ms: round(percentile(0.95)),
    maxMs: round(sorted.at(-1) ?? 0),
  };
}

function capabilityProbes(): Record<string, boolean> {
  const textDecoder = typeof TextDecoder === "function";
  let fatalUtf8 = false;
  if (textDecoder) {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.of(0xff));
    } catch {
      fatalUtf8 = true;
    }
  }
  const aligned = new Uint8Array(new ArrayBuffer(10), 1, 8);
  const view = new DataView(aligned.buffer, aligned.byteOffset, aligned.byteLength);
  view.setBigUint64(0, 0x0102_0304_0506_0708n, false);
  return {
    dataViewBigUint64: view.getBigUint64(0, false) === 0x0102_0304_0506_0708n,
    fatalUtf8,
    nfcNormalization: "e\u0301".normalize("NFC") === "é",
    textDecoder,
    textEncoder: typeof TextEncoder === "function",
    typedArrayByteOffset: aligned[0] === 1 && aligned[7] === 8,
  };
}

function startHeartbeat(): { stop: () => Promise<number> } {
  let last = now();
  let maximumGap = 0;
  let stopped = false;
  const timer = setInterval(() => {
    const current = now();
    maximumGap = Math.max(maximumGap, current - last);
    last = current;
  }, 16);
  return {
    async stop() {
      if (!stopped) {
        await delay();
        const current = now();
        maximumGap = Math.max(maximumGap, current - last);
        clearInterval(timer);
        stopped = true;
      }
      return round(maximumGap);
    },
  };
}

function captureProcessSnapshot(): ProcessSnapshot {
  const value = (globalThis as { process?: unknown }).process;
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return { value, nextTick: undefined, properties: new Map() };
  }
  const object = value as Record<string, unknown>;
  const properties = new Map<string, unknown>();
  for (const name of Object.getOwnPropertyNames(object)) properties.set(name, object[name]);
  return { value, nextTick: object.nextTick, properties };
}

function processNextTickShimProof(before: ProcessSnapshot, after: ProcessSnapshot) {
  const beforePresent = before.value !== null && before.value !== undefined;
  const afterPresent = after.value !== null && after.value !== undefined;
  const processIdentityAllowed = beforePresent ? Object.is(before.value, after.value) : afterPresent;
  const beforeOther = [...before.properties].filter(([name]) => name !== "nextTick");
  const afterOther = [...after.properties].filter(([name]) => name !== "nextTick");
  const otherPropertiesUnchanged = beforeOther.length === afterOther.length
    && beforeOther.every(([name, value]) => after.properties.has(name) && Object.is(after.properties.get(name), value));
  const setImmediateValue = (globalThis as { setImmediate?: unknown }).setImmediate;
  const setImmediateIsFunction = typeof setImmediateValue === "function";
  const afterNextTickIsFunction = typeof after.nextTick === "function";
  const fallbackInstalled = before.nextTick == null
    && setImmediateIsFunction
    && afterNextTickIsFunction
    && Object.is(after.nextTick, setImmediateValue);
  const existingNextTickPreserved = typeof before.nextTick === "function"
    && afterNextTickIsFunction
    && Object.is(before.nextTick, after.nextTick);
  const soleAllowedMutation = processIdentityAllowed
    && otherPropertiesUnchanged
    && afterNextTickIsFunction
    && (fallbackInstalled || existingNextTickPreserved);
  return {
    state: fallbackInstalled ? "installed-setImmediate-fallback" : existingNextTickPreserved ? "preserved-existing-function" : "invalid",
    transition: fallbackInstalled ? "I" : existingNextTickPreserved ? "P" : "X",
    beforeProcessPresent: beforePresent,
    afterProcessPresent: afterPresent,
    processIdentityAllowed,
    beforeNextTickIsFunction: typeof before.nextTick === "function",
    afterNextTickIsFunction,
    setImmediateIsFunction,
    fallbackInstalled,
    existingNextTickPreserved,
    otherPropertiesUnchanged,
    soleAllowedMutation,
  } as const;
}

function platformIdentity(): "android" | "ios" | "unsupported" {
  return Platform.OS === "android" || Platform.OS === "ios" ? Platform.OS : "unsupported";
}

function releaseIdentity(): boolean {
  return typeof __DEV__ === "boolean" && __DEV__ === false;
}

function initialState(): ProofState {
  return {
    failures: [],
    failureCodes: new Set(),
    platform: platformIdentity(),
    release: releaseIdentity(),
    hermes: EXPO_BUILD_CONTRACT.jsEngine === "hermes"
      && Boolean((globalThis as { HermesInternal?: unknown }).HermesInternal),
    newArchitecture: EXPO_BUILD_CONTRACT.newArchEnabled === true
      && (
        (globalThis as { RN$Bridgeless?: unknown }).RN$Bridgeless === true
        || (globalThis as { nativeFabricUIManager?: unknown }).nativeFabricUIManager != null
      ),
    backend: {
      adapter: "UNRESOLVED",
      native: "UNRESOLVED",
      rootImports: false,
      installCalled: true,
      rng: EXPECTED_RNG,
      cryptoGlobal: false,
      bufferGlobal: false,
      nextTick: false,
      processShim: null,
    },
    capabilities: {},
    vector: {
      archiveLength: 0,
      archiveSha256: "",
      derivedKeyHex: "",
      wrongPassphraseRejected: false,
    },
    productionHeaders: {
      archivesDiffer: false,
      bothRoundTrip: false,
      noncePrefixBytes: 8,
      saltBytes: 16,
    },
    selfTest: {
      ok: false,
      count: 8,
      rfc: false,
      node: false,
      aes: false,
      sliced: false,
      rejections: false,
      tamper: false,
      queue: false,
      framing: false,
      failures: [],
    },
    scrypt: { warmupMs: null, timing: null },
    aes: { ciphertextAndTagBytes: null, encrypt: null, decrypt: null },
    heartbeatMaxGapMs: null,
  };
}

function addFailure(state: ProofState, code: G016FailureCode, message: string): void {
  state.failureCodes.add(code);
  if (!state.failures.includes(message)) state.failures.push(message);
}

function requireCheck(state: ProofState, condition: boolean, code: G016FailureCode, message: string): void {
  if (!condition) addFailure(state, code, message);
}

function sha256HexAndWipe(crypto: BackupCryptoPort, value: Uint8Array): string {
  const digest = crypto.sha256(value);
  try {
    return toHex(digest);
  } finally {
    wipeBytes(digest);
  }
}

function wipeReadResult(result: Awaited<ReturnType<typeof readFmbk>> | undefined): void {
  if (result === undefined) return;
  wipeBytes(result.plaintext, ...result.entries.map((entry) => entry.content));
}

function compactInput(state: ProofState): CompactProofInput {
  return {
    failures: [...state.failureCodes],
    platform: state.platform,
    release: state.release,
    hermes: state.hermes,
    newArchitecture: state.newArchitecture,
    integrity: {
      sourceSha256: SOURCE_FINGERPRINT_SHA256,
      resolutionSha256: RESOLUTION_SHA256,
    },
    backend: {
      adapter: state.backend.adapter,
      native: state.backend.native,
      rootImports: state.backend.rootImports,
      installCalled: state.backend.installCalled,
      rng: state.backend.rng,
      cryptoGlobal: state.backend.cryptoGlobal,
      bufferGlobal: state.backend.bufferGlobal,
      nextTick: state.backend.nextTick,
      transition: state.backend.processShim?.transition ?? "X",
    },
    vector: { bytes: state.vector.archiveLength, sha256: state.vector.archiveSha256 },
    selfTest: {
      ok: state.selfTest.ok,
      count: state.selfTest.count,
      rfc: state.selfTest.rfc,
      node: state.selfTest.node,
      aes: state.selfTest.aes,
      sliced: state.selfTest.sliced,
      rejections: state.selfTest.rejections,
      tamper: state.selfTest.tamper,
      queue: state.selfTest.queue,
      framing: state.selfTest.framing,
    },
    runs: { warmup: 1, scrypt: MEASURED_RUNS, aes: MEASURED_RUNS },
    scrypt: { p95: state.scrypt.timing?.p95Ms ?? null, max: state.scrypt.timing?.maxMs ?? null },
    aes: {
      encP95: state.aes.encrypt?.p95Ms ?? null,
      decP95: state.aes.decrypt?.p95Ms ?? null,
      plaintextBytes: AES_SAMPLE_BYTES,
      framedBytes: state.aes.ciphertextAndTagBytes,
      tagBytes: AES_TAG_BYTES,
    },
    heartbeat: { max: state.heartbeatMaxGapMs, limit: BUDGETS.heartbeatMaxGapMs },
  };
}

function detailedReport(state: ProofState) {
  return {
    schemaVersion: 2,
    status: state.failureCodes.size === 0 ? "IN_PROCESS_PASS" : "IN_PROCESS_FAIL",
    finalDeviceAcceptance: false,
    failures: state.failures,
    failureCodes: [...state.failureCodes].sort((left, right) => left - right),
    platform: state.platform,
    release: state.release,
    hermes: state.hermes,
    newArchitecture: state.newArchitecture,
    backend: {
      adapter: state.backend.adapter,
      identity: state.backend.native,
      packageRootNamedImports: state.backend.rootImports,
      installCalled: state.backend.installCalled,
      secureRandomSource: `${state.backend.rng} getRandomBytes`,
      globals: {
        cryptoIdentityUnchanged: state.backend.cryptoGlobal,
        bufferIdentityUnchanged: state.backend.bufferGlobal,
        processNextTickShim: state.backend.processShim,
      },
    },
    capabilities: state.capabilities,
    budgets: BUDGETS,
    vectors: {
      rfcScrypt: "RFC7914-1",
      nodeScrypt: "G016-SCRYPT-N32768-r8-p1-dk32",
      aesGcm: "NIST-AES256-GCM-EMPTY+SLICED",
      fmbk: "FMBK-v1",
    },
    nativeSelfTests: state.selfTest,
    vector: state.vector,
    productionHeaders: state.productionHeaders,
    scrypt: {
      parameters: SCRYPT_PARAMETERS,
      configuredMaxMemoryBytes: CONFIGURED_SCRYPT_MEMORY_BYTES,
      accountedMemoryBytes: ACCOUNTED_SCRYPT_MEMORY_BYTES,
      warmupMs: state.scrypt.warmupMs,
      measuredRuns: MEASURED_RUNS,
      timing: state.scrypt.timing,
    },
    aesGcm4MiB: {
      plaintextBytes: AES_SAMPLE_BYTES,
      ciphertextAndTagBytes: state.aes.ciphertextAndTagBytes,
      tagBytes: AES_TAG_BYTES,
      measuredRuns: MEASURED_RUNS,
      encrypt: state.aes.encrypt,
      decrypt: state.aes.decrypt,
    },
    heartbeat: {
      maxGapMs: state.heartbeatMaxGapMs,
      thresholdMs: BUDGETS.heartbeatMaxGapMs,
    },
  } as const;
}

export async function runMobileProof() {
  const state = initialState();
  requireCheck(
    state,
    /^[0-9a-f]{64}$/.test(SOURCE_FINGERPRINT_SHA256) && /^[0-9a-f]{64}$/.test(RESOLUTION_SHA256),
    G016_FAILURE.provenance,
    "Proof requires build-injected source and native-resolution SHA-256 values",
  );
  requireCheck(state, state.platform !== "unsupported", G016_FAILURE.platform, "Proof requires Android or iOS");
  requireCheck(state, state.release, G016_FAILURE.release, "Proof requires __DEV__ === false");
  requireCheck(state, state.hermes, G016_FAILURE.hermes, "Proof requires configured Hermes");
  requireCheck(
    state,
    state.newArchitecture,
    G016_FAILURE.capabilities,
    "Proof requires configured New Architecture with Fabric/Bridgeless runtime",
  );

  try {
    const globalObject = globalThis as { crypto?: unknown; Buffer?: unknown };
    const cryptoIdentityBefore = globalObject.crypto;
    const bufferIdentityBefore = globalObject.Buffer;
    const processBefore = captureProcessSnapshot();
    const nativeModule = await import("./nativeCryptoPort.ts");
    state.backend.adapter = nativeModule.NATIVE_CRYPTO_ADAPTER_IDENTITY;
    state.backend.native = nativeModule.NATIVE_CRYPTO_BACKEND;
    state.backend.rootImports = nativeModule.NATIVE_CRYPTO_PACKAGE_ROOT_IMPORTS;
    state.backend.installCalled = nativeModule.NATIVE_CRYPTO_INSTALL_CALLED;
    state.backend.cryptoGlobal = Object.is(cryptoIdentityBefore, globalObject.crypto);
    state.backend.bufferGlobal = Object.is(bufferIdentityBefore, globalObject.Buffer);
    state.backend.processShim = processNextTickShimProof(processBefore, captureProcessSnapshot());
    state.backend.nextTick = state.backend.processShim.soleAllowedMutation;

    requireCheck(state, state.backend.adapter === EXPECTED_ADAPTER, G016_FAILURE.adapter, "Native adapter identity mismatch");
    requireCheck(state, state.backend.native === EXPECTED_BACKEND, G016_FAILURE.backend, "Native backend identity mismatch");
    requireCheck(state, state.backend.rootImports, G016_FAILURE.backend, "Quick Crypto package-root imports were not proven");
    requireCheck(state, !state.backend.installCalled, G016_FAILURE.backend, "Quick Crypto install() was called");
    requireCheck(state, state.backend.cryptoGlobal, G016_FAILURE.cryptoGlobal, "Quick Crypto changed global.crypto identity");
    requireCheck(state, state.backend.bufferGlobal, G016_FAILURE.bufferGlobal, "Quick Crypto changed global.Buffer identity");
    requireCheck(state, state.backend.nextTick, G016_FAILURE.processNextTick, "Quick Crypto process.nextTick transition was invalid");

    const crypto = nativeModule.createNativeCryptoPort((length) => getRandomBytes(length));
    state.capabilities = capabilityProbes();
    requireCheck(
      state,
      Object.values(state.capabilities).every(Boolean),
      G016_FAILURE.capabilities,
      "A required runtime capability probe failed",
    );

    const selfTestModule = await import("./nativeCryptoSelfTests.ts");
    const nativeSelfTests = await selfTestModule.runNativeCryptoSelfTests(crypto);
    state.selfTest = {
      ...state.selfTest,
      ...nativeSelfTests.flags,
      failures: nativeSelfTests.failures,
      ok: false,
    };
    requireCheck(state, nativeSelfTests.flags.rfc, G016_FAILURE.rfcScrypt, "RFC 7914 native scrypt self-test failed");
    requireCheck(state, nativeSelfTests.flags.node, G016_FAILURE.nodeScrypt, "Production Node scrypt differential failed");
    requireCheck(state, nativeSelfTests.flags.aes, G016_FAILURE.aesKnownAnswer, "AES-GCM known-answer self-test failed");
    requireCheck(state, nativeSelfTests.flags.sliced, G016_FAILURE.aesSlicedViews, "AES-GCM sliced bridge views failed");
    requireCheck(state, nativeSelfTests.flags.rejections, G016_FAILURE.aesRejections, "AES-GCM rejection self-tests failed");
    requireCheck(state, nativeSelfTests.flags.tamper, G016_FAILURE.productionTamper, "Production tamper did not reach native authentication");
    requireCheck(state, nativeSelfTests.flags.queue, G016_FAILURE.queueOwnership, "Queued scrypt input ownership failed");

    const passphraseBytes = utf8(VECTOR_PASSPHRASE.normalize("NFC"));
    const vectorSalt = fromHex("000102030405060708090a0b0c0d0e0f");
    let derivedKey: Uint8Array | undefined;
    try {
      derivedKey = await crypto.deriveKey(passphraseBytes, vectorSalt, SCRYPT_PARAMETERS);
      state.vector.derivedKeyHex = toHex(derivedKey);
    } finally {
      wipeBytes(derivedKey, passphraseBytes, vectorSalt);
    }
    requireCheck(state, state.vector.derivedKeyHex === VECTOR_DERIVED_KEY_HEX, G016_FAILURE.vector, "Normative derived key mismatch");

    const vectorInputEntries = vectorEntries();
    let vectorArchive: Uint8Array | undefined;
    let vectorRead: Awaited<ReturnType<typeof readFmbk>> | undefined;
    try {
      vectorArchive = await writeFmbk(
        VECTOR_PASSPHRASE,
        vectorHeader(),
        vectorInputEntries,
        crypto,
        { mode: "normative-vector" },
      );
      state.vector.archiveLength = vectorArchive.length;
      state.vector.archiveSha256 = sha256HexAndWipe(crypto, vectorArchive);
      vectorRead = await readFmbk(vectorArchive, VECTOR_PASSPHRASE, crypto, {
        availableStorageBytes: 3,
        mode: "normative-vector",
      });
      try {
        const unexpected = await readFmbk(vectorArchive, "wrong-passphrase", crypto, {
          availableStorageBytes: 3,
          mode: "normative-vector",
        });
        wipeReadResult(unexpected);
      } catch (error) {
        if (isFmbkAuthenticationFailure(error)) {
          state.vector.wrongPassphraseRejected = true;
        } else {
          throw error;
        }
      }
    } finally {
      wipeReadResult(vectorRead);
      wipeBytes(vectorArchive, ...vectorInputEntries.map((entry) => entry.content));
    }
    requireCheck(
      state,
      state.vector.archiveLength === VECTOR_ARCHIVE_LENGTH && state.vector.archiveSha256 === VECTOR_ARCHIVE_SHA256,
      G016_FAILURE.vector,
      "Normative FMBK vector mismatch",
    );
    requireCheck(state, state.vector.wrongPassphraseRejected, G016_FAILURE.wrongPassphrase, "Wrong passphrase was not rejected");

    const firstEntries = vectorEntries();
    const secondEntries = vectorEntries();
    let firstArchive: Uint8Array | undefined;
    let secondArchive: Uint8Array | undefined;
    let firstRead: Awaited<ReturnType<typeof readFmbk>> | undefined;
    let secondRead: Awaited<ReturnType<typeof readFmbk>> | undefined;
    try {
      firstArchive = await writeFmbk(VECTOR_PASSPHRASE, undefined, firstEntries, crypto);
      secondArchive = await writeFmbk(VECTOR_PASSPHRASE, undefined, secondEntries, crypto);
      firstRead = await readFmbk(firstArchive, VECTOR_PASSPHRASE, crypto, { availableStorageBytes: 3 });
      secondRead = await readFmbk(secondArchive, VECTOR_PASSPHRASE, crypto, { availableStorageBytes: 3 });
      state.productionHeaders.bothRoundTrip = true;
      state.productionHeaders.archivesDiffer = firstRead.header.salt_b64 !== secondRead.header.salt_b64
        && firstRead.header.nonce_prefix_b64 !== secondRead.header.nonce_prefix_b64
        && sha256HexAndWipe(crypto, firstArchive) !== sha256HexAndWipe(crypto, secondArchive);
    } finally {
      wipeReadResult(firstRead);
      wipeReadResult(secondRead);
      wipeBytes(
        firstArchive,
        secondArchive,
        ...firstEntries.map((entry) => entry.content),
        ...secondEntries.map((entry) => entry.content),
      );
    }
    requireCheck(
      state,
      state.productionHeaders.bothRoundTrip && state.productionHeaders.archivesDiffer,
      G016_FAILURE.productionHeaders,
      "Production header uniqueness/round-trip proof failed",
    );

    const heartbeat = startHeartbeat();
    const benchmarkSalt = fromHex("000102030405060708090a0b0c0d0e0f");
    const benchmarkPassphrase = utf8(VECTOR_PASSPHRASE);
    const scryptSamples: number[] = [];
    try {
      const warmupStart = now();
      let warmupKey: Uint8Array | undefined;
      try {
        warmupKey = await crypto.deriveKey(benchmarkPassphrase, benchmarkSalt, SCRYPT_PARAMETERS);
        state.scrypt.warmupMs = round(now() - warmupStart);
      } finally {
        wipeBytes(warmupKey);
      }
      await delay();
      for (let index = 0; index < MEASURED_RUNS; index += 1) {
        const started = now();
        let key: Uint8Array | undefined;
        try {
          key = await crypto.deriveKey(benchmarkPassphrase, benchmarkSalt, SCRYPT_PARAMETERS);
          scryptSamples.push(now() - started);
        } finally {
          wipeBytes(key);
        }
        await delay();
      }
      state.scrypt.timing = timingSummary(scryptSamples);

      const aesBenchmark = await runAesGcmBenchmark(crypto, {
        measuredRuns: MEASURED_RUNS,
        plaintextBytes: AES_SAMPLE_BYTES,
        now,
        delay,
      });
      state.aes.ciphertextAndTagBytes = aesBenchmark.ciphertextAndTagBytes;
      state.aes.encrypt = timingSummary(aesBenchmark.encryptSamplesMs);
      state.aes.decrypt = timingSummary(aesBenchmark.decryptSamplesMs);
    } finally {
      wipeBytes(benchmarkPassphrase, benchmarkSalt);
      state.heartbeatMaxGapMs = await heartbeat.stop();
    }

    state.selfTest.framing = state.aes.ciphertextAndTagBytes === AES_SAMPLE_BYTES + AES_TAG_BYTES;
    state.selfTest.ok = nativeSelfTests.ok && state.selfTest.framing;
    requireCheck(state, state.selfTest.framing, G016_FAILURE.aesFraming, "4 MiB AES-GCM framing was not plaintext+16-byte-tag");
    requireCheck(
      state,
      (state.scrypt.timing?.p95Ms ?? Number.POSITIVE_INFINITY) <= BUDGETS.scryptP95Ms,
      G016_FAILURE.scryptP95,
      "Scrypt p95 exceeded 2,000 ms",
    );
    requireCheck(
      state,
      (state.scrypt.timing?.maxMs ?? Number.POSITIVE_INFINITY) <= BUDGETS.scryptMaxMs,
      G016_FAILURE.scryptMax,
      "Scrypt max exceeded 3,000 ms",
    );
    requireCheck(
      state,
      (state.aes.encrypt?.p95Ms ?? Number.POSITIVE_INFINITY) <= BUDGETS.aesEncryptP95Ms,
      G016_FAILURE.aesEncryptP95,
      "AES-GCM encrypt p95 exceeded 200 ms",
    );
    requireCheck(
      state,
      (state.aes.decrypt?.p95Ms ?? Number.POSITIVE_INFINITY) <= BUDGETS.aesDecryptP95Ms,
      G016_FAILURE.aesDecryptP95,
      "AES-GCM decrypt p95 exceeded 200 ms",
    );
    requireCheck(
      state,
      (state.heartbeatMaxGapMs ?? Number.POSITIVE_INFINITY) <= BUDGETS.heartbeatMaxGapMs,
      G016_FAILURE.heartbeat,
      "Heartbeat max gap exceeded 250 ms",
    );
  } catch (error) {
    addFailure(state, G016_FAILURE.uncaught, error instanceof Error ? error.message : String(error));
  }

  return { report: detailedReport(state), compact: compactInput(state) };
}

let terminalProof: Promise<Awaited<ReturnType<typeof runMobileProof>>["report"]> | undefined;
let terminalRecordLogged = false;

function emitTerminalRecord(compact: CompactProofInput): void {
  if (terminalRecordLogged) throw new Error("G016 compact proof record was already emitted");
  const record = serializeCompactProof(compact);
  terminalRecordLogged = true;
  console.log(record);
}

export function runAndLogMobileProof(): Promise<Awaited<ReturnType<typeof runMobileProof>>["report"]> {
  terminalProof ??= runMobileProof().then(
    ({ report, compact }) => {
      emitTerminalRecord(compact);
      if (report.status === "IN_PROCESS_FAIL") throw new Error(report.failures.join("; "));
      return report;
    },
    (error: unknown) => {
      const state = initialState();
      addFailure(state, G016_FAILURE.uncaught, error instanceof Error ? error.message : String(error));
      emitTerminalRecord(compactInput(state));
      throw error;
    },
  );
  return terminalProof;
}
