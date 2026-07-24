import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import test from "node:test";

import { applyUserDatabaseMigrations, USER_DATABASE_MIGRATIONS } from "../../../src/infrastructure/db/migrations/index.ts";

function parameters(values: readonly unknown[]): SQLInputValue[] {
  return values as SQLInputValue[];
}

function tool(...args: string[]) {
  const result = runTool(...args);
  assert.equal(result.status, 0, result.stderr);
}

function runTool(...args: string[]) {
  return spawnSync(process.execPath, [resolve("tools/persistence-evidence.mjs"), ...args], {
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
  });
}

function checkedOutSha() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function createCanonicalPersistenceDatabase(path: string) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  const adapter = {
    async execAsync(sql: string) { db.exec(sql); },
    async getAllAsync<T>(sql: string, ...values: unknown[]) { return db.prepare(sql).all(...parameters(values)) as T[]; },
    async runAsync(sql: string, ...values: unknown[]) { return db.prepare(sql).run(...parameters(values)); },
  };
  await applyUserDatabaseMigrations(adapter);
  db.exec(`BEGIN IMMEDIATE;
    INSERT INTO app_meta(key,value_json,updated_at)
      VALUES ('e2e.persistence.sentinel','"preserved"','2026-01-01T00:00:00.000Z');
    INSERT INTO conversations(id,started_at,created_at,updated_at)
      VALUES ('e2e-c','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO chat_turns(id,conversation_id,idempotency_key,status,error_code,requested_at,completed_at,updated_at)
      VALUES ('e2e-t','e2e-c','e2e-k','failed','startup_interrupted','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO pending_agent_tasks(id,conversation_id,source_turn_id,task_type,status,risk_level,payload_json,missing_slots_json,expires_at,created_at,updated_at)
      VALUES ('e2e-p','e2e-c','e2e-t','tracker_create','expired','low','{}','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    INSERT INTO local_jobs(id,kind,dedupe_key,effect_key,status,payload_json,attempt_count,created_at,updated_at)
      VALUES ('e2e-j','memory','e2e-d','e2e-e','queued','{}',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
    COMMIT;
    PRAGMA wal_checkpoint(TRUNCATE);`);
  db.close();
}

const destinationReadbackTopLevelKeys = [
  "canonicalizationVersion",
  "checkedOutSha",
  "comparison",
  "destination",
  "expectedSha",
  "platform",
  "reportType",
  "scenario",
  "schemaVersion",
  "source",
  "status",
];

const destinationReadbackComparisonKeys = [
  "checkedOutShaMatchesExpected",
  "destinationCheckpointComplete",
  "destinationJournalModeIsWal",
  "destinationMigrationIdentityMatchesFrozen",
  "destinationQuickCheckOk",
  "destinationScenarioFactsMatchExpected",
  "destinationSchemaFingerprintMatchesFrozen",
  "journalModeEqual",
  "migrationIdentityEqual",
  "scenarioFactsEqual",
  "schemaFingerprintEqual",
  "sourceJournalModeIsWal",
  "sourceMigrationIdentityMatchesFrozen",
  "sourceQuickCheckOk",
  "sourceScenarioFactsMatchExpected",
  "sourceSchemaFingerprintMatchesFrozen",
];
const destinationReadbackSchemaSha256 = "6b0f47330ed82306a6f601f4ad87a865c692fb0356ede4cda38a610a4d14b8e4";
const destinationReadbackScenarioFactsSha256 = {
  failedMigrationRollback: "39f5f28a075964639cfa7abf71ddf2958724d4f4f5fa85c76934f1993e31f5b6",
  migrationHashRetry: "e9bf9b994677ff8f236778ac6646e9c23dbc913b4d293a772f2aee2dcc11874c",
} as const;
const passingDestinationReadbackComparison = Object.fromEntries(
  destinationReadbackComparisonKeys.map((key) => [key, true]),
);

function destinationReadbackComparisonWithFalse(...keys: string[]) {
  return { ...passingDestinationReadbackComparison, ...Object.fromEntries(keys.map((key) => [key, false])) };
}

