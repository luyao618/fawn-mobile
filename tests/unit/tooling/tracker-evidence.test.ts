import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import { applyUserDatabaseMigrations } from "../../../src/infrastructure/db/migrations/index.ts";
import {
  canonicalJson,
  collectTrackerPrivacyProof,
  deriveTrackerFixture,
  migrationIdentity,
  sha256Canonical,
  snapshotTrackerDatabase,
  validateCanonicalTrackerReportBytes,
  validateTrackerReport,
} from "../../../tools/tracker-evidence.mjs";

const TOOL_PATH = resolve("tools/tracker-evidence.mjs");
const FIXTURE_PATH = resolve("tests/fixtures/tracker/manual-tracker-v1.json");
const MIGRATION_PATH = resolve("src/infrastructure/db/migrations/migration1.ts");
const SHA = "a".repeat(40);
const DOMAINS = ["growth", "feeding", "sleep", "diaper", "health"] as const;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function parameters(values: readonly unknown[]): SQLInputValue[] {
  return values as SQLInputValue[];
}

async function migrate(db: DatabaseSync): Promise<void> {
  const adapter = {
    async execAsync(sql: string) { db.exec(sql); },
    async getAllAsync<T>(sql: string, ...values: unknown[]) {
      return db.prepare(sql).all(...parameters(values)) as T[];
    },
    async runAsync(sql: string, ...values: unknown[]) {
      return db.prepare(sql).run(...parameters(values));
    },
  };
  db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");
  await applyUserDatabaseMigrations(adapter, undefined, () => "2026-07-20T00:00:00.000Z");
}

function insertManualRows(db: DatabaseSync): void {
  db.exec(`BEGIN IMMEDIATE;
    INSERT INTO growth_records(
      id,measurement_date,weight_g,height_cm,head_cm,weight_percentile,height_percentile,head_percentile,
      notes,source_message_id,created_at,updated_at,deleted_at
    ) VALUES ('tracker-growth-runtime','2026-07-19',7200,68.5,43.2,NULL,NULL,NULL,
      'synthetic growth',NULL,'2026-07-20T01:10:00.000Z','2026-07-20T01:10:00.000Z',NULL);
    INSERT INTO feeding_records(
      id,feed_time,feed_type,amount_ml,duration_min,notes,source_message_id,created_at,updated_at,deleted_at
    ) VALUES ('tracker-feeding-runtime','2026-07-20T00:10:00.000Z','formula',100,NULL,
      'synthetic feeding',NULL,'2026-07-20T01:11:00.000Z','2026-07-20T01:16:00.000Z',NULL);
    INSERT INTO sleep_records(
      id,sleep_start,sleep_end,sleep_type,night_wakings,notes,source_message_id,created_at,updated_at,deleted_at
    ) VALUES ('tracker-sleep-runtime','2026-07-19T20:00:00.000Z','2026-07-20T01:00:00.000Z','night',2,
      'synthetic sleep',NULL,'2026-07-20T01:12:00.000Z','2026-07-20T01:12:00.000Z',NULL);
    INSERT INTO diaper_records(
      id,diaper_time,diaper_type,notes,source_message_id,created_at,updated_at,deleted_at
    ) VALUES ('tracker-diaper-runtime','2026-07-20T00:20:00.000Z','mixed','synthetic diaper',NULL,
      '2026-07-20T01:13:00.000Z','2026-07-20T01:17:00.000Z','2026-07-20T01:17:00.000Z');
    INSERT INTO health_records(
      id,record_date,record_type,title,description,source_message_id,created_at,updated_at,deleted_at
    ) VALUES ('tracker-health-runtime','2026-07-18','checkup','Synthetic checkup','synthetic health',NULL,
      '2026-07-20T01:14:00.000Z','2026-07-20T01:14:00.000Z',NULL);
    COMMIT;`);
}

async function createDatabase(path: string, populated: boolean): Promise<DatabaseSync> {
  const db = new DatabaseSync(path);
  await migrate(db);
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  if (populated) insertManualRows(db);
  return db;
}

