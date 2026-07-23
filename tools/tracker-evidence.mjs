import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const FIXTURE_PATH = "tests/fixtures/tracker/manual-tracker-v1.json";
const FIXTURE_BYTE_SHA256 = "4960045548664bbabea2de291827b91ff9d1f2407630e16a0eb13117b92af69d";
const MIGRATION_PATH = "src/infrastructure/db/migrations/migration1.ts";
const MIGRATION_RECORDED_SHA256 = "f7dfa123b82ca6bb8f6ef6220c31f1d80fc987ea6435609d0e649367fc669cec";
const MIGRATION_SOURCE_SHA256 = "c45896b3eb02762c0cf8f62c584889951a15fadc13fd34b9183bfa717ec75975";
const DOMAIN_ORDER = Object.freeze(["growth", "feeding", "sleep", "diaper", "health"]);
const EXPECTED_MIGRATION = Object.freeze([
  Object.freeze({ version: 1, name: "initial-schema", sha256: MIGRATION_RECORDED_SHA256 }),
]);
const EMPTY_MUTATIONS = Object.freeze({ install: 0, clear: 0, seed: 0, databasePush: 0, rebuild: 0, metroRestart: 0 });
const UTC_INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_ROOTS = Object.freeze(["App*", "index*", "src/**", "app.config.*"]);
const PRIVACY_LIMITATION = "Structural process, source, and database facts only; no packet-silence, dependency, OS, runner, GitHub Actions, simulator-infrastructure, or physical-device traffic claim.";

const DOMAIN_CONFIG = Object.freeze({
  growth: Object.freeze({
    table: "growth_records",
    rowKeys: Object.freeze([
      "id", "measurement_date", "weight_g", "height_cm", "head_cm", "weight_percentile",
      "height_percentile", "head_percentile", "notes", "source_message_id", "created_at", "updated_at", "deleted_at",
    ]),
    businessKeys: Object.freeze([
      "measurement_date", "weight_g", "height_cm", "head_cm", "weight_percentile",
      "height_percentile", "head_percentile", "notes", "source_message_id", "is_deleted",
    ]),
  }),
  feeding: Object.freeze({
    table: "feeding_records",
    rowKeys: Object.freeze([
      "id", "feed_time", "feed_type", "amount_ml", "duration_min", "notes",
      "source_message_id", "created_at", "updated_at", "deleted_at",
    ]),
    businessKeys: Object.freeze([
      "feed_time", "feed_type", "amount_ml", "duration_min", "notes", "source_message_id", "is_deleted",
    ]),
  }),
  sleep: Object.freeze({
    table: "sleep_records",
    rowKeys: Object.freeze([
      "id", "sleep_start", "sleep_end", "sleep_type", "night_wakings", "notes",
      "source_message_id", "created_at", "updated_at", "deleted_at",
    ]),
    businessKeys: Object.freeze([
      "sleep_start", "sleep_end", "sleep_type", "night_wakings", "notes", "source_message_id", "is_deleted",
    ]),
  }),
  diaper: Object.freeze({
    table: "diaper_records",
    rowKeys: Object.freeze([
      "id", "diaper_time", "diaper_type", "notes", "source_message_id", "created_at", "updated_at", "deleted_at",
    ]),
    businessKeys: Object.freeze(["diaper_time", "diaper_type", "notes", "source_message_id", "is_deleted"]),
  }),
  health: Object.freeze({
    table: "health_records",
    rowKeys: Object.freeze([
      "id", "record_date", "record_type", "title", "description", "source_message_id", "created_at", "updated_at", "deleted_at",
    ]),
    businessKeys: Object.freeze([
      "record_date", "record_type", "title", "description", "source_message_id", "is_deleted",
    ]),
  }),
});

