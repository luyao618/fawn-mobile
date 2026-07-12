import { fetch as expoFetch } from "expo/fetch";
import { Platform } from "react-native";

import { streamChatCompletion } from "./adapter.ts";
import { TransportError } from "./contracts.ts";
import { buildChatCompletionsUrl, buildStreamingChatRequest } from "./url.ts";

declare const __DEV__: boolean;

export const G017_PROOF_PREFIX = "G017_TRANSPORT_PROOF ";
export const G017_PROOF_CONTRACT = "for-mobile-g017-device-proof-v1";
export const G017_DEPENDENCY_IDENTITY = Object.freeze({
  expo: "57.0.4",
  react: "19.2.3",
  reactNative: "0.86.0",
  eventsourceParser: "3.1.0",
});

const payload = buildStreamingChatRequest({
  model: "synthetic-model",
  messages: [{ role: "user", content: "synthetic device probe" }],
  temperature: 0.2,
});

export class DeviceProofError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "DeviceProofError";
  }
}

function proofFailure(code: string): never {
  throw new DeviceProofError(code);
}

function serverBaseUrl(): string {
  const configured = process.env.EXPO_PUBLIC_G017_MOCK_URL;
  if (configured) return configured;
  return Platform.OS === "android" ? "http://10.0.2.2:43117" : "http://127.0.0.1:43117";
}

function sourceFingerprint(): string {
  const value = process.env.EXPO_PUBLIC_G017_SOURCE_FINGERPRINT ?? "";
  if (!/^[a-f0-9]{64}$/.test(value)) proofFailure("SOURCE_FINGERPRINT_MISSING");
  return value;
}

function assertReleaseRuntime(): void {
  const runtime = globalThis as typeof globalThis & Record<string, unknown>;
  if (__DEV__) proofFailure("NOT_RELEASE_RUNTIME");
  if (runtime.HermesInternal === undefined) proofFailure("HERMES_NOT_ACTIVE");
  if (runtime.nativeFabricUIManager === undefined) proofFailure("NEW_ARCH_NOT_ACTIVE");
  if (Platform.OS !== "android" && Platform.OS !== "ios") proofFailure("UNSUPPORTED_PLATFORM");
}

export async function runDeviceProof() {
  assertReleaseRuntime();
  const baseUrl = serverBaseUrl();
  const fetchImpl = expoFetch as unknown as typeof fetch;
  const profiles: Array<{ profile: "profile-a" | "profile-b"; content: string }> = [];
  for (const profile of ["profile-a", "profile-b"] as const) {
    const result = await streamChatCompletion(
      fetchImpl,
      buildChatCompletionsUrl(`${baseUrl}/${profile}`, "chat/completions", true),
      payload,
    );
    const expected = profile === "profile-a" ? "profile-a ok" : "profile-b 宝宝 ok";
    if (result.content !== expected) proofFailure("PROFILE_OUTPUT_MISMATCH");
    profiles.push({ profile, content: result.content });
  }

  const controller = new AbortController();
  const abortRequest = streamChatCompletion(
    fetchImpl,
    buildChatCompletionsUrl(`${baseUrl}/abort`, "chat/completions", true),
    payload,
    controller.signal,
  );
  setTimeout(() => controller.abort(), 50);
  let abortCategory = "missing";
  try {
    await abortRequest;
  } catch (error) {
    abortCategory = error instanceof TransportError ? error.category : "unexpected";
  }
  if (abortCategory !== "cancelled") proofFailure("CANCELLATION_FAILED");

  return Object.freeze({
    schemaVersion: 1,
    contractId: G017_PROOF_CONTRACT,
    status: "PASS" as const,
    platform: Platform.OS as "android" | "ios",
    targetScope: "emulator-or-simulator-local-mock-only" as const,
    release: true,
    hermes: true,
    newArchitecture: true,
    profiles,
    cancellation: "cancelled" as const,
    sourceFingerprint: sourceFingerprint(),
    dependencies: G017_DEPENDENCY_IDENTITY,
  });
}