function assertExactDestinationReadbackSchema(report: Record<string, any>) {
  assert.deepEqual(Object.keys(report).sort(), destinationReadbackTopLevelKeys);
  assert.deepEqual(Object.keys(report.source).sort(), [
    "journalMode", "migration", "origin", "quickCheck", "scenarioFactsSha256", "schemaFingerprintSha256",
  ]);
  assert.deepEqual(Object.keys(report.destination).sort(), [
    "checkpoint", "journalMode", "migration", "origin", "quickCheck", "scenarioFactsSha256", "schemaFingerprintSha256",
  ]);
  assert.deepEqual(Object.keys(report.destination.checkpoint).sort(), ["busy", "checkpointedFrames", "logFrames"]);
  assert.deepEqual(Object.keys(report.comparison).sort(), destinationReadbackComparisonKeys);
}

function destinationReadbackArguments(input: {
  source: string;
  destination: string;
  output: string;
  checkpoint?: string;
  checkpointStatus?: string;
  expectedSha?: string;
  extra?: string[];
  omitCheckpointStatus?: boolean;
  scenario?: keyof typeof destinationReadbackScenarioFactsSha256;
}) {
  const args = [
    "--action", "destination-readback",
    "--platform", "ios",
    "--scenario", input.scenario ?? "migrationHashRetry",
    "--expected-sha", input.expectedSha ?? checkedOutSha(),
    "--source", input.source,
    "--destination", input.destination,
  ];
  if (!input.omitCheckpointStatus) args.push("--destination-checkpoint-status", input.checkpointStatus ?? "0");
  if (input.checkpoint !== undefined) args.push("--destination-checkpoint", input.checkpoint);
  args.push("--output", input.output, ...(input.extra ?? []));
  return args;
}

function assertSanitizedDestinationReadback(report: Record<string, any>, privateDirectory: string) {
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, new RegExp(privateDirectory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(serialized, /CREATE\s+(?:TABLE|INDEX|TRIGGER)|SELECT\s|PRAGMA\s|\.db(?:-wal|-shm)?/i);
  assert.doesNotMatch(serialized, /databaseSha256|objectTypes|path|sql|rows|message|stack|errorCode|rawCode/i);
}

test("persistence evidence tool checkpoints WAL and keeps exact frozen identities", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-persistence-evidence-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "user.db");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  const adapter = {
    async execAsync(sql: string) { db.exec(sql); },
    async getAllAsync<T>(sql: string, ...values: unknown[]) { return db.prepare(sql).all(...parameters(values)) as T[]; },
    async runAsync(sql: string, ...values: unknown[]) { return db.prepare(sql).run(...parameters(values)); },
  };
  await applyUserDatabaseMigrations(adapter);
  db.close();

  const first = join(directory, "first.json");
  tool("--action", "snapshot", "--database", path, "--output", first);
  const snapshot = JSON.parse(readFileSync(first, "utf8"));
  assert.deepEqual(snapshot.migration, [{ version: 1, name: "initial-schema", sha256: USER_DATABASE_MIGRATIONS[0]!.sha256 }]);
  assert.deepEqual(snapshot.objectTypes, [{ type: "index", total: 14 }, { type: "table", total: 26 }, { type: "trigger", total: 3 }]);

  tool("--action", "corrupt-hash", "--database", path);
  let inspect = new DatabaseSync(path);
  assert.equal(inspect.prepare("SELECT sha256 FROM schema_migrations WHERE version=1").get()?.sha256, "0".repeat(64));
  inspect.close();
  tool("--action", "repair-hash", "--database", path);
  inspect = new DatabaseSync(path);
  assert.equal(inspect.prepare("SELECT sha256 FROM schema_migrations WHERE version=1").get()?.sha256, USER_DATABASE_MIGRATIONS[0]!.sha256);
  inspect.close();

  const poisonPath = join(directory, "poison.db");
  const poisonReport = join(directory, "poison.json");
  tool("--action", "create-poison", "--database", poisonPath);
  tool("--action", "poison-snapshot", "--database", poisonPath, "--output", poisonReport);
  const poison = JSON.parse(readFileSync(poisonReport, "utf8"));
  assert.deepEqual(poison.objects, ["chat_turns", "committed_job_effects", "local_jobs", "messages", "pending_agent_tasks", "photos"]
    .map((name) => ({ type: "table", name })));
  assert.deepEqual(Object.fromEntries(Object.entries(poison.columns).map(([table, columns]: [string, any]) => [table, columns.map((column: any) => column.name)])), {
    chat_turns: ["id", "conversation_id", "status", "error_code", "completed_at", "updated_at"],
    committed_job_effects: ["effect_key"],
    local_jobs: ["id", "effect_key", "status", "lease_owner", "lease_expires_at", "next_attempt_at", "last_error_code", "updated_at"],
    messages: ["id", "conversation_id", "turn_id", "role"],
    pending_agent_tasks: ["id", "status", "expires_at", "updated_at"],
    photos: ["id", "import_state"],
  });
  assert.deepEqual(poison.rows.chat_turns.map(({ status }: any) => status), ["completed"]);
  assert.deepEqual(poison.rows.messages.map(({ role }: any) => role), ["user"]);
  assert.deepEqual(poison.rows.pending_agent_tasks.map(({ status }: any) => status), ["completed"]);
  assert.deepEqual(poison.rows.local_jobs.map(({ status, effect_key }: any) => ({ status, effect_key })), [{ status: "queued", effect_key: "poison-effect" }]);
  assert.deepEqual(poison.rows.committed_job_effects, [{ effect_key: "poison-effect" }]);
  assert.deepEqual(poison.rows.photos, [{ id: "poison-photo", import_state: "committed" }]);
  assert.deepEqual(poison.foreignKeyViolations, []);
  assert.equal(poison.journalMode, "wal");

  const recovered = {
    ...snapshot,
    meta: { value_json: '"preserved"' },
    jobs: [{ id: "e2e-j", status: "queued", lease_owner: null, lease_expires_at: null }],
    turns: [{ id: "e2e-t", status: "failed", error_code: "startup_interrupted" }],
    tasks: [{ id: "e2e-p", status: "expired" }],
  };
  const recoveredPath = join(directory, "recovered.json");
  const reportPath = join(directory, "report.json");
  writeFileSync(recoveredPath, JSON.stringify(recovered));
  tool(
    "--action", "report", "--platform", "android", "--expected-sha", "a".repeat(40),
    "--first", first, "--recovered", recoveredPath, "--recovered-noop", recoveredPath, "--retried", recoveredPath,
    "--poison-before", poisonReport, "--poison-after", poisonReport, "--output", reportPath,
  );
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(report.schemaVersion, 2);
  assert.deepEqual(report.scenarios.failedMigrationRollback, {
    status: "pass", collisionObject: "chat_turns", beforeSnapshot: poison, afterSnapshot: poison,
  });
});