function canonicalReportWrite(path: string, report: unknown): Buffer {
  const bytes = Buffer.from(canonicalJson(report));
  writeFileSync(path, bytes);
  return bytes;
}

function git(root: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function trackedRoot(directory: string): string {
  const root = join(directory, "evidence-root");
  const files: Record<string, string | Buffer> = {
    "tests/fixtures/tracker/manual-tracker-v1.json": readFileSync(FIXTURE_PATH),
    "src/infrastructure/db/migrations/migration1.ts": readFileSync(MIGRATION_PATH),
    "tools/tracker-evidence.mjs": readFileSync(TOOL_PATH),
    "e2e/maestro/tracker-save-edit-delete.yaml": "appId: com.luyao618.formobile\n---\n- assertVisible: '^保存健康记录$'\n",
    "e2e/maestro/tracker-restart.yaml": "appId: com.luyao618.formobile\n---\n- assertVisible: '^生长$'\n",
    "scripts/e2e/run-tracker-restart-android.sh": "#!/usr/bin/env bash\nset -euo pipefail\n",
    "scripts/e2e/run-tracker-restart-ios.sh": "#!/usr/bin/env bash\nset -euo pipefail\n",
    "App.tsx": "export default function App() { return null; }\n",
    "index.ts": "export {};\n",
    "app.config.ts": "export default {};\n",
  };
  for (const [relative, bytes] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  git(root, "init", "--quiet");
  git(root, "add", ".");
  return root;
}

function identity(root: string, path: string): { path: string; sha256: string } {
  return { path, sha256: sha256(readFileSync(join(root, path))) };
}

function accessibility(platform: "android" | "ios") {
  return {
    selectorPolicy: {
      allowedKinds: ["id", "textBelowText", "exactText"],
      anchoredSelectorCount: 47,
      coordinateTapCount: 0,
      indexSelectorCount: 0,
      ambiguousSelectorCount: 0,
      optionalCommandCount: 0,
      retryCommandCount: 0,
      sleepCommandCount: 0,
    },
    keyboardDismissal: {
      strategy: platform === "android"
        ? "maestro-hideKeyboard-then-entered-value-below-field"
        : "maestro-down-swipe-then-entered-value-below-field",
      mandatory: true,
    },
    nativeObservations: {
      healthConfirmationEntered: true,
      healthCancelReturnedToEditor: true,
      healthEditorFieldsUnchanged: true,
      healthCheckupConfirmationFieldObservedWithoutRetap: true,
      healthSecondSubmitObserved: true,
      healthFinalConfirmationObserved: true,
      feedingFormulaCreatedRowObserved: true,
      feedingNinetyToHundredDiffObserved: true,
      feedingUpdateFinalConfirmationObserved: true,
      sleepNightCreatedRowObserved: true,
      diaperMixedCreatedRowObserved: true,
      diaperDeleteIdentifyingSummaryObserved: true,
      diaperConsequenceObserved: true,
      diaperFinalConfirmationObserved: true,
      relaunchActiveRowsObserved: true,
      relaunchDiaperAbsentObserved: true,
    },
    claims: { physicalDevice: false, screenReader: false, e2e006: false },
  };
}

function lifecycle(platform: "android" | "ios") {
  const phase = (pid: number) => ({ pid, terminated: true, absentBeforeSnapshot: true });
  return {
    metro: {
      ownedPid: 456,
      terminatedBeforeTracker: true,
      probeBeforeTrackerFailed: true,
      probeBeforeReportFailed: true,
    },
    androidReverse: platform === "android"
      ? { port: 8081, absentBeforeTracker: true, absentBeforeReport: true }
      : null,
    directLaunches: { preSave: phase(101), save: phase(202), relaunch: phase(303) },
    zoneObservations: { preSave: "Asia/Shanghai", postSave: "Asia/Shanghai", postRelaunch: "Asia/Shanghai" },
    freshInstallCount: 1,
    postInstallMutations: { install: 0, clear: 0, seed: 0, databasePush: 0, rebuild: 0, metroRestart: 0 },
    saveRelaunchPidDifferent: true,
    restartProof: platform === "android"
      ? "terminated-snapshot-direct-relaunch-same-installed-apk"
      : "terminated-snapshot-direct-relaunch-same-ios-three-component-identity",
  };
}

function binary(platform: "android" | "ios") {
  if (platform === "android") {
    const value = { apkSha256: "1".repeat(64), embeddedBundleSha256: "2".repeat(64) };
    return { format: "apk", source: value, installedBefore: { ...value }, installedAfter: { ...value } };
  }
  const value = {
    executableSha256: "1".repeat(64),
    mainJsBundleSha256: "2".repeat(64),
    infoPlistCanonicalSha256: "3".repeat(64),
  };
  return {
    format: "ios-three-component-identity",
    source: value,
    installedBefore: { ...value },
    installedAfter: { ...value },
  };
}

function reportFor(
  root: string,
  platform: "android" | "ios",
  preSave: ReturnType<typeof snapshotTrackerDatabase>,
  postSave: ReturnType<typeof snapshotTrackerDatabase>,
) {
  const fixture = deriveTrackerFixture("Asia/Shanghai", root);
  const privacy = collectTrackerPrivacyProof({
    preSave: preSave.modelCounts,
    postSave: postSave.modelCounts,
    postRelaunch: postSave.modelCounts,
  }, root);
  const migration = migrationIdentity(root);
  const runnerPath = `scripts/e2e/run-tracker-restart-${platform}.sh`;
  return {
    schemaVersion: 1,
    reportType: "manual-tracker-offline-restart",
    platform,
    flavor: "e2e-release",
    checkedOutSha: SHA,
    expectedSha: SHA,
    testId: "G025-E2E-001",
    fixture,
    accessibility: accessibility(platform),
    binary: binary(platform),
    database: { preSave, postSave, postRelaunch: structuredClone(postSave) },
    lifecycle: lifecycle(platform),
    privacy,
    migration,
    evidence: {
      flows: {
        saveEditDelete: identity(root, "e2e/maestro/tracker-save-edit-delete.yaml"),
        restart: identity(root, "e2e/maestro/tracker-restart.yaml"),
      },
      fixture: identity(root, "tests/fixtures/tracker/manual-tracker-v1.json"),
      tool: identity(root, "tools/tracker-evidence.mjs"),
      runner: identity(root, runnerPath),
    },
    status: "pass",
    skipped: [],
  };
}

function reportObjectPaths(value: unknown, path: (string | number)[] = [], result: (string | number)[][] = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => reportObjectPaths(entry, [...path, index], result));
  } else if (value !== null && typeof value === "object") {
    result.push(path);
    for (const [key, entry] of Object.entries(value)) reportObjectPaths(entry, [...path, key], result);
  }
  return result;
}

