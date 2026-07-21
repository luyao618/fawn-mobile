import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import * as ts from "typescript";
import { StyleSheet, Text, TextInput, View } from "react-native";

import type {
  TrackerCreateSummary,
  TrackerDeleteSummary,
  TrackerUpdateSummary,
} from "../../../../src/application/tracker/manualTrackerService";
import type { TrackerRecordByDomain, TrackerUpdateInputByDomain } from "../../../../src/domain/tracker/types";
import {
  createTrackerDecisionSnapshot,
  InlineTrackerConfirmation,
  type AnyTrackerDeleteDecision,
  type AnyTrackerUpdateDecision,
  type TrackerDiscardDecision,
} from "../../../../src/features/tracker/InlineTrackerConfirmation";

const PRIVATE = Object.freeze({
  createdAt: "2026-07-20T00:00:00.000Z",
  id: "private-record-id-x9",
  sourceMessageId: "private-source-id-y8",
  updatedAt: "2026-07-20T01:00:00.000Z",
});

const records = Object.freeze({
  growth: Object.freeze({
    ...PRIVATE,
    measurementDate: "2026-07-20",
    weightG: 7_200,
    heightCm: 68.5,
    headCm: 43.2,
    weightPercentile: 91.234,
    heightPercentile: 82.345,
    headPercentile: 73.456,
    notes: "完整生长备注",
  }),
  feeding: Object.freeze({
    ...PRIVATE,
    feedTime: "2026-07-20T00:10:00.000Z",
    feedType: "formula",
    amountMl: 120,
    durationMin: null,
    notes: "完整喂养备注",
  }),
  sleep: Object.freeze({
    ...PRIVATE,
    sleepStart: "2026-07-20T13:00:00.000Z",
    sleepEnd: "2026-07-20T14:00:00.000Z",
    sleepType: "night",
    nightWakings: 2,
    notes: null,
  }),
  diaper: Object.freeze({
    ...PRIVATE,
    diaperTime: "2026-07-20T01:30:00.000Z",
    diaperType: "mixed",
    notes: null,
  }),
  health: Object.freeze({
    ...PRIVATE,
    recordDate: "2026-07-20",
    recordType: "illness",
    title: "轻微咳嗽",
    description: "居家观察并记录饮水",
  }),
}) satisfies TrackerRecordByDomain;

const inputs = Object.freeze({
  growth: Object.freeze({
    measurementDate: records.growth.measurementDate,
    weightG: records.growth.weightG,
    heightCm: records.growth.heightCm,
    headCm: records.growth.headCm,
    weightPercentile: records.growth.weightPercentile,
    heightPercentile: records.growth.heightPercentile,
    headPercentile: records.growth.headPercentile,
    notes: records.growth.notes,
  }),
  feeding: Object.freeze({
    feedTime: records.feeding.feedTime,
    feedType: records.feeding.feedType,
    amountMl: records.feeding.amountMl,
    durationMin: records.feeding.durationMin,
    notes: records.feeding.notes,
  }),
  sleep: Object.freeze({
    sleepStart: records.sleep.sleepStart,
    sleepEnd: records.sleep.sleepEnd,
    sleepType: records.sleep.sleepType,
    nightWakings: records.sleep.nightWakings,
    notes: records.sleep.notes,
  }),
  diaper: Object.freeze({
    diaperTime: records.diaper.diaperTime,
    diaperType: records.diaper.diaperType,
    notes: records.diaper.notes,
  }),
  health: Object.freeze({
    recordDate: records.health.recordDate,
    recordType: records.health.recordType,
    title: records.health.title,
    description: records.health.description,
  }),
}) satisfies TrackerUpdateInputByDomain;

function refs() {
  return {
    acceptActionRef: createRef<View>(),
    cancelActionRef: createRef<View>(),
    headingRef: createRef<Text>(),
    initiatingControlRef: createRef<View>(),
  };
}

function healthDecision(prior: Readonly<{ draft: string }> = Object.freeze({ draft: "health-prior" })) {
  const decisionRefs = refs();
  const serviceSummary: TrackerCreateSummary<"health"> = Object.freeze({
    action: "create",
    domain: "health",
    input: Object.freeze({
      recordDate: "2026-07-20",
      recordType: "illness",
      title: "轻微咳嗽",
      description: "居家观察并记录饮水",
      sourceMessageId: null,
    }),
  });
  return {
    decision: createTrackerDecisionSnapshot({
      kind: "healthCreate",
      domain: "health",
      initiatingControlRef: decisionRefs.initiatingControlRef,
      presentationTimeZone: "Asia/Shanghai",
      prior,
      serviceSummary,
    }),
    refs: decisionRefs,
    serviceSummary,
  };
}

function updateFixture<TDecision extends AnyTrackerUpdateDecision>(
  decision: TDecision,
  decisionRefs: ReturnType<typeof refs>,
  serviceSummary: TDecision["serviceSummary"],
) {
  return { decision, refs: decisionRefs, serviceSummary };
}

function deleteFixture<TDecision extends AnyTrackerDeleteDecision>(
  decision: TDecision,
  decisionRefs: ReturnType<typeof refs>,
  serviceSummary: TDecision["serviceSummary"],
) {
  return { decision, refs: decisionRefs, serviceSummary };
}

function growthUpdateDecision(
  input: TrackerUpdateSummary<"growth">["input"],
  presentationTimeZone = "Asia/Shanghai",
) {
  const decisionRefs = refs();
  const prior = Object.freeze({ mode: "edit" as const, draft: "growth" });
  const serviceSummary: TrackerUpdateSummary<"growth"> = Object.freeze({
    action: "update",
    domain: "growth",
    id: records.growth.id,
    expectedUpdatedAt: records.growth.updatedAt,
    input,
  });
  return updateFixture(
    createTrackerDecisionSnapshot({
      kind: "update",
      domain: "growth",
      baseline: records.growth,
      initiatingControlRef: decisionRefs.initiatingControlRef,
      presentationTimeZone,
      prior,
      serviceSummary,
    }),
    decisionRefs,
    serviceSummary,
  );
}