test("destination readback emits the exact privacy-safe schema from distinct read-only databases", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-destination-readback-pass-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "prepared-source.db");
  const destination = join(directory, "live-destination.db");
  const output = join(directory, "readback.json");
  await createCanonicalPersistenceDatabase(source);
  copyFileSync(source, destination);

  const result = runTool(...destinationReadbackArguments({
    source,
    destination,
    output,
    checkpoint: "0|0|0",
  }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");

  const report = JSON.parse(readFileSync(output, "utf8"));
  assertExactDestinationReadbackSchema(report);
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.reportType, "destination-database-readback");
  assert.equal(report.platform, "ios");
  assert.equal(report.scenario, "migrationHashRetry");
  assert.equal(report.canonicalizationVersion, 1);
  assert.equal(report.checkedOutSha, checkedOutSha());
  assert.equal(report.expectedSha, checkedOutSha());
  assert.equal(report.source.origin, "prepared-host-source");
  assert.equal(report.destination.origin, "device-readback");
  assert.deepEqual(report.destination.checkpoint, { busy: 0, logFrames: 0, checkpointedFrames: 0 });
  assert.equal(report.source.quickCheck, "ok");
  assert.equal(report.destination.quickCheck, "ok");
  assert.deepEqual(report.source.migration, [{
    version: 1,
    name: "initial-schema",
    sha256: USER_DATABASE_MIGRATIONS[0]!.sha256,
  }]);
  assert.deepEqual(report.destination.migration, report.source.migration);
  assert.equal(report.source.journalMode, "wal");
  assert.equal(report.destination.journalMode, "wal");
  assert.equal(report.source.schemaFingerprintSha256, destinationReadbackSchemaSha256);
  assert.equal(report.destination.schemaFingerprintSha256, destinationReadbackSchemaSha256);
  assert.equal(report.source.scenarioFactsSha256, destinationReadbackScenarioFactsSha256.migrationHashRetry);
  assert.equal(report.destination.scenarioFactsSha256, destinationReadbackScenarioFactsSha256.migrationHashRetry);
  assert.deepEqual(report.comparison, passingDestinationReadbackComparison);
  assert.equal(report.status, "pass");
  assertSanitizedDestinationReadback(report, directory);
});