function objectAt(value: any, path: (string | number)[]): Record<string, unknown> {
  return path.reduce((current, key) => current[key], value) as Record<string, unknown>;
}

test("canonical JSON recursively sorts exact JSON values and hashes those UTF-8 bytes", () => {
  const value = { z: [{ beta: -0, alpha: "中文" }], a: { y: true, x: null } };
  const exact = '{"a":{"x":null,"y":true},"z":[{"alpha":"中文","beta":0}]}';
  assert.equal(canonicalJson(value), exact);
  assert.equal(sha256Canonical(value), sha256(exact));
  assert.equal(canonicalJson({ "10": "ten", "2": "two", A: 1, a: 2 }), '{"10":"ten","2":"two","A":1,"a":2}');

  for (const hostile of [
    { value: undefined }, { value: Number.NaN }, { value: Number.POSITIVE_INFINITY },
    { value: 1n }, { value: Symbol("x") }, { value: () => 1 },
    [1, , 3], new Date("2026-07-20T00:00:00.000Z"),
  ]) assert.throws(() => canonicalJson(hostile));
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => canonicalJson(cycle));
});

test("canonical JSON rejects symbol-keyed object properties", () => {
  const value: Record<PropertyKey, unknown> = { visible: true };
  value[Symbol("hidden")] = "not-json";

  assert.throws(() => canonicalJson(value), /symbol/i);
});

