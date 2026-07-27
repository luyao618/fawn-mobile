import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMA_VERSION = 1;
const REPORT_TYPE = "android-fabric-diagnostic-retention";
const DEVICE_TOMBSTONE_DIRECTORY = "/data/tombstones";
const AAR_MEMBER = "prefab/modules/reactnative/libs/android.x86_64/libreactnative.so";
const PACKAGED_MEMBERS = ["lib/x86_64/libreactnative.so", "lib/x86_64/librnscreens.so"];
const REACT_NATIVE_MEMBER = PACKAGED_MEMBERS[0];
const INSTALLED_BASE_APK_NAME = "base.apk";
const DEV_CLIENT_BUNDLE_REASON =
  "No exact post-failure artifact exists: the dev-client JS bundle is served by Metro at run time and is never written to disk, "
  + "and re-requesting it after the failure would warm Metro and produce a different bundle than the one that faulted.";
const GRADLE_REACT_ANDROID_CACHE = ".gradle/caches/modules-2/files-2.1/com.facebook.react/react-android";
/**
 * Retained tombstones are raw device dumps, not sanitized reports. Saying what they are — and
 * refusing to claim a redaction this collector does not perform — is itself part of the evidence.
 */
const TOMBSTONE_CONTENT_DISCLOSURE =
  "These are the device's raw native-crash dumps, retained byte-for-byte and NOT redacted, filtered, or scanned. "
  + "They are produced by a synthetic E2E launch on a disposable emulator seeded only with fixture data, so no WHO "
  + "growth-reference content, real end-user record, or credential is expected in them; that is an expectation about "
  + "the run, not a guarantee about the bytes.";
const PUBLIC_ARTIFACT_RISK =
  "Residual risk: this manifest and everything beside it are uploaded as a CI artifact and are readable by anyone who "
  + "can read the workflow run. Nothing here is redacted for content. Tombstones carry process memory, register state, "
  + "and mapped device paths; the retained APKs and libraries carry the full shipped application image. Absolute host "
  + "paths are kept out of published fields, but device-side paths, package name, and emulator serial are published "
  + "deliberately as evidence. Do not run this collector against a device holding real user data.";
const GNU_BUILD_ID_NOTE_TYPE = 3;
const SHT_NOTE = 7;
const SHA1_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
/**
 * The cached AAR is addressed by an exact version directory, so only an exact `major.minor.patch`
 * declaration is resolvable. A range or tag would send the lookup at a directory that cannot exist
 * and make it report an untrue "no cached AAR" instead of the unresolvable declaration it really is.
 */
const EXACT_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
/**
 * An emulator serial is `emulator-<port>` and nothing else. This collector pulls the full installed
 * application image and the device's raw, unredacted tombstones into a published CI artifact, so a
 * serial naming anything but a disposable emulator — a USB device id, a network `host:port` target —
 * must be refused before any of that is collected, not explained afterwards.
 */
const EMULATOR_SERIAL_PATTERN = /^emulator-[0-9]+$/;
/**
 * Matches the `libreactnative.so ... (BuildId: <hex>)` frame annotation android emits into text
 * tombstones. Real frames interpose an `(offset 0x…)` group and a demangled symbol group — itself
 * containing nested parentheses for the argument list — before the BuildId group, so the span is
 * matched lazily across any non-newline text rather than stopping at the first `)`.
 */
const TOMBSTONE_BUILD_ID_PATTERN = /libreactnative\.so[^\n]*?\(BuildId:\s*([0-9a-f]{8,})\)/gi;

function parseOptions(args, allowed) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!allowed.includes(flag)) throw new Error(`Unsupported option ${flag}`);
    const value = args[index + 1];
    if (value === undefined) throw new Error(`Option ${flag} requires a value`);
    options[flag] = value;
  }
  return options;
}

/**
 * Node filesystem errors embed the absolute host path they failed on, and every reason string here
 * is published in the manifest. The message is rebuilt from the syscall and the artifact basenames
 * so the reason still names the artifact that was missing without disclosing the host root.
 */