function feedingUpdateDecision(
  input: TrackerUpdateSummary<"feeding">["input"],
  presentationTimeZone = "Asia/Shanghai",
) {
  const decisionRefs = refs();
  const serviceSummary: TrackerUpdateSummary<"feeding"> = Object.freeze({
    action: "update", domain: "feeding", id: records.feeding.id,
    expectedUpdatedAt: records.feeding.updatedAt, input,
  });
  return updateFixture(createTrackerDecisionSnapshot({
      kind: "update", domain: "feeding", baseline: records.feeding,
      initiatingControlRef: decisionRefs.initiatingControlRef,
      presentationTimeZone, prior: Object.freeze({ mode: "edit" as const, draft: "feeding" }),
      serviceSummary,
    }), decisionRefs, serviceSummary);
}

function sleepUpdateDecision(input: TrackerUpdateSummary<"sleep">["input"]) {
  const decisionRefs = refs();
  const serviceSummary: TrackerUpdateSummary<"sleep"> = Object.freeze({
    action: "update", domain: "sleep", id: records.sleep.id,
    expectedUpdatedAt: records.sleep.updatedAt, input,
  });
  return updateFixture(createTrackerDecisionSnapshot({
    kind: "update", domain: "sleep", baseline: records.sleep,
    initiatingControlRef: decisionRefs.initiatingControlRef, presentationTimeZone: "Asia/Shanghai",
    prior: Object.freeze({ mode: "edit" as const, draft: "sleep" }), serviceSummary,
  }), decisionRefs, serviceSummary);
}

function diaperUpdateDecision(input: TrackerUpdateSummary<"diaper">["input"]) {
  const decisionRefs = refs();
  const serviceSummary: TrackerUpdateSummary<"diaper"> = Object.freeze({
    action: "update", domain: "diaper", id: records.diaper.id,
    expectedUpdatedAt: records.diaper.updatedAt, input,
  });
  return updateFixture(createTrackerDecisionSnapshot({
    kind: "update", domain: "diaper", baseline: records.diaper,
    initiatingControlRef: decisionRefs.initiatingControlRef, presentationTimeZone: "Asia/Shanghai",
    prior: Object.freeze({ mode: "edit" as const, draft: "diaper" }), serviceSummary,
  }), decisionRefs, serviceSummary);
}

function healthUpdateDecision(input: TrackerUpdateSummary<"health">["input"]) {
  const decisionRefs = refs();
  const serviceSummary: TrackerUpdateSummary<"health"> = Object.freeze({
    action: "update", domain: "health", id: records.health.id,
    expectedUpdatedAt: records.health.updatedAt, input,
  });
  return updateFixture(createTrackerDecisionSnapshot({
    kind: "update", domain: "health", baseline: records.health,
    initiatingControlRef: decisionRefs.initiatingControlRef, presentationTimeZone: "Asia/Shanghai",
    prior: Object.freeze({ mode: "edit" as const, draft: "health" }), serviceSummary,
  }), decisionRefs, serviceSummary);
}

function growthDeleteDecision() {
  const decisionRefs = refs();
  const serviceSummary: TrackerDeleteSummary<"growth"> = Object.freeze({
    action: "delete", domain: "growth", id: records.growth.id, expectedUpdatedAt: records.growth.updatedAt,
  });
  return deleteFixture(createTrackerDecisionSnapshot({
    kind: "delete", domain: "growth", baseline: records.growth,
    initiatingControlRef: decisionRefs.initiatingControlRef, presentationTimeZone: "Asia/Shanghai",
    prior: Object.freeze({ mode: "edit" as const, draft: "growth" }), serviceSummary,
  }), decisionRefs, serviceSummary);
}

function feedingDeleteDecision(presentationTimeZone = "Asia/Shanghai") {
  const decisionRefs = refs();
  const serviceSummary: TrackerDeleteSummary<"feeding"> = Object.freeze({
    action: "delete", domain: "feeding", id: records.feeding.id, expectedUpdatedAt: records.feeding.updatedAt,
  });
  return deleteFixture(createTrackerDecisionSnapshot({
    kind: "delete", domain: "feeding", baseline: records.feeding,
    initiatingControlRef: decisionRefs.initiatingControlRef, presentationTimeZone,
    prior: Object.freeze({ mode: "edit" as const, draft: "feeding" }), serviceSummary,
  }), decisionRefs, serviceSummary);
}

function sleepDeleteDecision() {
  const decisionRefs = refs();
  const serviceSummary: TrackerDeleteSummary<"sleep"> = Object.freeze({
    action: "delete", domain: "sleep", id: records.sleep.id, expectedUpdatedAt: records.sleep.updatedAt,
  });
  return deleteFixture(createTrackerDecisionSnapshot({
    kind: "delete", domain: "sleep", baseline: records.sleep,
    initiatingControlRef: decisionRefs.initiatingControlRef, presentationTimeZone: "Asia/Shanghai",
    prior: Object.freeze({ mode: "edit" as const, draft: "sleep" }), serviceSummary,
  }), decisionRefs, serviceSummary);
}

function diaperDeleteDecision() {
  const decisionRefs = refs();
  const serviceSummary: TrackerDeleteSummary<"diaper"> = Object.freeze({
    action: "delete", domain: "diaper", id: records.diaper.id, expectedUpdatedAt: records.diaper.updatedAt,
  });
  return deleteFixture(createTrackerDecisionSnapshot({
    kind: "delete", domain: "diaper", baseline: records.diaper,
    initiatingControlRef: decisionRefs.initiatingControlRef, presentationTimeZone: "Asia/Shanghai",
    prior: Object.freeze({ mode: "edit" as const, draft: "diaper" }), serviceSummary,
  }), decisionRefs, serviceSummary);
}