test("destination readback directly validates failedMigrationRollback with exact hashes", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-destination-readback-rollback-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "prepared-source.db");
  const destination = join(directory, "live-destination.db");
  const output = join(directory, "failedMigrationRollback.json");
  await createCanonicalPersistenceDatabase(source);
  copyFileSync(source, destination);

  const result = runTool(...destinationReadbackArguments({
    source,
    destination,
    output,
    checkpoint: "0|0|0",
    scenario: "failedMigrationRollback",
  }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");

  const report = JSON.parse(readFileSync(output, "utf8"));
  assertExactDestinationReadbackSchema(report);
  assert.equal(report.scenario, "failedMigrationRollback");
  assert.equal(report.source.schemaFingerprintSha256, destinationReadbackSchemaSha256);
  assert.equal(report.destination.schemaFingerprintSha256, destinationReadbackSchemaSha256);
  assert.equal(report.source.scenarioFactsSha256, destinationReadbackScenarioFactsSha256.failedMigrationRollback);
  assert.equal(report.destination.scenarioFactsSha256, destinationReadbackScenarioFactsSha256.failedMigrationRollback);
  assert.deepEqual(report.comparison, passingDestinationReadbackComparison);
  assert.equal(report.status, "pass");
  assertSanitizedDestinationReadback(report, directory);
});