function describeError(error) {
  if (error instanceof Error && typeof error.code === "string" && typeof error.path === "string") {
    const names = [basename(error.path), ...(typeof error.dest === "string" ? [basename(error.dest)] : [])];
    return `${error.code}: ${error.syscall ?? "filesystem access"} failed for ${names.join(" -> ")}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Every diagnostic action is best-effort: a failure becomes a recorded reason, never a thrown error. */
function attempt(run) {
  try {
    return run();
  } catch (error) {
    return { status: "unavailable", reason: describeError(error) };
  }
}

/**
 * `adb pull` takes an absolute host destination, and adb echoes that destination back in its own
 * failure text. Both the argument list this collector prints and adb's stderr are published as
 * manifest reasons, so the destination is reduced to its basename in each. The device-side remote
 * path is deliberately preserved: it is evidence of what was collected, not a host disclosure.
 */
function redactHostDestination(text, hostDestination) {
  if (typeof hostDestination !== "string" || hostDestination.length === 0) return text;
  return text.split(hostDestination).join(basename(hostDestination));
}

function adb(adbPath, serial, args, options = {}) {
  // Only `adb pull` writes to the host, and its destination is always the trailing argument.
  const hostDestination = args[0] === "pull" && args.length >= 3 ? args[args.length - 1] : undefined;
  const describeArgs = () => redactHostDestination(args.join(" "), hostDestination);
  const result = spawnSync(adbPath, ["-s", serial, ...args], {
    encoding: options.encoding ?? "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120_000,
  });
  if (result.error) {
    throw new Error(`adb ${describeArgs()} failed: ${redactHostDestination(result.error.message, hostDestination)}`);
  }
  if (result.status !== 0) {
    const stderr = typeof result.stderr === "string" ? redactHostDestination(result.stderr.trim(), hostDestination) : "";
    throw new Error(`adb ${describeArgs()} exited ${result.status ?? "on signal"}${stderr ? `: ${stderr}` : ""}`);
  }
  return result.stdout;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function fileIdentity(path) {
  const buffer = readFileSync(path);
  return { sha256: sha256(buffer), size: buffer.length };
}

/**
 * Reads NT_GNU_BUILD_ID from a little-endian ELF64 image without invoking external tooling.
 * Every offset and length here is attacker-influenced data read out of the image itself, so each
 * one is bounds-checked against the buffer before it is used: a corrupt or truncated library must
 * degrade to a recorded reason, never to an out-of-range read or a Build ID assembled from
 * whatever bytes happened to follow.
 */
function readBuildId(buffer) {
  if (buffer.length < 64 || buffer.readUInt32BE(0) !== 0x7f454c46) throw new Error("Not an ELF image");
  if (buffer.readUInt8(4) !== 2 || buffer.readUInt8(5) !== 1) throw new Error("Only little-endian ELF64 is supported");
  const sectionOffset = Number(buffer.readBigUInt64LE(40));
  const entrySize = buffer.readUInt16LE(58);
  const entryCount = buffer.readUInt16LE(60);
  if (entrySize < 64) throw new Error("ELF section header table declares an undersized entry");
  for (let index = 0; index < entryCount; index += 1) {
    const header = sectionOffset + index * entrySize;
    if (header < 0 || header + entrySize > buffer.length) break;
    if (buffer.readUInt32LE(header + 4) !== SHT_NOTE) continue;
    let cursor = Number(buffer.readBigUInt64LE(header + 24));
    const declaredEnd = cursor + Number(buffer.readBigUInt64LE(header + 32));
    // A note section may declare an extent past the image; never read beyond the bytes we hold.
    const end = Math.min(declaredEnd, buffer.length);
    if (cursor < 0) continue;
    while (cursor + 12 <= end) {
      const nameSize = buffer.readUInt32LE(cursor);
      const descriptorSize = buffer.readUInt32LE(cursor + 4);
      const noteType = buffer.readUInt32LE(cursor + 8);
      const nameStart = cursor + 12;
      const nameEnd = nameStart + nameSize;
      const descriptorStart = nameStart + (nameSize + 3 & ~3);
      const descriptorEnd = descriptorStart + descriptorSize;
      // A note whose own name or descriptor runs past the section is malformed, not a note to skip:
      // advancing on a bogus length would just walk the cursor into unrelated bytes.
      if (nameEnd > end || descriptorStart > end || descriptorEnd > end) {
        throw new Error("ELF note descriptor extends past the end of its section");
      }
      if (noteType === GNU_BUILD_ID_NOTE_TYPE && buffer.toString("ascii", nameStart, nameStart + 3) === "GNU") {
        if (descriptorSize === 0) throw new Error("ELF GNU Build ID note carries an empty descriptor");
        return buffer.toString("hex", descriptorStart, descriptorEnd);
      }
      const next = descriptorStart + (descriptorSize + 3 & ~3);
      // A zero-length advance would spin forever on a malformed note.
      if (next <= cursor) throw new Error("ELF note table does not advance");
      cursor = next;
    }
  }
  throw new Error("ELF image carries no GNU Build ID note");
}

/** Extracts one archive member with the same PATH `unzip` the Android job already installs Maestro with. */
function extractMember(archive, member, destination) {
  const result = spawnSync("unzip", ["-p", archive, member], { maxBuffer: 512 * 1024 * 1024, timeout: 300_000 });
  if (result.error) throw new Error(`unzip ${member} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`unzip ${member} from ${basename(archive)} exited ${result.status ?? "on signal"}`);
  if (result.stdout.length === 0) throw new Error(`${member} is absent from ${basename(archive)}`);
  if (destination !== undefined) writeFileSync(destination, result.stdout);
  return result.stdout;
}