function healthDeleteDecision() {
  const decisionRefs = refs();
  const serviceSummary: TrackerDeleteSummary<"health"> = Object.freeze({
    action: "delete", domain: "health", id: records.health.id, expectedUpdatedAt: records.health.updatedAt,
  });
  return deleteFixture(createTrackerDecisionSnapshot({
    kind: "delete", domain: "health", baseline: records.health,
    initiatingControlRef: decisionRefs.initiatingControlRef, presentationTimeZone: "Asia/Shanghai",
    prior: Object.freeze({ mode: "edit" as const, draft: "health" }), serviceSummary,
  }), decisionRefs, serviceSummary);
}

function textContent(children: unknown): string {
  if (Array.isArray(children)) return children.map(textContent).join("");
  return typeof children === "string" || typeof children === "number" ? String(children) : "";
}

function renderedText(view: ReturnType<typeof render>): string[] {
  return view.UNSAFE_getAllByType(Text).map((node) => textContent(node.props.children));
}

function renderDecision<T extends Parameters<typeof InlineTrackerConfirmation>[0]["decision"]>(
  decision: T,
  decisionRefs: ReturnType<typeof refs>,
  overrides: Partial<{
    busy: boolean;
    feedback: { kind: "error" | "status"; message: string };
    onAccept: jest.Mock;
    onCancel: jest.Mock;
  }> = {},
) {
  return render(
    <InlineTrackerConfirmation
      acceptActionRef={decisionRefs.acceptActionRef}
      busy={overrides.busy ?? false}
      cancelActionRef={decisionRefs.cancelActionRef}
      decision={decision}
      feedback={overrides.feedback}
      headingRef={decisionRefs.headingRef}
      onAccept={overrides.onAccept ?? jest.fn()}
      onCancel={overrides.onCancel ?? jest.fn()}
    />,
  );
}

function expectOnlyDecisionActions(view: ReturnType<typeof render>, labels: readonly string[]) {
  expect(screen.getAllByRole("button").map((button) => button.props.accessibilityLabel)).toEqual(labels);
  expect(view.UNSAFE_queryAllByType(TextInput)).toHaveLength(0);
  expect(screen.queryAllByRole("tab")).toHaveLength(0);
  expect(screen.queryAllByRole("radio")).toHaveLength(0);
  expect(screen.queryByLabelText("记录类型")).toBeNull();
  for (const workspaceText of [
    "编辑生长记录", "编辑喂养记录", "编辑睡眠记录", "编辑大小便记录", "编辑健康记录",
    "返回生长列表", "返回喂养列表", "返回睡眠列表", "返回大小便列表", "返回健康列表", "删除这条记录",
  ]) expect(screen.queryByText(workspaceText)).toBeNull();
}

test("shallow-freezes every decision envelope while preserving immutable Task 6 fact identities", () => {
  const prior = Object.freeze({ draft: "discard-prior" });
  const destination = Object.freeze({ kind: "domain", domain: "feeding" } as const);
  const decisionRefs = refs();
  const candidate: TrackerDiscardDecision<"growth", typeof prior, typeof destination> = Object.freeze({
    kind: "discard",
    domain: "growth",
    destination,
    initiatingControlRef: decisionRefs.initiatingControlRef,
    prior,
  });

  const decision = createTrackerDecisionSnapshot(candidate);
  expect(decision).toBe(candidate);
  expect(Object.isFrozen(decision)).toBe(true);
  expect(Object.isFrozen(prior)).toBe(true);
  expect(Object.isFrozen(destination)).toBe(true);
  expect(decision.prior).toBe(prior);
  expect(decision.destination).toBe(destination);
  expect(decision.initiatingControlRef).toBe(decisionRefs.initiatingControlRef);

  const healthPrior = Object.freeze({ draft: "health-prior" });
  const health = healthDecision(healthPrior);
  expect(Object.isFrozen(health.decision)).toBe(true);
  expect(Object.isFrozen(health.serviceSummary)).toBe(true);
  expect(Object.isFrozen(health.serviceSummary.input)).toBe(true);
  expect(health.decision.prior).toBe(healthPrior);
  expect(health.decision.serviceSummary).toBe(health.serviceSummary);
  expect(health.decision.serviceSummary.input).toBe(health.serviceSummary.input);
  expect(health.decision.initiatingControlRef).toBe(health.refs.initiatingControlRef);

  const updateRefs = refs();
  const updatePrior = Object.freeze({ mode: "edit" as const, draft: "growth" });
  const updateInput = Object.freeze({ ...inputs.growth, weightG: 7_300 });
  const updateSummary: TrackerUpdateSummary<"growth"> = Object.freeze({
    action: "update", domain: "growth", id: records.growth.id,
    expectedUpdatedAt: records.growth.updatedAt, input: updateInput,
  });
  const updateCandidate = {
    kind: "update" as const, domain: "growth" as const, baseline: records.growth,
    initiatingControlRef: updateRefs.initiatingControlRef, presentationTimeZone: "Asia/Shanghai",
    prior: updatePrior, serviceSummary: updateSummary,
  };
  const update = createTrackerDecisionSnapshot(updateCandidate);
  expect(update).toBe(updateCandidate);
  expect(Object.isFrozen(update)).toBe(true);
  expect(Object.isFrozen(updatePrior)).toBe(true);
  expect(Object.isFrozen(updateSummary)).toBe(true);
  expect(Object.isFrozen(updateInput)).toBe(true);
  expect(Object.isFrozen(records.growth)).toBe(true);
  expect(update.prior).toBe(updatePrior);
  expect(update.serviceSummary).toBe(updateSummary);
  expect(update.serviceSummary.input).toBe(updateInput);
  expect(update.baseline).toBe(records.growth);
  expect(update.initiatingControlRef).toBe(updateRefs.initiatingControlRef);

  const deleteRefs = refs();
  const deletePrior = Object.freeze({ mode: "edit" as const, draft: "health" });
  const deleteSummary: TrackerDeleteSummary<"health"> = Object.freeze({
    action: "delete", domain: "health", id: records.health.id, expectedUpdatedAt: records.health.updatedAt,
  });
  const deleteCandidate = {
    kind: "delete" as const, domain: "health" as const, baseline: records.health,
    initiatingControlRef: deleteRefs.initiatingControlRef, presentationTimeZone: "Asia/Shanghai",
    prior: deletePrior, serviceSummary: deleteSummary,
  };
  const deletion = createTrackerDecisionSnapshot(deleteCandidate);
  expect(deletion).toBe(deleteCandidate);
  expect(Object.isFrozen(deletion)).toBe(true);
  expect(Object.isFrozen(deletePrior)).toBe(true);
  expect(Object.isFrozen(deleteSummary)).toBe(true);
  expect(Object.isFrozen(records.health)).toBe(true);
  expect(deletion.prior).toBe(deletePrior);
  expect(deletion.serviceSummary).toBe(deleteSummary);
  expect(deletion.baseline).toBe(records.health);
  expect(deletion.initiatingControlRef).toBe(deleteRefs.initiatingControlRef);
});

