import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  inspectNativeScheme,
  parseIosPlistWithPlutil,
  validateIosPlist,
} from "../../../tools/check-native-schemes.mjs";

const opening = `<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application><activity android:name=".MainActivity">`;
const validFilter = `<intent-filter><action android:name="android.intent.action.VIEW"/><category android:name="android.intent.category.DEFAULT"/><category android:name="android.intent.category.BROWSABLE"/><data android:scheme="formobile-test"/></intent-filter>`;
const closing = `</activity></application></manifest>`;

async function android(xml: string, flavor: "production" | "e2e") {
  const root = await mkdtemp(join(tmpdir(), "g018-scheme-"));
  const path = join(root, "AndroidManifest.xml");
  try {
    await writeFile(path, xml);
    return await inspectNativeScheme("android", flavor, path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Android validates exact intent-filter scheme placement and flavor count through the Expo facade", async () => {
  assert.equal((await android(opening + closing, "production")).structure.count, 0);
  assert.equal((await android(opening + validFilter + closing, "e2e")).structure.count, 1);
  await assert.rejects(android(`${opening}${validFilter}${validFilter}${closing}`, "e2e"), /structural/);
  await assert.rejects(android(`${opening}<meta-data android:scheme="formobile-test"/>${closing}`, "e2e"), /wrong placement/);
  const source = await readFile("tools/check-native-schemes.mjs", "utf8");
  assert.match(source, /require\("expo\/config-plugins"\)/);
  assert.doesNotMatch(source, /@expo\/(?:config-plugins|plist)/);
});

test("Android comments and unrelated values cannot impersonate an E2E scheme node", async () => {
  await assert.rejects(android(`${opening}<!-- android:scheme="formobile-test" --><meta-data android:value="formobile-test"/>${closing}`, "e2e"), /structural/);
  assert.equal((await android(`${opening}<!-- formobile-test --><meta-data android:value="formobile-test"/>${closing}`, "production")).structure.count, 0);
});

test("iOS pure validation accepts only the exact CFBundle URL placement and count", () => {
  assert.equal(validateIosPlist({}, "production").count, 0);
  assert.equal(validateIosPlist({ CFBundleURLTypes: [{ CFBundleURLSchemes: ["formobile-test"] }] }, "e2e").count, 1);
  assert.throws(() => validateIosPlist({ CFBundleURLTypes: [{ CFBundleURLSchemes: ["formobile-test", "formobile-test"] }] }, "e2e"), /structural/);
  assert.throws(() => validateIosPlist({ Unrelated: "formobile-test" }, "production"), /structural/);
  assert.throws(() => validateIosPlist({ Unrelated: "formobile-test" }, "e2e"), /structural/);
  assert.throws(() => validateIosPlist({ CFBundleURLTypes: [{ WrongKey: ["formobile-test"] }] }, "e2e"), /structural/);
});

test("iOS plist parsing is macOS-only, uses plutil, and fails closed", () => {
  const calls: unknown[][] = [];
  const validRun = (...args: unknown[]) => {
    calls.push(args);
    return { status: 0, stdout: '{"CFBundleURLTypes":[]}', stderr: "", error: undefined };
  };
  assert.deepEqual(parseIosPlistWithPlutil("Info.plist", validRun as never, "darwin"), { CFBundleURLTypes: [] });
  assert.deepEqual(calls[0]?.slice(0, 2), ["plutil", ["-convert", "json", "-o", "-", "--", "Info.plist"]]);
  assert.throws(() => parseIosPlistWithPlutil("Info.plist", validRun as never, "linux"), /macOS plutil/);
  assert.throws(() => parseIosPlistWithPlutil("Info.plist", (() => ({ status: 1, stdout: "", stderr: "bad", error: undefined })) as never, "darwin"), /failed to parse/);
  assert.throws(() => parseIosPlistWithPlutil("Info.plist", (() => ({ status: 0, stdout: "not-json", stderr: "", error: undefined })) as never, "darwin"), /malformed JSON/);
});