/**
 * Binds the retained evidence to a revision this process observed itself. The expected SHA is a
 * caller claim, so it is only ever reported as verified when `git rev-parse HEAD` independently
 * agrees; every other outcome stays `unavailable` and no failure escapes into the cleanup path.
 */
function bindCheckedOutSha(root, expectedShaOption) {
  const expectedSha = typeof expectedShaOption === "string" && SHA1_PATTERN.test(expectedShaOption.trim())
    ? expectedShaOption.trim()
    : null;
  const supplied = typeof expectedShaOption === "string" ? expectedShaOption.trim() : "";

  let checkedOutSha = null;
  let revisionReason;
  try {
    const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", timeout: 60_000 });
    if (result.error) throw new Error(`git rev-parse HEAD failed: ${result.error.message}`);
    if (result.status !== 0) {
      const stderr = typeof result.stderr === "string" ? result.stderr.trim() : "";
      throw new Error(`git rev-parse HEAD exited ${result.status ?? "on signal"}${stderr ? `: ${stderr}` : ""}`);
    }
    const candidate = String(result.stdout).trim();
    if (!SHA1_PATTERN.test(candidate)) throw new Error("git rev-parse HEAD returned no 40-character hexadecimal revision");
    checkedOutSha = candidate;
  } catch (error) {
    revisionReason = describeError(error);
  }

  const binding = { expectedSha, checkedOutSha, matchesExpectedSha: null };
  if (supplied.length === 0) {
    return { ...binding, status: "unavailable", reason: "No expected SHA was supplied, so the retained evidence cannot be bound to a revision." };
  }
  if (expectedSha === null) {
    return {
      ...binding,
      status: "unavailable",
      reason: "The supplied expected SHA is not a 40-character hexadecimal revision, so no binding is admissible.",
    };
  }
  if (checkedOutSha === null) {
    return { ...binding, status: "unavailable", reason: revisionReason ?? "The checked-out revision could not be read." };
  }
  if (checkedOutSha !== expectedSha) {
    return {
      ...binding,
      status: "unavailable",
      matchesExpectedSha: false,
      reason: `The checked-out revision ${checkedOutSha} does not match the expected SHA ${expectedSha}; `
        + "the retained evidence describes a different revision than the caller claimed.",
    };
  }
  return { ...binding, status: "verified", matchesExpectedSha: true };
}

/**
 * Resolves the react-native version from the one place the repo declares it. The cached AAR the
 * symbols come from and the version this manifest publishes as provenance must both describe the
 * revision that was actually built; a constant restated here would keep claiming the old version
 * after an upgrade and quietly authorize symbols against a library the build never produced.
 *
 * Only an exact version is admissible: a range or tag cannot address a cached artifact directory.
 * Every failure is a recorded reason, never a throw — the collector is evidence, not a gate.
 */