test("mapped decision factory accepts correlated literals and rejects each independent type hole", () => {
  const fixturePath = `${process.cwd()}/__tracker_decision_typecheck__.tsx`;
  const source = `
    import type { View } from "react-native";
    import type { TrackerCreateSummary, TrackerUpdateSummary, TrackerDeleteSummary } from "./src/application/tracker/manualTrackerService";
    import type { TrackerDomain, TrackerRecordByDomain } from "./src/domain/tracker/types";
    import { createTrackerDecisionSnapshot } from "./src/features/tracker/InlineTrackerConfirmation";
    import type { TrackerFocusRef } from "./src/features/tracker/trackerAccessibility";
    declare const ref: TrackerFocusRef<View>;
    declare const growth: TrackerRecordByDomain["growth"];
    declare const feeding: TrackerRecordByDomain["feeding"];
    declare const growthUpdate: TrackerUpdateSummary<"growth">;
    declare const feedingUpdate: TrackerUpdateSummary<"feeding">;
    declare const growthDelete: TrackerDeleteSummary<"growth">;
    declare const diaperDelete: TrackerDeleteSummary<"diaper">;
    declare const healthCreate: TrackerCreateSummary<"health">;
    declare const widenedDomain: TrackerDomain;
    createTrackerDecisionSnapshot({ kind: "healthCreate", domain: "health", prior: {}, initiatingControlRef: ref, serviceSummary: healthCreate, presentationTimeZone: "UTC" });
    createTrackerDecisionSnapshot({ kind: "update", domain: "growth", prior: {}, initiatingControlRef: ref, serviceSummary: growthUpdate, baseline: growth, presentationTimeZone: "UTC" });
    createTrackerDecisionSnapshot({ kind: "delete", domain: "growth", prior: {}, initiatingControlRef: ref, serviceSummary: growthDelete, baseline: growth, presentationTimeZone: "UTC" });
    createTrackerDecisionSnapshot({ kind: "discard", domain: "growth", prior: {}, initiatingControlRef: ref, destination: {}, });
    // @ts-expect-error foreign summary must not match the envelope domain
    createTrackerDecisionSnapshot({ kind: "update", domain: "growth", prior: {}, initiatingControlRef: ref, serviceSummary: feedingUpdate, baseline: growth, presentationTimeZone: "UTC" });
    // @ts-expect-error same-domain summary cannot be paired with a foreign baseline
    createTrackerDecisionSnapshot({ kind: "update", domain: "growth", prior: {}, initiatingControlRef: ref, serviceSummary: growthUpdate, baseline: feeding, presentationTimeZone: "UTC" });
    // @ts-expect-error foreign delete summary must not match the envelope domain
    createTrackerDecisionSnapshot({ kind: "delete", domain: "growth", prior: {}, initiatingControlRef: ref, serviceSummary: diaperDelete, baseline: growth, presentationTimeZone: "UTC" });
    // @ts-expect-error same-domain delete summary cannot be paired with a foreign baseline
    createTrackerDecisionSnapshot({ kind: "delete", domain: "growth", prior: {}, initiatingControlRef: ref, serviceSummary: growthDelete, baseline: feeding, presentationTimeZone: "UTC" });
    // @ts-expect-error health-create envelopes require the health domain
    createTrackerDecisionSnapshot({ kind: "healthCreate", domain: "growth", prior: {}, initiatingControlRef: ref, serviceSummary: healthCreate, presentationTimeZone: "UTC" });
    // @ts-expect-error Task 6 must narrow a widened domain before constructing a decision
    createTrackerDecisionSnapshot({ kind: "update", domain: widenedDomain, prior: {}, initiatingControlRef: ref, serviceSummary: growthUpdate, baseline: growth, presentationTimeZone: "UTC" });
  `;
  const config = ts.readConfigFile(`${process.cwd()}/tsconfig.json`, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd());
  const host = ts.createCompilerHost(parsed.options);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  host.fileExists = (fileName) => fileName === fixturePath || originalFileExists(fileName);
  host.readFile = (fileName) => fileName === fixturePath ? source : originalReadFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => (
    fileName === fixturePath
      ? ts.createSourceFile(fileName, source, languageVersion, true, ts.ScriptKind.TSX)
      : originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile)
  );
  const program = ts.createProgram([fixturePath], { ...parsed.options, noEmit: true }, host);
  const diagnostics = ts.getPreEmitDiagnostics(program).filter((diagnostic) => diagnostic.file?.fileName === fixturePath);

  expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
});