const LOCAL_INPUT_KEYS = Object.freeze({
  growth: Object.freeze(["measurementDate", "weightG", "heightCm", "headCm", "notes", "rowLabel"]),
  feeding: Object.freeze([
    "feedDate", "feedTime", "feedTypeLabel", "createAmountMl", "updatedAmountMl",
    "durationMin", "notes", "createRowLabel", "finalRowLabel",
  ]),
  sleep: Object.freeze([
    "startDate", "startTime", "endDate", "endTime", "sleepTypeLabel", "nightWakings", "notes", "rowLabel",
  ]),
  diaper: Object.freeze(["recordDate", "recordTime", "diaperTypeLabel", "notes", "rowLabel"]),
  health: Object.freeze(["recordDate", "recordTypeLabel", "title", "description", "rowLabel"]),
});

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function jsonOwnProperties(value, array) {
  const properties = [];
  for (const key of Reflect.ownKeys(value)) {
    assert.equal(typeof key, "string", "Canonical JSON rejects symbol-keyed properties");
    if (array && key === "length") continue;
    if (array) {
      const index = Number(key);
      assert(Number.isInteger(index) && index >= 0 && index < value.length && String(index) === key,
        "Canonical JSON rejects named array properties");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    assert(descriptor?.enumerable, "Canonical JSON rejects non-enumerable properties");
    assert(Object.hasOwn(descriptor, "value"), "Canonical JSON rejects accessor-backed properties");
    properties.push([key, descriptor.value]);
  }
  return properties;
}

function canonicalString(value, stack) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    assert(Number.isFinite(value), "Canonical JSON numbers must be finite");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  assert(typeof value === "object", `Canonical JSON rejects ${typeof value}`);
  assert(!stack.has(value), "Canonical JSON rejects cycles");
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      const properties = jsonOwnProperties(value, true);
      assert.equal(properties.length, value.length, "Canonical JSON rejects array holes");
      const entries = Array(value.length);
      for (const [key, entry] of properties) entries[Number(key)] = canonicalString(entry, stack);
      assert(entries.every((entry) => typeof entry === "string"), "Canonical JSON rejects array holes");
      return `[${entries.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    assert(prototype === Object.prototype || prototype === null, "Canonical JSON accepts only plain objects");
    return `{${jsonOwnProperties(value, false).sort(([left], [right]) => (
      left < right ? -1 : left > right ? 1 : 0
    )).map(([key, entry]) => (
      `${JSON.stringify(key)}:${canonicalString(entry, stack)}`
    )).join(",")}}`;
  } finally {
    stack.delete(value);
  }
}

export function canonicalJson(value) {
  return canonicalString(value, new Set());
}

export function sha256Canonical(value) {
  return sha256Bytes(Buffer.from(canonicalJson(value), "utf8"));
}

function exactKeys(value, keys, label) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} is malformed`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} keys are invalid`);
}

function allStrings(value, label) {
  for (const [key, entry] of Object.entries(value)) assert.equal(typeof entry, "string", `${label}.${key} must be text`);
}

function assertBoolean(value, label) {
  assert.equal(typeof value, "boolean", `${label} must be boolean`);
}

function assertTrue(value, label) {
  assert.equal(value, true, `${label} must be true`);
}

function assertFalse(value, label) {
  assert.equal(value, false, `${label} must be false`);
}

function nonnegativeInteger(value, label) {
  assert(Number.isSafeInteger(value) && value >= 0, `${label} must be a nonnegative integer`);
}

function positiveSafeInteger(value, label) {
  assert(Number.isSafeInteger(value) && value > 0, `${label} must be a positive safe integer`);
}

function assertSha(value, label) {
  assert.equal(typeof value, "string", `${label} must be text`);
  assert.match(value, SHA256, `${label} must be lowercase SHA-256`);
}

function validIanaZone(zone) {
  assert.equal(typeof zone, "string", "Tracker time zone must be text");
  assert(zone.length > 0, "Tracker time zone cannot be empty");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(0);
  } catch {
    assert.fail("Tracker time zone is invalid");
  }
}

function localMinute(instant, zone) {
  assert.match(instant, UTC_INSTANT, "Fixture instant is not canonical UTC");
  const parsed = new Date(instant);
  assert.equal(parsed.toISOString(), instant, "Fixture instant is invalid");
  const formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory-nu-latn", {
    timeZone: zone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = new Map(formatter.formatToParts(parsed).map((part) => [part.type, part.value]));
  const values = ["year", "month", "day", "hour", "minute", "second"].map((name) => parts.get(name));
  assert(values.every((value) => typeof value === "string" && /^[0-9]+$/.test(value)), "Fixture local time is not representable");
  assert.equal(values[5], "00", "Fixture instant must resolve to an exact local minute");
  return {
    date: `${values[0]}-${values[1]}-${values[2]}`,
    time: `${values[3]}:${values[4]}`,
    display: `${values[0]}年${Number(values[1])}月${Number(values[2])}日 ${values[3]}:${values[4]}（本机时间）`,
  };
}

function fixtureObject(root) {
  const bytes = readFileSync(resolve(root, FIXTURE_PATH));
  assert.equal(sha256Bytes(bytes), FIXTURE_BYTE_SHA256, "Tracker fixture byte identity is invalid");
  const fixture = JSON.parse(bytes.toString("utf8"));
  exactKeys(fixture, ["timeZone", "sourceMessageId", "createdAt", "updatedAt", "deletedAt", "domains"], "Tracker fixture");
  exactKeys(fixture.domains, DOMAIN_ORDER, "Tracker fixture domains");
  for (const domain of DOMAIN_ORDER) exactKeys(fixture.domains[domain], ["id", "create", "update"], `${domain} fixture`);
  return { bytes, fixture };
}

function manualBusinessFacts(fixture) {
  const growth = fixture.domains.growth.create;
  const feeding = fixture.domains.feeding.create;
  const sleep = fixture.domains.sleep.create;
  const diaper = fixture.domains.diaper.create;
  const health = fixture.domains.health.create;
  return {
    growth: [{
      measurement_date: growth.measurementDate,
      weight_g: growth.weightG,
      height_cm: growth.heightCm,
      head_cm: growth.headCm,
      weight_percentile: null,
      height_percentile: null,
      head_percentile: null,
      notes: growth.notes,
      source_message_id: null,
      is_deleted: false,
    }],
    feeding: [{
      feed_time: feeding.feedTime,
      feed_type: feeding.feedType,
      amount_ml: fixture.domains.feeding.update.amountMl,
      duration_min: feeding.durationMin,
      notes: feeding.notes,
      source_message_id: null,
      is_deleted: false,
    }],
    sleep: [{
      sleep_start: sleep.sleepStart,
      sleep_end: sleep.sleepEnd,
      sleep_type: sleep.sleepType,
      night_wakings: sleep.nightWakings,
      notes: sleep.notes,
      source_message_id: null,
      is_deleted: false,
    }],
    diaper: [{
      diaper_time: diaper.diaperTime,
      diaper_type: diaper.diaperType,
      notes: diaper.notes,
      source_message_id: null,
      is_deleted: true,
    }],
    health: [{
      record_date: health.recordDate,
      record_type: health.recordType,
      title: health.title.trim(),
      description: health.description,
      source_message_id: null,
      is_deleted: false,
    }],
  };
}

function localInputs(fixture, zone) {
  const growth = fixture.domains.growth.create;
  const feeding = fixture.domains.feeding.create;
  const feedingTime = localMinute(feeding.feedTime, zone);
  const sleep = fixture.domains.sleep.create;
  const sleepStart = localMinute(sleep.sleepStart, zone);
  const sleepEnd = localMinute(sleep.sleepEnd, zone);
  const diaper = fixture.domains.diaper.create;
  const diaperTime = localMinute(diaper.diaperTime, zone);
  const health = fixture.domains.health.create;
  const title = health.title.trim();
  const growthSummary = `${growth.measurementDate.slice(0, 4)}年${Number(growth.measurementDate.slice(5, 7))}月${Number(growth.measurementDate.slice(8, 10))}日，体重 ${growth.weightG} 克 · 身长 ${growth.heightCm} 厘米 · 头围 ${growth.headCm} 厘米 · 有备注`;
  const feedingSummary = (amount) => `${feedingTime.display}，配方奶 · 量 ${amount} 毫升 · 有备注`;
  return {
    growth: {
      measurementDate: growth.measurementDate,
      weightG: String(growth.weightG),
      heightCm: String(growth.heightCm),
      headCm: String(growth.headCm),
      notes: growth.notes,
      rowLabel: `生长记录，${growthSummary}`,
    },
    feeding: {
      feedDate: feedingTime.date,
      feedTime: feedingTime.time,
      feedTypeLabel: "配方奶",
      createAmountMl: String(feeding.amountMl),
      updatedAmountMl: String(fixture.domains.feeding.update.amountMl),
      durationMin: "",
      notes: feeding.notes,
      createRowLabel: `喂养记录，${feedingSummary(feeding.amountMl)}`,
      finalRowLabel: `喂养记录，${feedingSummary(fixture.domains.feeding.update.amountMl)}`,
    },
    sleep: {
      startDate: sleepStart.date,
      startTime: sleepStart.time,
      endDate: sleepEnd.date,
      endTime: sleepEnd.time,
      sleepTypeLabel: "夜间睡眠",
      nightWakings: String(sleep.nightWakings),
      notes: sleep.notes,
      rowLabel: `睡眠记录，${sleepStart.display}，夜间睡眠 · 至 ${sleepEnd.display} · 夜醒 ${sleep.nightWakings} 次 · 有备注`,
    },
    diaper: {
      recordDate: diaperTime.date,
      recordTime: diaperTime.time,
      diaperTypeLabel: "混合",
      notes: diaper.notes,
      rowLabel: `大小便记录，${diaperTime.display}，混合 · 有备注`,
    },
    health: {
      recordDate: health.recordDate,
      recordTypeLabel: "常规检查",
      title,
      description: health.description,
      rowLabel: `健康记录，${health.recordDate.slice(0, 4)}年${Number(health.recordDate.slice(5, 7))}月${Number(health.recordDate.slice(8, 10))}日，常规检查 · ${title} · 有说明`,
    },
  };
}

export function deriveTrackerFixture(timeZone, root = repoRoot) {
  validIanaZone(timeZone);
  const { bytes, fixture } = fixtureObject(root);
  assert.equal(fixture.timeZone, "Asia/Shanghai", "Checked-in tracker fixture must use Asia/Shanghai");
  assert.equal(timeZone, fixture.timeZone, "Observed tracker time zone must equal Asia/Shanghai");
  const canonicalBusinessFacts = manualBusinessFacts(fixture);
  return {
    path: FIXTURE_PATH,
    byteSha256: sha256Bytes(bytes),
    semanticSha256: sha256Canonical(fixture),
    manualProjectionSha256: sha256Canonical(canonicalBusinessFacts),
    timeZone,
    localInputs: localInputs(fixture, timeZone),
    canonicalBusinessFacts,
  };
}

function migrationSource(root) {
  const bytes = readFileSync(resolve(root, MIGRATION_PATH));
  const text = bytes.toString("utf8");
  const recorded = /export const MIGRATION_1_SHA256 = "([0-9a-f]{64})";/.exec(text)?.[1];
  assert.equal(recorded, MIGRATION_RECORDED_SHA256, "Migration recorded SHA is invalid");
  assert.equal(sha256Bytes(bytes), MIGRATION_SOURCE_SHA256, "Migration source identity is invalid");
  const prefix = "export const MIGRATION_1_SQL = String.raw`";
  const start = text.indexOf(prefix);
  const end = text.indexOf("`;\n\nexport const MIGRATION_1_SHA256", start + prefix.length);
  assert(start >= 0 && end > start, "Migration SQL source is malformed");
  return { bytes, sql: text.slice(start + prefix.length, end), recorded };
}