function readDeclaredReactNativeVersion(root) {
  let declared;
  try {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    declared = manifest?.dependencies?.["react-native"];
  } catch (error) {
    return { version: null, reason: `The declared react-native version could not be read: ${describeError(error)}` };
  }
  if (typeof declared !== "string" || declared.length === 0) {
    return { version: null, reason: "The root package.json declares no react-native dependency, so no AAR version is resolvable." };
  }
  if (!EXACT_VERSION_PATTERN.test(declared)) {
    return {
      version: null,
      reason: `The declared react-native dependency ${JSON.stringify(declared)} is not an exact version, so it cannot `
        + "address a cached react-android artifact.",
    };
  }
  return { version: declared };
}

function collectTombstones(context) {
  const { adbPath, serial, outputDir, root } = context;
  const listing = adb(adbPath, serial, ["shell", "ls", "-1", DEVICE_TOMBSTONE_DIRECTORY])
    .split("\n").map((line) => line.trim().replace(/\r$/, "")).filter((line) => line.length > 0);
  const pullDir = join(outputDir, "tombstones");
  mkdirSync(pullDir, { recursive: true });
  const entries = listing.map((name) => {
    const remotePath = `${DEVICE_TOMBSTONE_DIRECTORY}/${name}`;
    const kind = name.endsWith(".pb") ? "tombstone-proto" : "tombstone";
    const entry = { name, kind, remotePath, pulled: false };
    try {
      const localPath = join(pullDir, name);
      adb(adbPath, serial, ["pull", remotePath, localPath]);
      Object.assign(entry, fileIdentity(localPath), { pulled: true, localPath: relative(root, localPath) });
    } catch (error) {
      entry.reason = describeError(error);
      return entry;
    }
    try {
      const digest = adb(adbPath, serial, ["shell", "sha256sum", remotePath]).trim().split(/\s+/)[0];
      if (!SHA256_PATTERN.test(digest)) throw new Error(`sha256sum returned an unusable digest for ${remotePath}`);
      entry.deviceSha256 = digest;
      entry.pullIsByteExact = digest === entry.sha256;
    } catch (error) {
      entry.deviceSha256Reason = describeError(error);
      entry.pullIsByteExact = null;
    }
    return entry;
  });

  const counts = { tombstone: 0, "tombstone-proto": 0 };
  for (const entry of entries) counts[entry.kind] += 1;
  return {
    status: "collected",
    deviceDirectory: DEVICE_TOMBSTONE_DIRECTORY,
    contentDisclosure: TOMBSTONE_CONTENT_DISCLOSURE,
    redacted: false,
    entries,
    counts,
  };
}

/**
 * Recovers the unique libreactnative Build IDs the device itself recorded in the retained text
 * tombstones. Proto tombstones are deliberately skipped: they are not text and decoding them would
 * need tooling this collector must not add.
 */
function readTombstoneBuildIds(root, tombstonesSection) {
  if (tombstonesSection.status !== "collected") {
    return { buildIds: [], reason: "No tombstones were retained, so no device-recorded Build ID is available." };
  }
  const buildIds = new Set();
  const reasons = [];
  for (const entry of tombstonesSection.entries) {
    if (entry.kind !== "tombstone" || entry.pulled !== true || entry.localPath === undefined) continue;
    try {
      const text = readFileSync(join(root, entry.localPath), "utf8");
      for (const match of text.matchAll(TOMBSTONE_BUILD_ID_PATTERN)) buildIds.add(match[1].toLowerCase());
    } catch (error) {
      reasons.push(`${entry.name}: ${describeError(error)}`);
    }
  }
  const result = { buildIds: [...buildIds].sort() };
  if (result.buildIds.length === 0) {
    result.reason = reasons.length > 0
      ? `No libreactnative Build ID was readable from the retained text tombstones (${reasons.join("; ")}).`
      : "The retained text tombstones record no libreactnative Build ID frame.";
  }
  return result;
}