test("renders the exact normalized health-create content, privacy notice, consequence, refs, and actions", () => {
  const { decision, refs: decisionRefs } = healthDecision();
  const onAccept = jest.fn();
  const onCancel = jest.fn();
  const view = renderDecision(decision, decisionRefs, { onAccept, onCancel });

  expect(renderedText(view)).toEqual([
    "确认新增健康记录",
    "记录日期", "2026年7月20日",
    "健康记录类型", "身体不适",
    "标题", "轻微咳嗽",
    "说明", "居家观察并记录饮水",
    "健康记录用于整理照护信息，不提供诊断。",
    "确认后会保存在本机。",
    "返回修改", "确认保存",
  ]);
  expect(screen.getAllByRole("button").map((button) => button.props.accessibilityLabel)).toEqual(["返回修改", "确认保存"]);
  expect(screen.getByRole("header", { name: "确认新增健康记录" })).toBeTruthy();
  expect(decisionRefs.headingRef.current).not.toBeNull();
  expect(decisionRefs.cancelActionRef.current).not.toBeNull();
  expect(decisionRefs.acceptActionRef.current).not.toBeNull();
  const mountedRefs = {
    accept: decisionRefs.acceptActionRef.current,
    cancel: decisionRefs.cancelActionRef.current,
    heading: decisionRefs.headingRef.current,
  };
  view.rerender(
    <InlineTrackerConfirmation
      acceptActionRef={decisionRefs.acceptActionRef}
      busy={false}
      cancelActionRef={decisionRefs.cancelActionRef}
      decision={decision}
      headingRef={decisionRefs.headingRef}
      onAccept={onAccept}
      onCancel={onCancel}
    />,
  );
  expect(decisionRefs.headingRef.current).toBe(mountedRefs.heading);
  expect(decisionRefs.cancelActionRef.current).toBe(mountedRefs.cancel);
  expect(decisionRefs.acceptActionRef.current).toBe(mountedRefs.accept);
  expectOnlyDecisionActions(view, ["返回修改", "确认保存"]);

  fireEvent.press(screen.getByRole("button", { name: "返回修改" }));
  fireEvent.press(screen.getByRole("button", { name: "确认保存" }));
  expect(onCancel).toHaveBeenCalledWith(decision);
  expect(onAccept).toHaveBeenCalledWith(decision);
  expect(onCancel.mock.calls[0]![0]).toBe(decision);
  expect(onAccept.mock.calls[0]![0]).toBe(decision);
});

test.each([
  {
    name: "growth",
    make: () => growthUpdateDecision(Object.freeze({ ...inputs.growth, weightG: 7_300, notes: null })),
    identifying: "2026年7月20日",
    changed: ["体重（克）", "7200 克", "7300 克", "备注", "完整生长备注", "未填写"],
  },
  {
    name: "feeding",
    make: () => feedingUpdateDecision(Object.freeze({ ...inputs.feeding, feedType: "solid", amountMl: null })),
    identifying: "2026年7月20日 08:10（本机时间）",
    changed: ["喂养类型", "配方奶", "辅食", "量（毫升）", "120 毫升", "未填写"],
  },
  {
    name: "sleep",
    make: () => sleepUpdateDecision(Object.freeze({ ...inputs.sleep, sleepType: "nap", nightWakings: 0 })),
    identifying: "2026年7月20日 21:00（本机时间）",
    changed: ["睡眠类型", "夜间睡眠", "小睡", "夜醒次数", "2 次", "0 次"],
  },
  {
    name: "diaper",
    make: () => diaperUpdateDecision(Object.freeze({ ...inputs.diaper, diaperType: "pee", notes: "皮肤正常" })),
    identifying: "2026年7月20日 09:30（本机时间）",
    changed: ["类型", "混合", "小便", "备注", "未填写", "皮肤正常"],
  },
  {
    name: "health",
    make: () => healthUpdateDecision(Object.freeze({ ...inputs.health, title: "复查", description: null })),
    identifying: "2026年7月20日",
    changed: ["标题", "轻微咳嗽", "复查", "说明", "居家观察并记录饮水", "未填写"],
  },
])("renders only visible $name changes with baseline identity and the captured zone", ({ make, identifying, changed }) => {
  const current = make();
  const view = renderDecision(current.decision, current.refs);
  const exactChanges = changed.flatMap((_, index) => index % 3 === 0
    ? [changed[index]!, "原内容", changed[index + 1]!, "新内容", changed[index + 2]!]
    : []);
  expect(renderedText(view)).toEqual([
    "确认保存修改", identifying, "修改内容", ...exactChanges, "返回修改", "确认保存",
  ]);
  expect(screen.getByRole("header", { name: "修改内容" })).toBeTruthy();
  expectOnlyDecisionActions(view, ["返回修改", "确认保存"]);
  const serialized = JSON.stringify(view.toJSON());
  for (const hidden of [
    PRIVATE.id,
    PRIVATE.sourceMessageId,
    PRIVATE.createdAt,
    PRIVATE.updatedAt,
    "91.234", "82.345", "73.456",
    "weightPercentile", "sourceMessageId", "expectedUpdatedAt", "feedTime", "sleepStart", "diaperTime",
  ]) expect(serialized).not.toContain(hidden);
});

test.each([
  { name: "growth", make: growthDeleteDecision, label: "生长", primary: "2026年7月20日", secondary: "体重 7200 克 · 身长 68.5 厘米 · 头围 43.2 厘米 · 有备注" },
  { name: "feeding", make: feedingDeleteDecision, label: "喂养", primary: "2026年7月20日 08:10（本机时间）", secondary: "配方奶 · 量 120 毫升 · 有备注" },
  { name: "sleep", make: sleepDeleteDecision, label: "睡眠", primary: "2026年7月20日 21:00（本机时间）", secondary: "夜间睡眠 · 至 2026年7月20日 22:00（本机时间） · 夜醒 2 次" },
  { name: "diaper", make: diaperDeleteDecision, label: "大小便", primary: "2026年7月20日 09:30（本机时间）", secondary: "混合" },
  { name: "health", make: healthDeleteDecision, label: "健康", primary: "2026年7月20日", secondary: "身体不适 · 轻微咳嗽 · 有说明" },
])("renders the exact structured $name delete summary and soft-delete-safe wording", ({ make, label, primary, secondary }) => {
  const current = make();
  const view = renderDecision(current.decision, current.refs);

  expect(renderedText(view)).toEqual([
    `确认删除这条${label}记录`,
    primary,
    secondary,
    "删除后不会出现在记录列表中；当前版本没有恢复入口。",
    "取消",
    "确认删除",
  ]);
  expect(screen.getAllByRole("button").map((button) => button.props.accessibilityLabel)).toEqual(["取消", "确认删除"]);
  const serialized = JSON.stringify(view.toJSON());
  expect(serialized).not.toMatch(/永久|物理删除|彻底删除/);
});