export function migrationIdentity(root = repoRoot) {
  const { bytes, sql, recorded } = migrationSource(root);
  assert.equal(sha256Bytes(Buffer.from(sql)), recorded, "Migration SQL bytes disagree with the frozen SHA");
  const db = new DatabaseSync(":memory:");
  let counts;
  try {
    db.exec(sql);
    counts = Object.fromEntries(db.prepare(
      "SELECT type,count(*) AS total FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' GROUP BY type ORDER BY type",
    ).all().map(({ type, total }) => [type, Number(total)]));
  } finally {
    db.close();
  }
  const inventory = { tables: counts.table ?? 0, indexes: counts.index ?? 0, triggers: counts.trigger ?? 0 };
  assert.deepEqual(inventory, { tables: 26, indexes: 14, triggers: 3 }, "Migration inventory is invalid");
  return {
    path: MIGRATION_PATH,
    recordedSha256: recorded,
    sourceSha256: sha256Bytes(bytes),
    sqlByteCount: Buffer.byteLength(sql),
    inventory,
    applied: EXPECTED_MIGRATION.map((entry) => ({ ...entry })),
  };
}

function projectBusinessFacts(rows) {
  return Object.fromEntries(DOMAIN_ORDER.map((domain) => {
    const keys = DOMAIN_CONFIG[domain].businessKeys;
    const projected = rows[domain].map((row) => Object.fromEntries(keys.map((key) => (
      [key, key === "is_deleted" ? row.deleted_at !== null : row[key]]
    ))));
    projected.sort((left, right) => {
      const leftBytes = canonicalJson(left);
      const rightBytes = canonicalJson(right);
      return leftBytes < rightBytes ? -1 : leftBytes > rightBytes ? 1 : 0;
    });
    return [domain, projected];
  }));
}