test("canonical JSON rejects named array properties", () => {
  const value = [1] as number[] & { hidden?: string };
  value.hidden = "not-json";

  assert.throws(() => canonicalJson(value), /array/i);
});

test("fixture bytes derive the exact manual projection, local inputs, labels, and hashes", () => {
  const fixture = deriveTrackerFixture("Asia/Shanghai");
  assert.deepEqual(Object.keys(fixture), [
    "path", "byteSha256", "semanticSha256", "manualProjectionSha256",
    "timeZone", "localInputs", "canonicalBusinessFacts",
  ]);
  assert.equal(fixture.byteSha256, "4960045548664bbabea2de291827b91ff9d1f2407630e16a0eb13117b92af69d");
  assert.equal(fixture.semanticSha256, "9092253c20a1b7677842583d143085d757c336647364baab7fb2f4124de2ab6f");
  assert.equal(fixture.manualProjectionSha256, "f48c55b06b681901f28c0fa8a7430bddd5cca4be3983b812718b4ed83af67da6");
  assert.equal(fixture.semanticSha256, sha256Canonical(JSON.parse(readFileSync(FIXTURE_PATH, "utf8"))));
  assert.equal(fixture.manualProjectionSha256, sha256Canonical(fixture.canonicalBusinessFacts));
  assert.deepEqual(fixture.localInputs, {
    growth: {
      measurementDate: "2026-07-19", weightG: "7200", heightCm: "68.5", headCm: "43.2",
      notes: "synthetic growth",
      rowLabel: "生长记录，2026年7月19日，体重 7200 克 · 身长 68.5 厘米 · 头围 43.2 厘米 · 有备注",
    },
    feeding: {
      feedDate: "2026-07-20", feedTime: "08:10", feedTypeLabel: "配方奶",
      createAmountMl: "90", updatedAmountMl: "100", durationMin: "", notes: "synthetic feeding",
      createRowLabel: "喂养记录，2026年7月20日 08:10（本机时间），配方奶 · 量 90 毫升 · 有备注",
      finalRowLabel: "喂养记录，2026年7月20日 08:10（本机时间），配方奶 · 量 100 毫升 · 有备注",
    },
    sleep: {
      startDate: "2026-07-20", startTime: "04:00", endDate: "2026-07-20", endTime: "09:00",
      sleepTypeLabel: "夜间睡眠", nightWakings: "2", notes: "synthetic sleep",
      rowLabel: "睡眠记录，2026年7月20日 04:00（本机时间），夜间睡眠 · 至 2026年7月20日 09:00（本机时间） · 夜醒 2 次 · 有备注",
    },
    diaper: {
      recordDate: "2026-07-20", recordTime: "08:20", diaperTypeLabel: "混合", notes: "synthetic diaper",
      rowLabel: "大小便记录，2026年7月20日 08:20（本机时间），混合 · 有备注",
    },
    health: {
      recordDate: "2026-07-18", recordTypeLabel: "常规检查", title: "Synthetic checkup",
      description: "synthetic health", rowLabel: "健康记录，2026年7月18日，常规检查 · Synthetic checkup · 有说明",
    },
  });
  assert.deepEqual(fixture.canonicalBusinessFacts.feeding, [{
    feed_time: "2026-07-20T00:10:00.000Z", feed_type: "formula", amount_ml: 100,
    duration_min: null, notes: "synthetic feeding", source_message_id: null, is_deleted: false,
  }]);
  assert.deepEqual(fixture.canonicalBusinessFacts.diaper, [{
    diaper_time: "2026-07-20T00:20:00.000Z", diaper_type: "mixed", notes: "synthetic diaper",
    source_message_id: null, is_deleted: true,
  }]);
  assert.equal(fixture.canonicalBusinessFacts.health[0]!.title, "Synthetic checkup");
  assert.throws(() => deriveTrackerFixture("UTC"), /Asia\/Shanghai/);
  assert.throws(() => deriveTrackerFixture("Not/AZone"), /time zone/i);
});