test("destination readback writes sanitized failure JSON before rejecting hostile proof", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-destination-readback-fail-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const canonical = join(directory, "canonical.db");
  await createCanonicalPersistenceDatabase(canonical);
  let sequence = 0;

  const failures: {
    label: string;
    checkpoint?: string;
    checkpointStatus?: string;
    expectedSha?: string;
    expectedStatus?: number;
    extra?: string[];
    omitCheckpoint?: boolean;
    omitCheckpointStatus?: boolean;
    samePath?: boolean;
    sameInode?: boolean;
    mutateSource?: (path: string) => void;
    mutateDestination?: (path: string) => void;
  }[] = [
    { label: "wrong source", mutateSource: (path) => {
      const db = new DatabaseSync(path);
      db.prepare("UPDATE schema_migrations SET sha256 = ? WHERE version = 1").run("0".repeat(64));
      db.close();
    } },
    { label: "wrong destination migration", mutateDestination: (path) => {
      const db = new DatabaseSync(path);
      db.prepare("UPDATE schema_migrations SET sha256 = ? WHERE version = 1").run("0".repeat(64));
      db.close();
    } },
    { label: "malformed checkpoint", checkpoint: "0|0" },
    { label: "busy checkpoint", checkpoint: "1|4|3" },
    { label: "partial checkpoint", checkpoint: "0|4|3" },
    { label: "checkpoint command failure", checkpoint: "", checkpointStatus: "73", expectedStatus: 73 },
    { label: "checkpoint failure with tuple", checkpoint: "0|0|0", checkpointStatus: "73", expectedStatus: 73 },
    { label: "malformed checkpoint status", checkpointStatus: "256" },
    { label: "failed quick check", mutateDestination: (path) => {
      const db = new DatabaseSync(path);
      db.exec("PRAGMA writable_schema = ON");
      const tableRoot = db.prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'growth_records'").get()?.rootpage;
      assert.equal(typeof tableRoot, "number");
      db.prepare("UPDATE sqlite_schema SET rootpage = ? WHERE name = 'idx_growth_records_date'").run(tableRoot as number);
      db.close();
    } },
    { label: "non-WAL destination", mutateDestination: (path) => {
      const db = new DatabaseSync(path);
      assert.equal(db.prepare("PRAGMA journal_mode = DELETE").get()?.journal_mode, "delete");
      db.close();
    } },
    { label: "schema mismatch", mutateDestination: (path) => {
      const db = new DatabaseSync(path);
      db.exec("CREATE TABLE hostile_extra(value TEXT)");
      db.close();
    } },
    { label: "scenario facts mismatch", mutateDestination: (path) => {
      const db = new DatabaseSync(path);
      db.prepare("UPDATE app_meta SET value_json = ? WHERE key = 'e2e.persistence.sentinel'").run('"altered"');
      db.close();
    } },
    { label: "SHA mismatch", expectedSha: "b".repeat(40) },
    { label: "unknown field", extra: ["--unexpected-proof", "present"] },
    { label: "missing proof", omitCheckpoint: true },
    { label: "missing checkpoint status", omitCheckpointStatus: true },
    { label: "source substitution", samePath: true },
    { label: "same-inode substitution", sameInode: true },
  ];

  for (const hostile of failures) {
    sequence += 1;
    const source = join(directory, `${sequence}-source.db`);
    const destination = join(directory, `${sequence}-destination.db`);
    const output = join(directory, `${sequence}-failure.json`);
    copyFileSync(canonical, source);
    if (hostile.sameInode) linkSync(source, destination);
    else copyFileSync(canonical, destination);
    hostile.mutateSource?.(source);
    hostile.mutateDestination?.(destination);

    const result = runTool(...destinationReadbackArguments({
      source,
      destination: hostile.samePath ? source : destination,
      output,
      checkpoint: hostile.omitCheckpoint ? undefined : hostile.checkpoint ?? "0|0|0",
      checkpointStatus: hostile.checkpointStatus,
      expectedSha: hostile.expectedSha,
      extra: hostile.extra,
      omitCheckpointStatus: hostile.omitCheckpointStatus,
    }));
    if (hostile.expectedStatus === undefined) assert.notEqual(result.status, 0, `${hostile.label} must fail closed`);
    else assert.equal(result.status, hostile.expectedStatus, `${hostile.label} must preserve the checkpoint exit status`);
    assert.equal(result.stdout, "", `${hostile.label} must not log proof details`);
    assert.equal(result.stderr, "", `${hostile.label} must not log errors, paths, messages, or stacks`);
    const report = JSON.parse(readFileSync(output, "utf8"));
    assertExactDestinationReadbackSchema(report);
    assert.equal(report.schemaVersion, 1, hostile.label);
    assert.equal(report.reportType, "destination-database-readback", hostile.label);
    assert.equal(report.platform, "ios", hostile.label);
    assert.equal(report.scenario, "migrationHashRetry", hostile.label);
    assert.equal(report.canonicalizationVersion, 1, hostile.label);
    assert.equal(report.checkedOutSha, checkedOutSha(), hostile.label);
    assert.equal(report.expectedSha, hostile.expectedSha ?? checkedOutSha(), hostile.label);
    assert.equal(report.status, "fail", hostile.label);
    assert.ok(Object.values(report.comparison).some((value) => value === false), hostile.label);
    if (hostile.checkpointStatus !== undefined && hostile.checkpointStatus !== "0") {
      assert.deepEqual(report.destination.checkpoint, { busy: null, logFrames: null, checkpointedFrames: null }, hostile.label);
    }
    assertSanitizedDestinationReadback(report, directory);
  }
});