function snapshotCounts(rows) {
  const byDomain = Object.fromEntries(DOMAIN_ORDER.map((domain) => {
    const total = rows[domain].length;
    const tombstoned = rows[domain].filter((row) => row.deleted_at !== null).length;
    return [domain, { total, active: total - tombstoned, tombstoned }];
  }));
  const total = Object.values(byDomain).reduce((sum, value) => sum + value.total, 0);
  const active = Object.values(byDomain).reduce((sum, value) => sum + value.active, 0);
  const tombstoned = Object.values(byDomain).reduce((sum, value) => sum + value.tombstoned, 0);
  return { total, active, tombstoned, byDomain };
}

export function snapshotTrackerDatabase(path) {
  const db = new DatabaseSync(path);
  try {
    const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    assert.equal(Number(checkpoint?.busy ?? 0), 0, "Local tracker WAL checkpoint was busy");
    const journalMode = db.prepare("PRAGMA journal_mode").get()?.journal_mode;
    const migration = db.prepare("SELECT version,name,sha256 FROM schema_migrations ORDER BY version").all()
      .map((entry) => ({ version: Number(entry.version), name: entry.name, sha256: entry.sha256 }));
    const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all();
    const modelCounts = {
      modelConfig: Number(db.prepare("SELECT count(*) AS total FROM model_config").get().total),
      modelCapabilities: Number(db.prepare("SELECT count(*) AS total FROM model_capabilities").get().total),
    };
    const rows = Object.fromEntries(DOMAIN_ORDER.map((domain) => {
      const config = DOMAIN_CONFIG[domain];
      const selected = db.prepare(`SELECT ${config.rowKeys.join(",")} FROM ${config.table} ORDER BY id`).all();
      return [domain, selected];
    }));
    const counts = snapshotCounts(rows);
    return {
      schemaVersion: 1,
      journalMode,
      migration,
      foreignKeyViolations,
      counts,
      modelCounts,
      rows,
      businessFactsSha256: sha256Canonical(projectBusinessFacts(rows)),
      fullRowsSha256: sha256Canonical(rows),
    };
  } finally {
    db.close();
  }
}

function validateTimestamp(value, label) {
  assert.equal(typeof value, "string", `${label} must be text`);
  assert.match(value, UTC_INSTANT, `${label} must be canonical UTC`);
  assert.equal(new Date(value).toISOString(), value, `${label} is not a real UTC instant`);
}

function validateCounts(counts, rows, label) {
  exactKeys(counts, ["total", "active", "tombstoned", "byDomain"], `${label} counts`);
  exactKeys(counts.byDomain, DOMAIN_ORDER, `${label} counts.byDomain`);
  for (const key of ["total", "active", "tombstoned"]) nonnegativeInteger(counts[key], `${label} counts.${key}`);
  for (const domain of DOMAIN_ORDER) {
    exactKeys(counts.byDomain[domain], ["total", "active", "tombstoned"], `${label} ${domain} counts`);
    for (const key of ["total", "active", "tombstoned"]) {
      nonnegativeInteger(counts.byDomain[domain][key], `${label} ${domain}.${key}`);
    }
  }
  assert.deepEqual(counts, snapshotCounts(rows), `${label} counts disagree with rows`);
}

function validateRows(rows, label) {
  exactKeys(rows, DOMAIN_ORDER, `${label} rows`);
  const ids = new Set();
  for (const domain of DOMAIN_ORDER) {
    assert(Array.isArray(rows[domain]), `${label} ${domain} rows must be an array`);
    let previous = null;
    for (const row of rows[domain]) {
      exactKeys(row, DOMAIN_CONFIG[domain].rowKeys, `${label} ${domain} row`);
      assert.equal(typeof row.id, "string", `${label} ${domain} id must be text`);
      assert.match(row.id, /^tracker-.+/, `${label} ${domain} id is not a production tracker ID`);
      assert(!ids.has(row.id), `${label} tracker IDs must be unique`);
      ids.add(row.id);
      if (previous !== null) assert(previous < row.id, `${label} ${domain} rows are not sorted by id`);
      previous = row.id;
      validateTimestamp(row.created_at, `${label} ${domain}.created_at`);
      validateTimestamp(row.updated_at, `${label} ${domain}.updated_at`);
      assert(row.created_at <= row.updated_at, `${label} ${domain} revision moved backwards`);
      if (row.deleted_at !== null) validateTimestamp(row.deleted_at, `${label} ${domain}.deleted_at`);
    }
  }
}