test("tracker snapshot consumes committed WAL sidecars and emits exact pre/post facts", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-tracker-evidence-wal-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "source.db");
  const writer = await createDatabase(source, false);
  const preSave = snapshotTrackerDatabase(source);
  assert.deepEqual(preSave.counts, {
    total: 0, active: 0, tombstoned: 0,
    byDomain: Object.fromEntries(DOMAINS.map((domain) => [domain, { total: 0, active: 0, tombstoned: 0 }])),
  });
  assert.deepEqual(preSave.rows, Object.fromEntries(DOMAINS.map((domain) => [domain, []])));
  assert.equal(preSave.businessFactsSha256, sha256Canonical(preSave.rows));

  insertManualRows(writer);
  assert.equal(existsSync(`${source}-wal`), true, "test must retain committed facts in WAL");
  const withoutSidecar = join(directory, "without-sidecar.db");
  copyFileSync(source, withoutSidecar);
  assert.equal(snapshotTrackerDatabase(withoutSidecar).counts.total, 0);

  const complete = join(directory, "complete.db");
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(`${source}${suffix}`)) copyFileSync(`${source}${suffix}`, `${complete}${suffix}`);
  }
  const postSave = snapshotTrackerDatabase(complete);
  assert.deepEqual(postSave.counts, {
    total: 5, active: 4, tombstoned: 1,
    byDomain: {
      growth: { total: 1, active: 1, tombstoned: 0 },
      feeding: { total: 1, active: 1, tombstoned: 0 },
      sleep: { total: 1, active: 1, tombstoned: 0 },
      diaper: { total: 1, active: 0, tombstoned: 1 },
      health: { total: 1, active: 1, tombstoned: 0 },
    },
  });
  assert.equal(postSave.rows.feeding[0]!.amount_ml, 100);
  assert.equal(postSave.rows.feeding[0]!.feed_type, "formula");
  assert.equal(postSave.rows.sleep[0]!.sleep_type, "night");
  assert.equal(postSave.rows.diaper[0]!.diaper_type, "mixed");
  assert.equal(postSave.rows.diaper[0]!.deleted_at, postSave.rows.diaper[0]!.updated_at);
  assert.equal(postSave.rows.health[0]!.title, "Synthetic checkup");
  assert.equal(postSave.businessFactsSha256, deriveTrackerFixture("Asia/Shanghai").manualProjectionSha256);
  assert.equal(postSave.fullRowsSha256, sha256Canonical(postSave.rows));
  assert.equal(postSave.fullRowsSha256, "ada93d4f60c973a094bde050b1103b2a276e6ea1011e1c543acf8d8e1b218adc");
  assert.deepEqual(postSave.migration, [{
    version: 1, name: "initial-schema",
    sha256: "f7dfa123b82ca6bb8f6ef6220c31f1d80fc987ea6435609d0e649367fc669cec",
  }]);
  assert.deepEqual(postSave.modelCounts, { modelConfig: 0, modelCapabilities: 0 });
  assert.deepEqual(postSave.foreignKeyViolations, []);
  assert.equal(postSave.journalMode, "wal");
  writer.close();
});