function collectInstalledApk(context, hostApkSection) {
  const { adbPath, serial, packageName, outputDir, root } = context;
  const paths = adb(adbPath, serial, ["shell", "pm", "path", packageName])
    .split("\n").map((line) => line.trim().replace(/\r$/, ""))
    .filter((line) => line.startsWith("package:")).map((line) => line.slice("package:".length));
  if (paths.length === 0) throw new Error(`pm path reported no APK for ${packageName}`);

  const basePaths = paths.filter((candidate) => basename(candidate) === INSTALLED_BASE_APK_NAME);
  if (basePaths.length === 0) {
    throw new Error(`pm path reported no ${INSTALLED_BASE_APK_NAME} for ${packageName}: ${paths.join(", ")}`);
  }
  if (basePaths.length > 1) {
    throw new Error(`pm path reported ${basePaths.length} ${INSTALLED_BASE_APK_NAME} entries for ${packageName}`);
  }
  const remotePath = basePaths[0];
  const splitRemotePaths = paths.filter((candidate) => candidate !== remotePath);

  const apkDir = join(outputDir, "apk");
  mkdirSync(apkDir, { recursive: true });
  const localPath = join(apkDir, "installed-base.apk");
  adb(adbPath, serial, ["pull", remotePath, localPath]);

  const retained = fileIdentity(localPath);
  const section = {
    status: "collected",
    remotePath,
    additionalRemotePaths: splitRemotePaths,
    splitInstall: splitRemotePaths.length > 0,
    localPath: relative(root, localPath),
    ...retained,
    matchesHostApk: null,
  };

  // Byte-exactness is established first: a comparison against bytes that were never proven to be
  // the device's own bytes would describe the transfer, not the install.
  try {
    const digest = adb(adbPath, serial, ["shell", "sha256sum", remotePath]).trim().split(/\s+/)[0];
    if (!SHA256_PATTERN.test(digest)) throw new Error(`sha256sum returned an unusable digest for ${remotePath}`);
    section.deviceSha256 = digest;
    section.pullIsByteExact = digest === retained.sha256;
  } catch (error) {
    section.deviceSha256Reason = describeError(error);
    section.pullIsByteExact = null;
  }

  if (hostApkSection.status !== "collected") {
    section.matchesHostApkReason = "The host debug APK was not retained, so no comparison with the installed APK is admissible.";
  } else if (section.splitInstall) {
    // Comparing one split member against the single host APK would manufacture a mismatch claim.
    section.matchesHostApkReason = `The install is split across ${paths.length} APKs, so ${INSTALLED_BASE_APK_NAME} alone `
      + "cannot be compared with the single host debug APK.";
  } else if (section.pullIsByteExact !== true) {
    // A corrupt or unverified pull compares the transfer against the host build, not the install:
    // it manufactures a false mismatch when the device's own bytes may match perfectly.
    section.matchesHostApkReason = section.pullIsByteExact === false
      ? "The installed APK pull is not byte-exact against the device digest, so comparing the retained bytes with the "
        + "host debug APK would report a difference in the transfer rather than in the install."
      : "The installed APK pull was never proven byte-exact against the device digest, so a comparison with the host "
        + "debug APK cannot be shown to describe the installed image.";
  } else {
    section.matchesHostApk = retained.sha256 === hostApkSection.sha256;
  }
  return section;
}

function collectHostApk(context) {
  const { outputDir, root } = context;
  const path = resolve(root, context.hostApk);
  const apkDir = join(outputDir, "apk");
  mkdirSync(apkDir, { recursive: true });
  const localPath = join(apkDir, "host-app-debug.apk");
  copyFileSync(path, localPath);
  return {
    status: "collected",
    path: relative(root, path),
    localPath: relative(root, localPath),
    ...fileIdentity(localPath),
  };
}

function collectPackagedLibraries(context) {
  const { outputDir, root } = context;
  const archive = resolve(root, context.hostApk);
  statSync(archive);
  const libraryDir = join(outputDir, "packaged-libraries");
  mkdirSync(libraryDir, { recursive: true });

  const entries = PACKAGED_MEMBERS.map((member) => {
    try {
      const localPath = join(libraryDir, basename(member));
      const buffer = extractMember(archive, member, localPath);
      const entry = {
        member,
        localPath: relative(root, localPath),
        sha256: sha256(buffer),
        size: buffer.length,
      };
      try {
        entry.buildId = readBuildId(buffer);
      } catch (error) {
        entry.buildIdReason = describeError(error);
      }
      return entry;
    } catch (error) {
      return { member, reason: describeError(error) };
    }
  });
  return { status: "collected", archive: relative(root, archive), entries };
}