function validateSnapshot(snapshot, label) {
  exactKeys(snapshot, [
    "schemaVersion", "journalMode", "migration", "foreignKeyViolations", "counts",
    "modelCounts", "rows", "businessFactsSha256", "fullRowsSha256",
  ], label);
  assert.equal(snapshot.schemaVersion, 1, `${label} schema is invalid`);
  assert.equal(snapshot.journalMode, "wal", `${label} journal mode is invalid`);
  assert.deepEqual(snapshot.migration, EXPECTED_MIGRATION, `${label} migration is invalid`);
  assert.deepEqual(snapshot.foreignKeyViolations, [], `${label} foreign keys are invalid`);
  exactKeys(snapshot.modelCounts, ["modelConfig", "modelCapabilities"], `${label} modelCounts`);
  assert.deepEqual(snapshot.modelCounts, { modelConfig: 0, modelCapabilities: 0 }, `${label} model counts are nonzero`);
  validateRows(snapshot.rows, label);
  validateCounts(snapshot.counts, snapshot.rows, label);
  assert.equal(snapshot.businessFactsSha256, sha256Canonical(projectBusinessFacts(snapshot.rows)), `${label} business hash is invalid`);
  assert.equal(snapshot.fullRowsSha256, sha256Canonical(snapshot.rows), `${label} full-row hash is invalid`);
}

function validateFinalRows(rows, expected) {
  for (const domain of DOMAIN_ORDER) assert.equal(rows[domain].length, 1, `postSave ${domain} row count is invalid`);
  assert.deepEqual(projectBusinessFacts(rows), expected, "postSave canonical business facts are invalid");
  const growth = rows.growth[0];
  const feeding = rows.feeding[0];
  const sleep = rows.sleep[0];
  const diaper = rows.diaper[0];
  const health = rows.health[0];
  for (const row of [growth, sleep, health]) {
    assert.equal(row.created_at, row.updated_at, "Active create-only row revision is invalid");
    assert.equal(row.deleted_at, null, "Active create-only row is deleted");
  }
  assert.equal(growth.weight_percentile, null);
  assert.equal(growth.height_percentile, null);
  assert.equal(growth.head_percentile, null);
  assert.equal(feeding.feed_type, "formula");
  assert.equal(feeding.amount_ml, 100);
  assert.equal(feeding.duration_min, null);
  assert(feeding.created_at < feeding.updated_at, "Feeding update did not advance its revision");
  assert.equal(feeding.deleted_at, null);
  assert.equal(sleep.sleep_type, "night");
  assert.equal(diaper.diaper_type, "mixed");
  assert(diaper.created_at < diaper.updated_at, "Diaper delete did not advance its revision");
  assert.equal(diaper.deleted_at, diaper.updated_at, "Diaper tombstone is invalid");
  assert.equal(health.title, "Synthetic checkup");
  for (const domain of DOMAIN_ORDER) assert.equal(rows[domain][0].source_message_id, null, `${domain} source_message_id must be null`);
}