test("preserves discard prior, ref, and destination identity and returns the exact decision", () => {
  const prior = Object.freeze({ draft: Object.freeze({ title: "未保存内容" }) });
  const destination = Object.freeze({ kind: "reloadRecord", domain: "health", id: "destination-id" } as const);
  const decisionRefs = refs();
  const decision = createTrackerDecisionSnapshot({
    kind: "discard",
    domain: "health",
    prior,
    destination,
    initiatingControlRef: decisionRefs.initiatingControlRef,
  });
  const onAccept = jest.fn();
  const onCancel = jest.fn();
  const view = renderDecision(decision, decisionRefs, { onAccept, onCancel });

  expect(renderedText(view)).toEqual([
    "放弃未保存的更改？",
    "当前填写的内容还没有保存。",
    "继续编辑",
    "放弃更改",
  ]);
  fireEvent.press(screen.getByRole("button", { name: "继续编辑" }));
  fireEvent.press(screen.getByRole("button", { name: "放弃更改" }));
  expect(onCancel.mock.calls[0]![0]).toBe(decision);
  expect(onAccept.mock.calls[0]![0]).toBe(decision);
  expect(decision.prior).toBe(prior);
  expect(decision.destination).toBe(destination);
  expect(decision.initiatingControlRef).toBe(decisionRefs.initiatingControlRef);
  expectOnlyDecisionActions(view, ["继续编辑", "放弃更改"]);
});

test.each([
  { name: "health", make: healthDecision, cancel: "返回修改", accept: "确认保存" },
  {
    name: "update",
    make: () => healthUpdateDecision(Object.freeze({ ...inputs.health, title: "复查" })),
    cancel: "返回修改",
    accept: "确认保存",
  },
  { name: "delete", make: healthDeleteDecision, cancel: "取消", accept: "确认删除" },
  {
    name: "discard",
    make: () => {
      const decisionRefs = refs();
      return {
        decision: createTrackerDecisionSnapshot({
          kind: "discard" as const,
          domain: "health" as const,
          prior: Object.freeze({ draft: "discard" }),
          destination: Object.freeze({ kind: "list" as const, domain: "health" as const }),
          initiatingControlRef: decisionRefs.initiatingControlRef,
        }),
        refs: decisionRefs,
      };
    },
    cancel: "继续编辑",
    accept: "放弃更改",
  },
])("returns exact $name decision identity for cancel and accept", ({ make, cancel, accept }) => {
  const current = make();
  const onAccept = jest.fn();
  const onCancel = jest.fn();
  const view = renderDecision(current.decision, current.refs, { onAccept, onCancel });
  fireEvent.press(screen.getByRole("button", { name: cancel }));
  fireEvent.press(screen.getByRole("button", { name: accept }));
  expect(onCancel.mock.calls[0]![0]).toBe(current.decision);
  expect(onAccept.mock.calls[0]![0]).toBe(current.decision);
  expectOnlyDecisionActions(view, [cancel, accept]);
});

test.each([
  { name: "health", make: healthDecision },
  { name: "update", make: () => healthUpdateDecision(Object.freeze({ ...inputs.health, title: "复查" })) },
  { name: "delete", make: healthDeleteDecision },
  {
    name: "discard",
    make: () => {
      const decisionRefs = refs();
      return {
        decision: createTrackerDecisionSnapshot({
          kind: "discard" as const, domain: "health" as const,
          prior: Object.freeze({ draft: "discard" }), destination: Object.freeze({ kind: "list" as const }),
          initiatingControlRef: decisionRefs.initiatingControlRef,
        }),
        refs: decisionRefs,
      };
    },
  },
])("busy suppresses both $name decision callbacks", ({ make }) => {
  const current = make();
  const onAccept = jest.fn();
  const onCancel = jest.fn();
  renderDecision(current.decision, current.refs, { busy: true, onAccept, onCancel });
  const busyActions = screen.getAllByRole("button");
  expect(busyActions).toHaveLength(2);
  expect(busyActions.map((action) => action.props.accessibilityState)).toEqual(
    Array.from({ length: 2 }, () => ({ busy: true, disabled: true })),
  );
  fireEvent.press(busyActions[0]!);
  fireEvent.press(busyActions[1]!);
  expect(onCancel).not.toHaveBeenCalled();
  expect(onAccept).not.toHaveBeenCalled();
});

test("error feedback is assertive alert and status feedback is polite", () => {
  const current = healthDecision();
  const view = renderDecision(current.decision, current.refs, {
    feedback: { kind: "error", message: "保存失败，本机记录没有更改。" },
  });
  expect(screen.getByText("保存失败，本机记录没有更改。").props).toMatchObject({
    accessibilityLiveRegion: "assertive",
    accessibilityRole: "alert",
  });

  view.rerender(
    <InlineTrackerConfirmation
      acceptActionRef={current.refs.acceptActionRef}
      busy={false}
      cancelActionRef={current.refs.cancelActionRef}
      decision={current.decision}
      feedback={{ kind: "status", message: "正在保存健康记录…" }}
      headingRef={current.refs.headingRef}
      onAccept={jest.fn()}
      onCancel={jest.fn()}
    />,
  );
  expect(screen.getByText("正在保存健康记录…").props).toMatchObject({ accessibilityLiveRegion: "polite" });
  expect(screen.getByText("正在保存健康记录…").props.accessibilityRole).not.toBe("alert");
});

function withCorruptedDecision<T extends Readonly<{ decision: object }>>(
  current: T,
  patch: Readonly<Record<string, unknown>>,
) {
  return { ...current, decision: Object.freeze({ ...current.decision, ...patch }) as never };
}