/**
 * Reads the Build ID of the libreactnative actually shipped inside the retained installed APK.
 * The installed APK is the only artifact proven to be the image the device loaded, so it — not the
 * host build output — is what any symbol claim has to be verified against. A pull that was not
 * proven byte-exact against the device digest is not that artifact: an embedded Build ID may still
 * parse out of a corrupt or unverified transfer, and trusting it would authorize symbols against
 * bytes the device never loaded.
 *
 * A split install is refused outright. This workflow installs a single monolithic APK, so a split
 * means the device is not running what this collector can account for: the native library could be
 * shipped in any `split_config.*` member, and probing base.apk alone would silently answer from one
 * arbitrary member — reporting either a Build ID that is not the loaded one or a spurious absence.
 * Retaining every native-bearing split would be the only sound alternative, and this workflow does
 * not do that, so the honest answer is an explicit unavailable naming the splits it saw.
 */
function readInstalledReactNativeBuildId(context, installedApkSection) {
  if (installedApkSection.status !== "collected" || installedApkSection.localPath === undefined) {
    return {
      buildId: null,
      reason: "The installed APK was not retained, so the faulting libreactnative image carries no verifiable Build ID.",
    };
  }
  if (installedApkSection.splitInstall === true) {
    const splitNames = (installedApkSection.additionalRemotePaths ?? []).map((path) => basename(path));
    return {
      buildId: null,
      reason: `Symbol provenance is unsupported for split installs: the install spans ${splitNames.length + 1} APKs `
        + `(${INSTALLED_BASE_APK_NAME}${splitNames.length > 0 ? `, ${splitNames.join(", ")}` : ""}) and this workflow `
        + `retains only ${INSTALLED_BASE_APK_NAME}, so the native-bearing split cannot be shown to be accounted for and `
        + `probing ${INSTALLED_BASE_APK_NAME} alone would not establish which image the device loaded.`,
    };
  }
  if (installedApkSection.pullIsByteExact !== true) {
    return {
      buildId: null,
      reason: installedApkSection.pullIsByteExact === false
        ? "The installed APK pull is not byte-exact against the device digest, so the libreactnative image it carries "
          + "is not the image the device loaded and its Build ID cannot establish provenance."
        : "The installed APK pull was never proven byte-exact against the device digest, so the libreactnative image "
          + "it carries cannot be shown to be the image the device loaded and its Build ID cannot establish provenance.",
    };
  }
  const archive = join(context.root, installedApkSection.localPath);
  try {
    const buffer = extractMember(archive, REACT_NATIVE_MEMBER);
    return { buildId: readBuildId(buffer), sha256: sha256(buffer), size: buffer.length };
  } catch (error) {
    return { buildId: null, reason: `${REACT_NATIVE_MEMBER} could not be read from the retained installed APK: ${describeError(error)}` };
  }
}

/**
 * Retains the unstripped RN Debug library only when its Build ID is positively verified against the
 * libreactnative extracted from the retained installed APK, and — when the device recorded any —
 * against the tombstone Build IDs. Anything else is `unavailable` with no admissible `localPath`
 * and no symbol file left behind, because host-only symbols are not faulting-image evidence.
 */