function sourceScan(root) {
  const listed = spawnSync("git", ["ls-files", "-z", ...GIT_ROOTS], { cwd: root, encoding: "buffer" });
  assert.equal(listed.status, 0, "Unable to enumerate tracked runtime sources");
  assert(listed.stdout.length === 0 || listed.stdout.at(-1) === 0, "Tracked runtime source list is malformed");
  const files = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let start = 0;
  for (let offset = 0; offset < listed.stdout.length; offset += 1) {
    if (listed.stdout[offset] !== 0) continue;
    assert(offset > start, "Tracked runtime source path is empty");
    const pathBytes = listed.stdout.subarray(start, offset);
    let path;
    try {
      path = decoder.decode(pathBytes);
    } catch {
      assert.fail("Tracked runtime source path is invalid UTF-8");
    }
    files.push({ path, pathBytes });
    start = offset + 1;
  }
  files.sort((left, right) => Buffer.compare(left.pathBytes, right.pathBytes));
  const digest = createHash("sha256");
  const nul = Buffer.from([0]);
  let requestPrimitiveMatchCount = 0;
  const primitive = /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\baxios\b|\b(?:http|https)\s*\.\s*(?:request|get)\s*\(|\b(?:ky|superagent|got)\s*\(/gi;
  for (const { path, pathBytes } of files) {
    const bytes = readFileSync(resolve(root, path));
    digest.update(pathBytes).update(nul).update(bytes).update(nul);
    requestPrimitiveMatchCount += [...bytes.toString("utf8").matchAll(primitive)].length;
  }
  return {
    roots: [...GIT_ROOTS],
    trackedFileCount: files.length,
    trackedFileManifestSha256: digest.digest("hex"),
    requestPrimitiveMatchCount,
  };
}

export function collectTrackerPrivacyProof(modelRows, root = repoRoot) {
  exactKeys(modelRows, ["preSave", "postSave", "postRelaunch"], "Tracker privacy modelRows");
  for (const phase of ["preSave", "postSave", "postRelaunch"]) {
    exactKeys(modelRows[phase], ["modelConfig", "modelCapabilities"], `Tracker privacy ${phase}`);
    assert.deepEqual(modelRows[phase], { modelConfig: 0, modelCapabilities: 0 }, `Tracker privacy ${phase} model rows are nonzero`);
  }
  const scan = sourceScan(root);
  assert.equal(scan.requestPrimitiveMatchCount, 0, "Tracked product source contains request primitives");
  return {
    sourceScan: scan,
    modelRows,
    claims: {
      structuralProductRequestAbsence: true,
      packetSilence: false,
      dependencySilence: false,
      osSilence: false,
      physicalDevice: false,
      airplaneMode: false,
    },
    limitation: PRIVACY_LIMITATION,
  };
}

function validateBinary(binary, platform) {
  exactKeys(binary, ["format", "source", "installedBefore", "installedAfter"], "Tracker binary");
  const keys = platform === "android"
    ? ["apkSha256", "embeddedBundleSha256"]
    : ["executableSha256", "mainJsBundleSha256", "infoPlistCanonicalSha256"];
  assert.equal(binary.format, platform === "android" ? "apk" : "ios-three-component-identity", "Tracker binary format is invalid");
  for (const phase of ["source", "installedBefore", "installedAfter"]) {
    exactKeys(binary[phase], keys, `Tracker binary ${phase}`);
    for (const key of keys) assertSha(binary[phase][key], `Tracker binary ${phase}.${key}`);
  }
  assert.deepEqual(binary.installedBefore, binary.source, "Tracker binary identity before save is invalid");
  assert.deepEqual(binary.installedAfter, binary.source, "Tracker binary identity after relaunch is invalid");
}

function validateLifecycle(lifecycle, platform, zone) {
  exactKeys(lifecycle, [
    "metro", "androidReverse", "directLaunches", "zoneObservations", "freshInstallCount",
    "postInstallMutations", "saveRelaunchPidDifferent", "restartProof",
  ], "Tracker lifecycle");
  exactKeys(lifecycle.metro, ["ownedPid", "terminatedBeforeTracker", "probeBeforeTrackerFailed", "probeBeforeReportFailed"], "Tracker lifecycle metro");
  positiveSafeInteger(lifecycle.metro.ownedPid, "Tracker Metro PID");
  for (const key of ["terminatedBeforeTracker", "probeBeforeTrackerFailed", "probeBeforeReportFailed"]) {
    assertTrue(lifecycle.metro[key], `Tracker lifecycle metro.${key}`);
  }
  if (platform === "android") {
    exactKeys(lifecycle.androidReverse, ["port", "absentBeforeTracker", "absentBeforeReport"], "Tracker Android reverse");
    assert.equal(lifecycle.androidReverse.port, 8081);
    assertTrue(lifecycle.androidReverse.absentBeforeTracker, "Tracker Android reverse before tracker");
    assertTrue(lifecycle.androidReverse.absentBeforeReport, "Tracker Android reverse before report");
  } else {
    assert.equal(lifecycle.androidReverse, null, "iOS tracker report cannot contain Android reverse facts");
  }
  exactKeys(lifecycle.directLaunches, ["preSave", "save", "relaunch"], "Tracker direct launches");
  for (const phase of ["preSave", "save", "relaunch"]) {
    const launch = lifecycle.directLaunches[phase];
    exactKeys(launch, ["pid", "terminated", "absentBeforeSnapshot"], `Tracker ${phase} launch`);
    positiveSafeInteger(launch.pid, `Tracker ${phase} PID`);
    assertTrue(launch.terminated, `Tracker ${phase} termination`);
    assertTrue(launch.absentBeforeSnapshot, `Tracker ${phase} PID absence`);
  }
  exactKeys(lifecycle.zoneObservations, ["preSave", "postSave", "postRelaunch"], "Tracker zone observations");
  for (const phase of ["preSave", "postSave", "postRelaunch"]) {
    validIanaZone(lifecycle.zoneObservations[phase]);
    assert.equal(lifecycle.zoneObservations[phase], zone, `Tracker ${phase} zone is invalid`);
  }
  assert.equal(lifecycle.freshInstallCount, 1, "Tracker fresh install count is invalid");
  assert.deepEqual(lifecycle.postInstallMutations, EMPTY_MUTATIONS, "Tracker post-install mutations are invalid");
  assertTrue(lifecycle.saveRelaunchPidDifferent, "Tracker save/relaunch PID difference claim");
  assert.notEqual(lifecycle.directLaunches.save.pid, lifecycle.directLaunches.relaunch.pid, "Tracker save/relaunch PIDs must differ");
  assert.equal(lifecycle.restartProof, platform === "android"
    ? "terminated-snapshot-direct-relaunch-same-installed-apk"
    : "terminated-snapshot-direct-relaunch-same-ios-three-component-identity", "Tracker restart proof is invalid");
}

function validateAccessibility(accessibility, platform) {
  exactKeys(accessibility, ["selectorPolicy", "keyboardDismissal", "nativeObservations", "claims"], "Tracker accessibility");
  exactKeys(accessibility.selectorPolicy, [
    "allowedKinds", "anchoredSelectorCount", "coordinateTapCount", "indexSelectorCount",
    "ambiguousSelectorCount", "optionalCommandCount", "retryCommandCount", "sleepCommandCount",
  ], "Tracker selectorPolicy");
  assert.deepEqual(accessibility.selectorPolicy.allowedKinds, ["id", "textBelowText", "exactText"], "Tracker selector kinds are invalid");
  positiveSafeInteger(accessibility.selectorPolicy.anchoredSelectorCount, "Tracker anchored selector count");
  for (const key of [
    "coordinateTapCount", "indexSelectorCount", "ambiguousSelectorCount", "optionalCommandCount", "retryCommandCount", "sleepCommandCount",
  ]) assert.equal(accessibility.selectorPolicy[key], 0, `Tracker ${key} must be zero`);
  exactKeys(accessibility.keyboardDismissal, ["strategy", "mandatory"], "Tracker keyboardDismissal");
  assert.equal(accessibility.keyboardDismissal.strategy, platform === "android"
    ? "maestro-hideKeyboard-then-entered-value-below-field"
    : "maestro-down-swipe-then-entered-value-below-field", "Tracker keyboard dismissal strategy is invalid");
  assertTrue(accessibility.keyboardDismissal.mandatory, "Tracker keyboard dismissal");
  const observationKeys = [
    "healthConfirmationEntered", "healthCancelReturnedToEditor", "healthEditorFieldsUnchanged",
    "healthCheckupConfirmationFieldObservedWithoutRetap", "healthSecondSubmitObserved", "healthFinalConfirmationObserved",
    "feedingFormulaCreatedRowObserved", "feedingNinetyToHundredDiffObserved", "feedingUpdateFinalConfirmationObserved",
    "sleepNightCreatedRowObserved", "diaperMixedCreatedRowObserved", "diaperDeleteIdentifyingSummaryObserved",
    "diaperConsequenceObserved", "diaperFinalConfirmationObserved", "relaunchActiveRowsObserved", "relaunchDiaperAbsentObserved",
  ];
  exactKeys(accessibility.nativeObservations, observationKeys, "Tracker nativeObservations");
  for (const key of observationKeys) assertTrue(accessibility.nativeObservations[key], `Tracker native observation ${key}`);
  exactKeys(accessibility.claims, ["physicalDevice", "screenReader", "e2e006"], "Tracker accessibility claims");
  assert.deepEqual(accessibility.claims, { physicalDevice: false, screenReader: false, e2e006: false }, "Tracker accessibility claims are invalid");
}

function validateIdentity(value, expectedPath, root, label) {
  exactKeys(value, ["path", "sha256"], label);
  assert.equal(value.path, expectedPath, `${label} path is invalid`);
  assertSha(value.sha256, `${label} SHA`);
  assert.equal(value.sha256, sha256Bytes(readFileSync(resolve(root, expectedPath))), `${label} bytes disagree`);
}

function validateEvidence(evidence, platform, fixture, root) {
  exactKeys(evidence, ["flows", "fixture", "tool", "runner"], "Tracker evidence");
  exactKeys(evidence.flows, ["saveEditDelete", "restart"], "Tracker evidence flows");
  validateIdentity(evidence.flows.saveEditDelete, "e2e/maestro/tracker-save-edit-delete.yaml", root, "Tracker save flow");
  validateIdentity(evidence.flows.restart, "e2e/maestro/tracker-restart.yaml", root, "Tracker restart flow");
  validateIdentity(evidence.fixture, FIXTURE_PATH, root, "Tracker evidence fixture");
  assert.equal(evidence.fixture.sha256, fixture.byteSha256, "Tracker evidence fixture hash is invalid");
  validateIdentity(evidence.tool, "tools/tracker-evidence.mjs", root, "Tracker evidence tool");
  validateIdentity(evidence.runner, `scripts/e2e/run-tracker-restart-${platform}.sh`, root, "Tracker evidence runner");
}

function validateFixtureReport(fixture, zone, root) {
  exactKeys(fixture, [
    "path", "byteSha256", "semanticSha256", "manualProjectionSha256",
    "timeZone", "localInputs", "canonicalBusinessFacts",
  ], "Tracker report fixture");
  exactKeys(fixture.localInputs, DOMAIN_ORDER, "Tracker localInputs");
  exactKeys(fixture.canonicalBusinessFacts, DOMAIN_ORDER, "Tracker canonicalBusinessFacts");
  for (const domain of DOMAIN_ORDER) {
    exactKeys(fixture.localInputs[domain], LOCAL_INPUT_KEYS[domain], `Tracker ${domain} localInputs`);
    allStrings(fixture.localInputs[domain], `Tracker ${domain} localInputs`);
    assert(Array.isArray(fixture.canonicalBusinessFacts[domain]), `Tracker ${domain} business facts must be an array`);
    for (const row of fixture.canonicalBusinessFacts[domain]) {
      exactKeys(row, DOMAIN_CONFIG[domain].businessKeys, `Tracker ${domain} business fact`);
    }
  }
  assert.deepEqual(fixture, deriveTrackerFixture(zone, root), "Tracker fixture derivation is invalid");
}

export function validateTrackerReport(report, platform, expectedSha, root = repoRoot) {
  assert(["android", "ios"].includes(platform), "Tracker report platform argument is invalid");
  assert.match(expectedSha, /^[0-9a-f]{40}$/, "Tracker expected SHA argument is invalid");
  exactKeys(report, [
    "schemaVersion", "reportType", "platform", "flavor", "checkedOutSha", "expectedSha",
    "testId", "fixture", "accessibility", "binary", "database", "lifecycle", "privacy",
    "migration", "evidence", "status", "skipped",
  ], "Tracker report");
  assert.equal(report.schemaVersion, 1, "Tracker report schema is invalid");
  assert.equal(report.reportType, "manual-tracker-offline-restart", "Tracker report type is invalid");
  assert.equal(report.platform, platform, "Tracker report platform disagrees");
  assert.equal(report.flavor, "e2e-release", "Tracker report flavor is invalid");
  assert.equal(report.checkedOutSha, expectedSha, "Tracker checked-out SHA disagrees");
  assert.equal(report.expectedSha, expectedSha, "Tracker expected SHA disagrees");
  assert.equal(report.testId, "G025-E2E-001", "Tracker test ID is invalid");
  assert.equal(report.status, "pass", "Tracker report status is invalid");
  assert.deepEqual(report.skipped, [], "Tracker report cannot skip facts");

  validateFixtureReport(report.fixture, report.fixture.timeZone, root);
  validateAccessibility(report.accessibility, platform);
  validateBinary(report.binary, platform);
  exactKeys(report.database, ["preSave", "postSave", "postRelaunch"], "Tracker database");
  validateSnapshot(report.database.preSave, "preSave");
  validateSnapshot(report.database.postSave, "postSave");
  validateSnapshot(report.database.postRelaunch, "postRelaunch");
  const emptyRows = Object.fromEntries(DOMAIN_ORDER.map((domain) => [domain, []]));
  assert.deepEqual(report.database.preSave.rows, emptyRows, "preSave tracker rows must be empty");
  assert.deepEqual(report.database.preSave.counts, snapshotCounts(emptyRows), "preSave counts are invalid");
  validateFinalRows(report.database.postSave.rows, report.fixture.canonicalBusinessFacts);
  assert.deepEqual(report.database.postSave.counts, {
    total: 5,
    active: 4,
    tombstoned: 1,
    byDomain: {
      growth: { total: 1, active: 1, tombstoned: 0 },
      feeding: { total: 1, active: 1, tombstoned: 0 },
      sleep: { total: 1, active: 1, tombstoned: 0 },
      diaper: { total: 1, active: 0, tombstoned: 1 },
      health: { total: 1, active: 1, tombstoned: 0 },
    },
  }, "postSave 5/4/1 counts are invalid");
  assert.equal(report.database.postSave.businessFactsSha256, report.fixture.manualProjectionSha256, "postSave manual projection hash is invalid");
  assert.equal(
    canonicalJson(report.database.postRelaunch),
    canonicalJson(report.database.postSave),
    "postRelaunch snapshot differs from postSave",
  );

  validateLifecycle(report.lifecycle, platform, report.fixture.timeZone);
  const expectedPrivacy = collectTrackerPrivacyProof({
    preSave: report.database.preSave.modelCounts,
    postSave: report.database.postSave.modelCounts,
    postRelaunch: report.database.postRelaunch.modelCounts,
  }, root);
  exactKeys(report.privacy, ["sourceScan", "modelRows", "claims", "limitation"], "Tracker privacy");
  exactKeys(report.privacy.sourceScan, ["roots", "trackedFileCount", "trackedFileManifestSha256", "requestPrimitiveMatchCount"], "Tracker privacy sourceScan");
  exactKeys(report.privacy.modelRows, ["preSave", "postSave", "postRelaunch"], "Tracker privacy modelRows");
  exactKeys(report.privacy.claims, [
    "structuralProductRequestAbsence", "packetSilence", "dependencySilence", "osSilence", "physicalDevice", "airplaneMode",
  ], "Tracker privacy claims");
  for (const key of Object.keys(report.privacy.claims)) assertBoolean(report.privacy.claims[key], `Tracker privacy claim ${key}`);
  assertTrue(report.privacy.claims.structuralProductRequestAbsence, "Tracker structural request absence claim");
  for (const key of ["packetSilence", "dependencySilence", "osSilence", "physicalDevice", "airplaneMode"]) {
    assertFalse(report.privacy.claims[key], `Tracker privacy claim ${key}`);
  }
  assert.deepEqual(report.privacy, expectedPrivacy, "Tracker privacy proof is invalid");

  const expectedMigration = migrationIdentity(root);
  exactKeys(report.migration, ["path", "recordedSha256", "sourceSha256", "sqlByteCount", "inventory", "applied"], "Tracker migration");
  exactKeys(report.migration.inventory, ["tables", "indexes", "triggers"], "Tracker migration inventory");
  assert.deepEqual(report.migration, expectedMigration, "Tracker migration identity is invalid");
  for (const phase of ["preSave", "postSave", "postRelaunch"]) {
    assert.deepEqual(report.database[phase].migration, report.migration.applied, `Tracker ${phase} applied migrations are invalid`);
  }
  validateEvidence(report.evidence, platform, report.fixture, root);
  canonicalJson(report);
  return report;
}

export function validateCanonicalTrackerReportBytes(bytes, platform, expectedSha, root = repoRoot) {
  assert(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array, "Tracker report bytes are required");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const report = JSON.parse(text);
  validateTrackerReport(report, platform, expectedSha, root);
  assert.equal(text, canonicalJson(report), "Tracker report bytes are not exact canonical JSON");
  return report;
}

function option(name, required = true) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (required) assert(value, `${name} is required`);
  return value;
}

function writeCanonicalOutput(path, value) {
  writeFileSync(path, canonicalJson(value));
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function runCli() {
  const action = option("--action");
  const output = option("--output");
  switch (action) {
    case "fixture-oracle":
      writeCanonicalOutput(output, deriveTrackerFixture(option("--time-zone")));
      break;
    case "tracker-snapshot":
      writeCanonicalOutput(output, snapshotTrackerDatabase(option("--database")));
      break;
    case "privacy-proof":
      writeCanonicalOutput(output, collectTrackerPrivacyProof({
        preSave: readJson(option("--pre-save")).modelCounts,
        postSave: readJson(option("--post-save")).modelCounts,
        postRelaunch: readJson(option("--post-relaunch")).modelCounts,
      }));
      break;
    case "validate-report": {
      const input = option("--input");
      const bytes = readFileSync(input);
      const report = validateCanonicalTrackerReportBytes(bytes, option("--platform"), option("--expected-sha"));
      writeCanonicalOutput(output, report);
      break;
    }
    default:
      assert.fail(`Unknown tracker evidence action: ${action}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runCli();