test.each([
  {
    name: "update invalid zone",
    title: "确认保存修改",
    cancel: "返回修改",
    expected: "无法确认本机时区，暂不能显示或编辑这类记录。",
    make: () => feedingUpdateDecision(Object.freeze({ ...inputs.feeding, amountMl: 130 }), "Private/Invalid-Zone"),
  },
  {
    name: "delete invalid zone",
    title: "确认删除这条喂养记录",
    cancel: "取消",
    expected: "无法确认本机时区，暂不能显示或编辑这类记录。",
    make: () => feedingDeleteDecision("Private/Invalid-Zone"),
  },
  {
    name: "health create action",
    title: "确认新增健康记录",
    cancel: "返回修改",
    expected: "暂时无法显示确认内容。本机数据没有更改。",
    make: () => {
      const current = healthDecision();
      return withCorruptedDecision(current, {
        serviceSummary: Object.freeze({ ...current.serviceSummary, action: "update" }),
      });
    },
  },
  {
    name: "health create domain",
    title: "确认新增健康记录",
    cancel: "返回修改",
    expected: "暂时无法显示确认内容。本机数据没有更改。",
    make: () => {
      const current = healthDecision();
      return withCorruptedDecision(current, {
        serviceSummary: Object.freeze({ ...current.serviceSummary, domain: "growth" }),
      });
    },
  },
  {
    name: "health create input",
    title: "确认新增健康记录",
    cancel: "返回修改",
    expected: "暂时无法显示确认内容。本机数据没有更改。",
    make: () => {
      const current = healthDecision();
      return withCorruptedDecision(current, {
        serviceSummary: Object.freeze({
          ...current.serviceSummary,
          input: Object.freeze({ ...current.serviceSummary.input, title: "" }),
        }),
      });
    },
  },
  {
    name: "health update action",
    title: "确认保存修改",
    cancel: "返回修改",
    expected: "暂时无法显示确认内容。本机数据没有更改。",
    make: () => {
      const current = healthUpdateDecision(Object.freeze({ ...inputs.health, title: "复查" }));
      return withCorruptedDecision(current, {
        serviceSummary: Object.freeze({ ...current.serviceSummary, action: "create" }),
      });
    },
  },
  {
    name: "health update domain",
    title: "确认保存修改",
    cancel: "返回修改",
    expected: "暂时无法显示确认内容。本机数据没有更改。",
    make: () => {
      const current = healthUpdateDecision(Object.freeze({ ...inputs.health, title: "复查" }));
      return withCorruptedDecision(current, {
        serviceSummary: Object.freeze({ ...current.serviceSummary, domain: "growth" }),
      });
    },
  },
  {
    name: "health update input",
    title: "确认保存修改",
    cancel: "返回修改",
    expected: "暂时无法显示确认内容。本机数据没有更改。",
    make: () => healthUpdateDecision(Object.freeze({ ...inputs.health, recordDate: "private-bad-date" })),
  },
  {
    name: "health update ID",
    title: "确认保存修改",
    cancel: "返回修改",
    expected: "暂时无法显示确认内容。本机数据没有更改。",
    make: () => {
      const current = healthUpdateDecision(Object.freeze({ ...inputs.health, title: "复查" }));
      return withCorruptedDecision(current, {
        serviceSummary: Object.freeze({ ...current.serviceSummary, id: "other-private-id" }),
      });
    },
  },
  {
    name: "health update revision",
    title: "确认保存修改",
    cancel: "返回修改",
    expected: "暂时无法显示确认内容。本机数据没有更改。",
    make: () => {
      const current = healthUpdateDecision(Object.freeze({ ...inputs.health, title: "复查" }));
      return withCorruptedDecision(current, {
        serviceSummary: Object.freeze({ ...current.serviceSummary, expectedUpdatedAt: "2026-07-20T02:00:00.000Z" }),
      });
    },
  },
  {
    name: "health delete action",
    title: "确认删除这条健康记录",
    cancel: "取消",
    expected: "暂时无法显示确认内容。本机数据没有更改。",
    make: () => {
      const current = healthDeleteDecision();
      return withCorruptedDecision(current, {
        serviceSummary: Object.freeze({ ...current.serviceSummary, action: "update" }),
      });
    },
  },
  {
    name: "health delete domain",
    title: "确认删除这条健康记录",
    cancel: "取消",
    expected: "暂时无法显示确认内容。本机数据没有更改。",
    make: () => {
      const current = healthDeleteDecision();
      return withCorruptedDecision(current, {
        serviceSummary: Object.freeze({ ...current.serviceSummary, domain: "growth" }),
      });
    },
  },
  {
    name: "health delete ID",
    title: "确认删除这条健康记录",
    cancel: "取消",
    expected: "暂时无法显示确认内容。本机数据没有更改。",
    make: () => {
      const current = healthDeleteDecision();
      return withCorruptedDecision(current, {
        serviceSummary: Object.freeze({ ...current.serviceSummary, id: "other-private-id" }),
      });
    },
  },
  {
    name: "health delete revision",
    title: "确认删除这条健康记录",
    cancel: "取消",
    expected: "暂时无法显示确认内容。本机数据没有更改。",
    make: () => {
      const current = healthDeleteDecision();
      return withCorruptedDecision(current, {
        serviceSummary: Object.freeze({ ...current.serviceSummary, expectedUpdatedAt: "2026-07-20T02:00:00.000Z" }),
      });
    },
  },
  {
    name: "health delete baseline value",
    title: "确认删除这条健康记录",
    cancel: "取消",
    expected: "暂时无法显示确认内容。本机数据没有更改。",
    make: () => withCorruptedDecision(healthDeleteDecision(), {
      baseline: Object.freeze({ ...records.health, recordDate: "private-bad-date" }),
    }),
  },
  {
    name: "unsupported outer kind",
    title: "确认记录操作",
    cancel: "返回修改",
    expected: "暂时无法显示确认内容。本机数据没有更改。",
    make: () => withCorruptedDecision(healthDecision(), { kind: "private-unsupported-kind" }),
  },
  {
    name: "unsupported outer domain",
    title: "确认记录操作",
    cancel: "返回修改",
    expected: "暂时无法显示确认内容。本机数据没有更改。",
    make: () => withCorruptedDecision(healthDecision(), { domain: "private-unsupported-domain" }),
  },
])("fails closed for $name without partial, raw, or accept content", ({ title, cancel, expected, make }) => {
  const current = make();
  const onAccept = jest.fn();
  const view = renderDecision(current.decision, current.refs, { onAccept });

  expect(screen.getByText(expected).props).toMatchObject({ accessibilityLiveRegion: "assertive", accessibilityRole: "alert" });
  expect(renderedText(view)).toEqual([title, expected, cancel]);
  expectOnlyDecisionActions(view, [cancel]);
  fireEvent.press(screen.getAllByRole("button")[0]!);
  expect(onAccept).not.toHaveBeenCalled();
  const serialized = JSON.stringify(view.toJSON());
  for (const privateValue of [
    "Private/Invalid-Zone", "private-bad-date", "other-private-id", PRIVATE.id, PRIVATE.updatedAt, PRIVATE.createdAt,
    PRIVATE.sourceMessageId, records.health.title, records.health.description, records.growth.notes,
    records.feeding.notes, "2026-07-20T00:10:00.000Z", "2026-07-20T13:00:00.000Z",
    "91.234", "weightPercentile", "expectedUpdatedAt", "sourceMessageId", "recordDate", "description",
  ]) expect(serialized).not.toContain(privateValue);
});