function collectUnstrippedReactNative(context, installedApkSection, tombstonesSection) {
  const { outputDir, root } = context;
  const symbolDir = join(outputDir, "symbols");
  mkdirSync(symbolDir, { recursive: true });
  const localPath = join(symbolDir, "libreactnative.so");
  // A previous attempt must never leave a symbol file that outlives its own verification.
  rmSync(localPath, { force: true });

  const installed = readInstalledReactNativeBuildId(context, installedApkSection);
  const tombstone = readTombstoneBuildIds(root, tombstonesSection);
  const evidence = {
    memberPath: AAR_MEMBER,
    packagedBuildId: installed.buildId,
    // The source names the artifact a Build ID was actually read from. With no Build ID there is no
    // such artifact, so naming the retained APK would imply a provenance read that never succeeded.
    packagedBuildIdSource: installed.buildId === null ? null : installedApkSection.localPath ?? null,
    buildIdMatchesPackaged: null,
    tombstoneBuildIds: tombstone.buildIds,
    buildIdMatchesTombstones: null,
  };
  if (installed.reason !== undefined) evidence.packagedBuildIdReason = installed.reason;
  if (tombstone.reason !== undefined) evidence.tombstoneBuildIdReason = tombstone.reason;

  let aarPath;
  let buffer;
  try {
    aarPath = findCachedDebugAar(context.gradleCache, context.reactNativeVersion);
    buffer = extractMember(aarPath, AAR_MEMBER);
  } catch (error) {
    return { ...evidence, status: "unavailable", reason: describeError(error) };
  }
  // The absolute Gradle cache location is a host detail and never belongs in the published manifest.
  evidence.aarPath = basename(aarPath);

  let buildId;
  try {
    buildId = readBuildId(buffer);
  } catch (error) {
    return { ...evidence, status: "unavailable", reason: `The cached AAR libreactnative.so carries no usable Build ID: ${describeError(error)}` };
  }
  const recovered = { ...evidence, buildId, sha256: sha256(buffer), size: buffer.length };

  if (installed.buildId === null) {
    return {
      ...recovered,
      status: "unavailable",
      reason: `${installed.reason} Host-only symbols would not describe the faulting image, so they are not retained.`,
    };
  }
  recovered.buildIdMatchesPackaged = buildId === installed.buildId;
  if (!recovered.buildIdMatchesPackaged) {
    return {
      ...recovered,
      status: "unavailable",
      reason: `Cached AAR Build ID ${buildId} does not match the packaged libreactnative.so Build ID ${installed.buildId}; `
        + "these symbols would not describe the faulting image.",
    };
  }

  if (tombstone.buildIds.length > 0) {
    recovered.buildIdMatchesTombstones = tombstone.buildIds.includes(buildId);
    if (!recovered.buildIdMatchesTombstones) {
      return {
        ...recovered,
        status: "unavailable",
        reason: `Cached AAR Build ID ${buildId} is absent from the libreactnative Build IDs the tombstones recorded `
          + `(${tombstone.buildIds.join(", ")}); these symbols would not describe the faulting image.`,
      };
    }
  }

  writeFileSync(localPath, buffer);
  return { ...recovered, status: "collected", localPath: relative(root, localPath) };
}