test("tracker snapshot closes its SQLite handle when a malformed database is rejected", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-tracker-evidence-fd-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = join(directory, "malformed.db");
  new DatabaseSync(database).close();
  const probe = `
    import { readdirSync } from "node:fs";
    import { snapshotTrackerDatabase } from "./tools/tracker-evidence.mjs";
    const descriptorDirectory = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
    const count = () => readdirSync(descriptorDirectory).length;
    const before = count();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try { snapshotTrackerDatabase(process.argv[1]); } catch {}
    }
    console.log(JSON.stringify({ before, after: count() }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe, database], {
    cwd: resolve("."),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const descriptors = JSON.parse(result.stdout) as { before: number; after: number };

  assert.equal(descriptors.after, descriptors.before);
});

test("canonical Android and iOS reports validate exact nested contracts and fail closed", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-tracker-report-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const prePath = join(directory, "pre.db");
  const postPath = join(directory, "post.db");
  const preDb = await createDatabase(prePath, false); preDb.close();
  const postDb = await createDatabase(postPath, true); postDb.close();
  const preSave = snapshotTrackerDatabase(prePath);
  const postSave = snapshotTrackerDatabase(postPath);
  const root = trackedRoot(directory);

  for (const platform of ["android", "ios"] as const) {
    const report = reportFor(root, platform, preSave, postSave);
    assert.equal(validateTrackerReport(report, platform, SHA, root), report);
    const reportPath = join(directory, `${platform}.json`);
    const bytes = canonicalReportWrite(reportPath, report);
    assert.equal(canonicalJson(validateCanonicalTrackerReportBytes(bytes, platform, SHA, root)), canonicalJson(report));
    assert.equal(bytes.at(-1), "}".charCodeAt(0));

    const missing = structuredClone(report); delete (missing.accessibility.nativeObservations as Record<string, unknown>).feedingFormulaCreatedRowObserved;
    assert.throws(() => validateTrackerReport(missing, platform, SHA, root), /nativeObservations keys/);
    const extra = structuredClone(report); (extra.database.postSave.counts.byDomain.feeding as Record<string, unknown>).private = 1;
    assert.throws(() => validateTrackerReport(extra, platform, SHA, root), /feeding counts keys/);
    const noncanonical = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
    assert.throws(() => validateCanonicalTrackerReportBytes(noncanonical, platform, SHA, root), /canonical/);
    const duplicate = Buffer.from(bytes.toString("utf8").replace(
      '"schemaVersion":1',
      '"schemaVersion":1,"schemaVersion":1',
    ));
    assert.throws(() => validateCanonicalTrackerReportBytes(duplicate, platform, SHA, root), /canonical/);
  }

  const base = reportFor(root, "android", preSave, postSave);
  const mutations: ((value: any) => void)[] = [
    (value) => { value.checkedOutSha = "b".repeat(40); },
    (value) => { value.fixture.timeZone = "UTC"; },
    (value) => { value.fixture.semanticSha256 = "0".repeat(64); },
    (value) => { value.fixture.manualProjectionSha256 = "0".repeat(64); },
    (value) => { value.fixture.localInputs.feeding.finalRowLabel = "partial"; },
    (value) => { value.fixture.canonicalBusinessFacts.feeding[0].amount_ml = 90; },
    (value) => { value.database.postSave = structuredClone(value.database.preSave); },
    (value) => { value.database.preSave.rows.growth.push(value.database.postSave.rows.growth[0]); },
    (value) => { value.database.postSave.counts.active = 5; },
    (value) => { value.database.postSave.rows.diaper.pop(); },
    (value) => { value.database.postSave.rows.growth[0].weight_percentile = 55; },
    (value) => { value.database.postSave.rows.sleep[0].source_message_id = "fixture-source"; },
    (value) => { value.database.postSave.rows.feeding[0].feed_type = "breast"; },
    (value) => { value.database.postSave.rows.feeding[0].notes = "changed with amount"; },
    (value) => { value.database.postSave.rows.feeding[0].created_at = value.database.postSave.rows.feeding[0].updated_at; },
    (value) => { value.database.postSave.rows.feeding[0].id = value.database.postSave.rows.growth[0].id; },
    (value) => { value.database.postSave.rows.sleep[0].created_at = "2026-07-20T01:12:00Z"; },
    (value) => { value.database.postSave.rows.diaper[0].deleted_at = null; },
    (value) => { value.database.postSave.rows.health[0].title = " Synthetic checkup "; },
    (value) => { value.database.postRelaunch.rows.health[0].id = "tracker-different-runtime"; },
    (value) => { value.database.postSave.businessFactsSha256 = "0".repeat(64); },
    (value) => { value.database.postSave.fullRowsSha256 = "0".repeat(64); },
    (value) => { value.binary.installedAfter.apkSha256 = "9".repeat(64); },
    (value) => { value.lifecycle.metro.ownedPid = 0; },
    (value) => { value.lifecycle.metro.probeBeforeReportFailed = false; },
    (value) => { value.lifecycle.directLaunches.save.pid = Number.MAX_SAFE_INTEGER + 1; },
    (value) => { value.lifecycle.directLaunches.relaunch.pid = value.lifecycle.directLaunches.save.pid; },
    (value) => { value.lifecycle.zoneObservations.postSave = "UTC"; },
    (value) => { value.lifecycle.androidReverse.absentBeforeReport = false; },
    (value) => { value.lifecycle.freshInstallCount = 2; },
    (value) => { value.lifecycle.postInstallMutations.seed = 1; },
    (value) => { value.privacy.claims.packetSilence = true; },
    (value) => { value.privacy.modelRows.postSave.modelConfig = 1; },
    (value) => { value.privacy.limitation = "No network traffic occurred."; },
    (value) => { value.migration.inventory.tables = 25; },
    (value) => { value.evidence.fixture.sha256 = "8".repeat(64); },
    (value) => { value.evidence.tool.sha256 = "8".repeat(64); },
    (value) => { value.evidence.flows.restart.sha256 = "8".repeat(64); },
    (value) => { value.accessibility.selectorPolicy.coordinateTapCount = 1; },
    (value) => { value.accessibility.nativeObservations.diaperConsequenceObserved = false; },
    (value) => { value.accessibility.claims.physicalDevice = true; },
    (value) => { value.status = "skipped"; },
    (value) => { value.skipped.push("health"); },
  ];
  for (const mutate of mutations) {
    const hostile = structuredClone(base);
    mutate(hostile);
    assert.throws(() => validateTrackerReport(hostile, "android", SHA, root));
  }

  for (const path of reportObjectPaths(base)) {
    const extra = structuredClone(base);
    objectAt(extra, path).__hostile_extra = true;
    assert.throws(() => validateTrackerReport(extra, "android", SHA, root), `accepted extra key at ${path.join(".")}`);

    const omitted = structuredClone(base);
    const target = objectAt(omitted, path);
    const [firstKey] = Object.keys(target);
    assert(firstKey, `expected an object key at ${path.join(".")}`);
    delete target[firstKey];
    assert.throws(() => validateTrackerReport(omitted, "android", SHA, root), `accepted omitted key at ${path.join(".")}`);
  }

  const ios = reportFor(root, "ios", preSave, postSave);
  assert("infoPlistCanonicalSha256" in ios.binary.installedBefore);
  ios.binary.installedBefore.infoPlistCanonicalSha256 = "9".repeat(64);
  assert.throws(() => validateTrackerReport(ios, "ios", SHA, root), /binary identity/);
});

test("tracker report accepts legal reuse of the pre-save PID", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-tracker-pid-reuse-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const prePath = join(directory, "pre.db");
  const postPath = join(directory, "post.db");
  const preDb = await createDatabase(prePath, false); preDb.close();
  const postDb = await createDatabase(postPath, true); postDb.close();
  const report = reportFor(
    trackedRoot(directory),
    "android",
    snapshotTrackerDatabase(prePath),
    snapshotTrackerDatabase(postPath),
  );
  report.lifecycle.directLaunches.preSave.pid = report.lifecycle.directLaunches.save.pid;

  assert.equal(validateTrackerReport(report, "android", SHA, join(directory, "evidence-root")), report);
});

test("privacy and migration identities are derived from tracked bytes and exact migration SQL", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-tracker-identities-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = trackedRoot(directory);
  const zero = { modelConfig: 0, modelCapabilities: 0 };
  const privacy = collectTrackerPrivacyProof({ preSave: zero, postSave: zero, postRelaunch: zero }, root);
  assert.deepEqual(privacy.sourceScan.roots, ["App*", "index*", "src/**", "app.config.*"]);
  assert.equal(privacy.sourceScan.trackedFileCount, 4);
  assert.equal(privacy.sourceScan.requestPrimitiveMatchCount, 0);
  assert.deepEqual(privacy.claims, {
    structuralProductRequestAbsence: true,
    packetSilence: false,
    dependencySilence: false,
    osSilence: false,
    physicalDevice: false,
    airplaneMode: false,
  });
  assert.match(privacy.limitation, /^Structural process, source, and database facts only;/);

  const migration = migrationIdentity(root);
  assert.deepEqual(migration.inventory, { tables: 26, indexes: 14, triggers: 3 });
  assert.equal(migration.recordedSha256, "f7dfa123b82ca6bb8f6ef6220c31f1d80fc987ea6435609d0e649367fc669cec");
  assert.equal(migration.sourceSha256, "c45896b3eb02762c0cf8f62c584889951a15fadc13fd34b9183bfa717ec75975");
  assert.equal(migration.sqlByteCount, 10526);
  assert.deepEqual(migration.applied, [{
    version: 1, name: "initial-schema",
    sha256: "f7dfa123b82ca6bb8f6ef6220c31f1d80fc987ea6435609d0e649367fc669cec",
  }]);
});

test("privacy manifest sorts tracked paths by UTF-8 bytes", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-tracker-privacy-order-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = trackedRoot(directory);
  const supplementaryPath = `src/${String.fromCodePoint(0x10000)}.ts`;
  const privateUsePath = `src/${String.fromCodePoint(0xe000)}.ts`;
  for (const [path, contents] of [[supplementaryPath, "supplementary\n"], [privateUsePath, "private-use\n"]]) {
    writeFileSync(join(root, path), contents);
  }
  git(root, "add", ".");

  const zero = { modelConfig: 0, modelCapabilities: 0 };
  const actual = collectTrackerPrivacyProof({ preSave: zero, postSave: zero, postRelaunch: zero }, root).sourceScan;
  const listed = spawnSync("git", ["ls-files", "-z", "App*", "index*", "src/**", "app.config.*"], {
    cwd: root,
    encoding: "buffer",
  });
  assert.equal(listed.status, 0, listed.stderr.toString("utf8"));
  const paths = listed.stdout.toString("utf8").split("\0").filter(Boolean)
    .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const digest = createHash("sha256");
  for (const path of paths) digest.update(path).update("\0").update(readFileSync(join(root, path))).update("\0");

  assert.equal(actual.trackedFileManifestSha256, digest.digest("hex"));
});

test("CLI actions write only exact canonical JSON bytes", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-tracker-cli-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const database = join(directory, "user.db");
  const db = await createDatabase(database, true); db.close();
  const fixtureOutput = join(directory, "fixture.json");
  const snapshotOutput = join(directory, "snapshot.json");

  for (const args of [
    ["--action", "fixture-oracle", "--time-zone", "Asia/Shanghai", "--output", fixtureOutput],
    ["--action", "tracker-snapshot", "--database", database, "--output", snapshotOutput],
  ]) {
    const result = spawnSync(process.execPath, ["--no-warnings", TOOL_PATH, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }
  for (const path of [fixtureOutput, snapshotOutput]) {
    const bytes = readFileSync(path);
    assert.equal(bytes.toString("utf8"), canonicalJson(JSON.parse(bytes.toString("utf8"))));
    assert.equal(bytes.at(-1), "}".charCodeAt(0));
  }
});