test("destination readback reports exact directional comparisons and partial checkpoint failure", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-destination-readback-directional-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const canonical = join(directory, "canonical.db");
  await createCanonicalPersistenceDatabase(canonical);
  const makeMigrationNoncanonical = (path: string) => {
    const db = new DatabaseSync(path);
    db.prepare("UPDATE schema_migrations SET sha256 = ? WHERE version = 1").run("0".repeat(64));
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    db.close();
  };
  const cases = [
    {
      label: "source only",
      mutateSource: true,
      mutateDestination: false,
      checkpoint: "0|0|0",
      comparison: destinationReadbackComparisonWithFalse(
        "migrationIdentityEqual",
        "sourceMigrationIdentityMatchesFrozen",
      ),
    },
    {
      label: "destination only",
      mutateSource: false,
      mutateDestination: true,
      checkpoint: "0|0|0",
      comparison: destinationReadbackComparisonWithFalse(
        "destinationMigrationIdentityMatchesFrozen",
        "migrationIdentityEqual",
      ),
    },
    {
      label: "identically noncanonical source and destination",
      mutateSource: true,
      mutateDestination: true,
      checkpoint: "0|0|0",
      comparison: destinationReadbackComparisonWithFalse(
        "destinationMigrationIdentityMatchesFrozen",
        "sourceMigrationIdentityMatchesFrozen",
      ),
    },
    {
      label: "partial checkpoint",
      mutateSource: false,
      mutateDestination: false,
      checkpoint: "0|4|3",
      comparison: destinationReadbackComparisonWithFalse("destinationCheckpointComplete"),
    },
  ] as const;

  for (const [index, proof] of cases.entries()) {
    const source = join(directory, `${index}-source.db`);
    const destination = join(directory, `${index}-destination.db`);
    const output = join(directory, `${index}-readback.json`);
    copyFileSync(canonical, source);
    copyFileSync(canonical, destination);
    if (proof.mutateSource) makeMigrationNoncanonical(source);
    if (proof.mutateDestination) makeMigrationNoncanonical(destination);

    const result = runTool(...destinationReadbackArguments({
      source,
      destination,
      output,
      checkpoint: proof.checkpoint,
    }));
    assert.equal(result.status, 1, proof.label);
    assert.equal(result.stdout, "", proof.label);
    assert.equal(result.stderr, "", proof.label);
    const report = JSON.parse(readFileSync(output, "utf8"));
    assertExactDestinationReadbackSchema(report);
    assert.deepEqual(report.comparison, proof.comparison, proof.label);
    assert.equal(report.source.schemaFingerprintSha256, destinationReadbackSchemaSha256, proof.label);
    assert.equal(report.destination.schemaFingerprintSha256, destinationReadbackSchemaSha256, proof.label);
    assert.equal(report.source.scenarioFactsSha256, destinationReadbackScenarioFactsSha256.migrationHashRetry, proof.label);
    assert.equal(report.destination.scenarioFactsSha256, destinationReadbackScenarioFactsSha256.migrationHashRetry, proof.label);
    assert.equal(report.status, "fail", proof.label);
    assertSanitizedDestinationReadback(report, directory);
  }
});

test("profile evidence snapshots the exact leap-day fixture and computes age without product imports", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "fawn-profile-evidence-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "user.db");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  const adapter = {
    async execAsync(sql: string) { db.exec(sql); },
    async getAllAsync<T>(sql: string, ...values: unknown[]) { return db.prepare(sql).all(...parameters(values)) as T[]; },
    async runAsync(sql: string, ...values: unknown[]) { return db.prepare(sql).run(...parameters(values)); },
  };
  await applyUserDatabaseMigrations(adapter);
  db.prepare(`INSERT INTO baby_profile(
    singleton_id,name,sex,birth_date,birth_weight_g,birth_height_cm,birth_head_cm,
    is_premature,gestational_weeks,created_at,updated_at
  ) VALUES (1,?,?,?,?,?,?,?,?,?,?)`).run(
    "G031LeapBaby", "female", "2024-02-29", 3200, 50.5, 34.2, 1, 36,
    "2026-07-18T01:02:03.000Z", "2026-07-18T01:02:03.000Z",
  );
  db.close();

  const snapshotPath = join(directory, "profile.json");
  tool("--action", "profile-snapshot", "--database", path, "--output", snapshotPath);
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  assert.equal(snapshot.babyProfileCount, 1);
  assert.equal(snapshot.modelConfigCount, 0);
  assert.equal(snapshot.modelCapabilitiesCount, 0);
  assert.equal(snapshot.valueSha256, "6bfb59d6996bf798923420d4ffb334430f3b1c6cd0c87988d29e353c06a7f6db");
  assert.deepEqual(snapshot.row, {
    singleton_id: 1,
    name: "G031LeapBaby",
    sex: "female",
    birth_date: "2024-02-29",
    birth_weight_g: 3200,
    birth_height_cm: 50.5,
    birth_head_cm: 34.2,
    is_premature: 1,
    gestational_weeks: 36,
    created_at: "2026-07-18T01:02:03.000Z",
    updated_at: "2026-07-18T01:02:03.000Z",
  });
  assert.match(snapshot.rowSha256, /^[0-9a-f]{64}$/);

  const agePath = join(directory, "age.json");
  tool("--action", "age-oracle", "--local-date", "2026-07-18", "--output", agePath);
  assert.deepEqual(JSON.parse(readFileSync(agePath, "utf8")), {
    algorithm: "independent-gregorian-v1",
    birthDate: "2024-02-29",
    localDate: "2026-07-18",
    ageDays: 870,
    completedMonths: 28,
    remainingDays: 19,
    display: "28个月19天",
  });
});