/** Locates the exact cached RN Debug AAR by walking only the declared react-android version directory. */
function findCachedDebugAar(gradleCache, reactNativeVersion) {
  if (reactNativeVersion.version === null) {
    throw new Error(`${reactNativeVersion.reason} No cached react-android Debug AAR can be located without it.`);
  }
  const expectedName = `react-android-${reactNativeVersion.version}-debug.aar`;
  if (typeof gradleCache !== "string" || gradleCache.length === 0) {
    throw new Error(
      `No Gradle react-android module cache could be located: neither --gradle-cache nor HOME was set, so ${expectedName} `
      + "was never searched for.",
    );
  }
  const versionDir = join(resolve(gradleCache), reactNativeVersion.version);
  const matches = readdirSync(versionDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(versionDir, entry.name, expectedName))
    .filter((candidate) => {
      try {
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    });
  // Reasons are published, so they name the artifact rather than the absolute host cache path.
  if (matches.length === 0) throw new Error(`No cached ${expectedName} under the configured Gradle react-android module cache`);
  if (matches.length > 1) {
    throw new Error(`Ambiguous cached ${expectedName}: ${matches.length} candidates under the configured Gradle react-android module cache`);
  }
  return matches[0];
}

/**
 * Retention I/O — pulling tombstones and multi-megabyte APKs over adb — runs for long enough that
 * the 300s CI timeout can kill this process partway through. A manifest written only at the end
 * would then be absent entirely, and one written once up front would keep claiming sections that
 * never ran. So the manifest is written as a `collecting` skeleton before any of that I/O begins
 * and rewritten after each section lands: whatever the timeout leaves behind is a manifest whose
 * `status` is still `collecting` and whose unfinished sections are explicitly `pending`, never a
 * partial run wearing a `complete` status or a section claiming evidence it never gathered.
 */
const PENDING_SECTION = Object.freeze({ status: "pending", reason: "This section had not been collected yet." });
const SECTION_NAMES = ["tombstones", "installedApk", "hostApk", "packagedLibraries", "unstrippedReactNative", "devClientBundle"];

export function collectFabricDiagnostics(context) {
  // The serial decides which device gets its full application image and raw tombstones pulled into a
  // published artifact, so it is checked before the output directory exists and before adb is ever
  // spawned. This belongs to the exported boundary rather than the CLI: every caller, not just
  // `main`, has to be held to it. Anything but an emulator port is refused outright rather than
  // recorded — publishing a manifest for a device this collector must not touch would itself be the
  // disclosure.
  if (typeof context.serial !== "string" || !EMULATOR_SERIAL_PATTERN.test(context.serial)) {
    throw new Error(
      `Refusing to collect from serial ${JSON.stringify(context.serial ?? null)}: only an emulator-<port> serial is `
      + "supported, and this collector retains unredacted device evidence into a published CI artifact.",
    );
  }
  mkdirSync(context.outputDir, { recursive: true });
  const manifestPath = join(context.outputDir, "manifest.json");

  const shaBinding = bindCheckedOutSha(context.root, context.expectedSha);
  const reactNativeVersion = readDeclaredReactNativeVersion(context.root);
  const manifest = {
    schemaVersion: SCHEMA_VERSION,
    type: REPORT_TYPE,
    status: "collecting",
    publicArtifactRisk: PUBLIC_ARTIFACT_RISK,
    expectedSha: shaBinding.expectedSha,
    checkedOutSha: shaBinding.checkedOutSha,
    shaBinding,
    serial: context.serial,
    package: context.packageName,
    reactNativeVersion: reactNativeVersion.version,
    sections: Object.fromEntries(SECTION_NAMES.map((name) => [name, PENDING_SECTION])),
  };
  if (reactNativeVersion.reason !== undefined) manifest.reactNativeVersionReason = reactNativeVersion.reason;

  // Best-effort: a manifest that cannot be written must not abort the retention it describes.
  const publish = () => {
    try {
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    } catch {
      // The collector is evidence, never a gate.
    }
  };
  const record = (name, collect) => {
    manifest.sections[name] = attempt(collect);
    publish();
    return manifest.sections[name];
  };

  publish();

  const hostApk = record("hostApk", () => collectHostApk(context));
  const installedApk = record("installedApk", () => collectInstalledApk(context, hostApk));
  const tombstones = record("tombstones", () => collectTombstones(context));
  record("packagedLibraries", () => collectPackagedLibraries(context));
  record("unstrippedReactNative", () => collectUnstrippedReactNative(
    { ...context, reactNativeVersion },
    installedApk,
    tombstones,
  ));
  manifest.sections.devClientBundle = { status: "unavailable", reason: DEV_CLIENT_BUNDLE_REASON, prefetched: false };

  manifest.status = "complete";
  publish();
  return manifest;
}

function main(args) {
  const options = parseOptions(args, [
    "--serial", "--package", "--expected-sha", "--output-dir", "--host-apk", "--gradle-cache", "--adb",
  ]);
  const root = process.cwd();
  // HOME is only a fallback for locating the Gradle cache. When it is unset the join would silently
  // produce a relative path that resolves against the repo and "finds" nothing for an untrue reason,
  // so the absence is made explicit and the AAR lookup reports it as its own unavailable reason.
  const home = process.env.HOME;
  const gradleCache = options["--gradle-cache"]
    ?? (typeof home === "string" && home.length > 0 ? join(home, GRADLE_REACT_ANDROID_CACHE) : null);
  // The serial is validated by `collectFabricDiagnostics` itself, so a refusal arrives here as a
  // throw and leaves through the same catch that keeps every other failure diagnostics-only.
  collectFabricDiagnostics({
    root,
    serial: options["--serial"],
    packageName: options["--package"],
    expectedSha: options["--expected-sha"],
    outputDir: resolve(root, options["--output-dir"] ?? ".artifacts/launch/fabric-diagnostics"),
    hostApk: options["--host-apk"] ?? "android/app/build/outputs/apk/debug/app-debug.apk",
    gradleCache,
    adbPath: options["--adb"] ?? "adb",
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    // Diagnostics are evidence, never a gate: never disturb the failure being reported.
    console.error(`Android Fabric diagnostics were not retained: ${describeError(error)}`);
  }
}