test.each([
  { name: "growth", make: () => growthUpdateDecision(inputs.growth), identifying: "2026年7月20日" },
  { name: "feeding", make: () => feedingUpdateDecision(inputs.feeding), identifying: "2026年7月20日 08:10（本机时间）" },
  { name: "sleep", make: () => sleepUpdateDecision(inputs.sleep), identifying: "2026年7月20日 21:00（本机时间）" },
  { name: "diaper", make: () => diaperUpdateDecision(inputs.diaper), identifying: "2026年7月20日 09:30（本机时间）" },
  { name: "health", make: () => healthUpdateDecision(inputs.health), identifying: "2026年7月20日" },
])("a zero-diff $name update exposes only the return action and never accepts", ({ make, identifying }) => {
  const current = make();
  const onAccept = jest.fn();
  const view = renderDecision(current.decision, current.refs, { onAccept });

  expect(renderedText(view)).toEqual([
    "确认保存修改",
    identifying,
    "内容没有更改。",
    "返回修改",
  ]);
  expectOnlyDecisionActions(view, ["返回修改"]);
  fireEvent.press(screen.getByRole("button", { name: "返回修改" }));
  expect(onAccept).not.toHaveBeenCalled();
  const serialized = JSON.stringify(view.toJSON());
  expect(serialized).toContain(identifying);
  for (const privateValue of [
    PRIVATE.id, PRIVATE.sourceMessageId, PRIVATE.createdAt, PRIVATE.updatedAt,
    records.growth.notes, records.feeding.notes, records.health.title, records.health.description,
    "91.234", "82.345", "73.456", "serviceSummary", "baseline",
    "presentationTimeZone", "expectedUpdatedAt", "sourceMessageId",
  ]) expect(serialized).not.toContain(privateValue);
});

test("persists Task 5 semantic, scalable, minimum-action, style, ownership, and import boundaries", () => {
  const current = healthUpdateDecision(Object.freeze({ ...inputs.health, title: "复查" }));
  const view = renderDecision(current.decision, current.refs);
  expect(screen.getByRole("header", { name: "确认保存修改" })).toBeTruthy();
  expect(screen.getByRole("header", { name: "修改内容" })).toBeTruthy();
  for (const text of view.UNSAFE_getAllByType(Text)) {
    expect(text.props.allowFontScaling).not.toBe(false);
    expect(text.props.numberOfLines).toBeUndefined();
    expect(StyleSheet.flatten(text.props.style)?.lineHeight).toBeUndefined();
  }
  for (const action of screen.getAllByRole("button")) {
    expect(StyleSheet.flatten(action.props.style)?.minHeight).toBeGreaterThanOrEqual(44);
  }

  const root = process.cwd();
  const paths = [
    "src/features/tracker/InlineTrackerConfirmation.tsx",
    "src/features/tracker/trackerAccessibility.ts",
  ];
  const sources = paths.map((path) => ({ path, source: readFileSync(join(root, path), "utf8") }));
  const source = sources.map(({ source: contents }) => contents).join("\n");
  expect(source).not.toMatch(/\b(?:Alert|Modal|useEffect|useLayoutEffect|useReducer|fetch|XMLHttpRequest|WebSocket)\b/);
  expect(source).not.toMatch(/numberOfLines|ellipsizeMode|lineHeight|allowFontScaling=\{false\}|position:\s*["']absolute|bottom:\s*\d/);
  expect(source).not.toMatch(/(?:^|[,{]\s*)height:\s*\d/m);
  expect(source).not.toMatch(/\bchildren\s*[?:]:|\b(?:service|trackerService)\.(?:create|update|delete|list|getById)\s*\(/);
  expect(source).not.toMatch(/(?:^|\/)infrastructure(?:\/|$)|(?:^|[\/:@.-])(?:network|profile)(?:[\/:@.-]|$)/i);

  const referencedModulePaths = (contents: string) => [
    ...contents.matchAll(/\bfrom\s+["']([^"']+)["']/g),
    ...contents.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
    ...contents.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
  ].map((match) => match[1]!);
  expect(sources[0]!.source).toMatch(/import type \{[\s\S]*TrackerCreateSummary[\s\S]*\} from "\.\.\/\.\.\/application\/tracker\/manualTrackerService";/);
  for (const entry of sources) {
    for (const importPath of referencedModulePaths(entry.source)) {
      if (!importPath.startsWith(".")) continue;
      const resolvedPath = relative(root, resolve(dirname(join(root, entry.path)), importPath)).replaceAll("\\", "/");
      expect(resolvedPath).toMatch(/^src\/(?:application\/tracker\/manualTrackerService|domain\/tracker\/(?:types|validation)|shared|features\/tracker)(?:\.|\/|$)/);
    }
  }
});
