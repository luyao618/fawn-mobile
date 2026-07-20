import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { Text, TextInput, View } from "react-native";
import { useFocusEffect } from "@react-navigation/native";

import type { TrackerDomain, TrackerRecordByDomain } from "../../domain/tracker/types";
import { normalizePersistedTrackerRecord, TrackerValidationError } from "../../domain/tracker/validation";
import { colors, spacing } from "../../shared/theme/tokens";
import { AppFrame } from "../../shared/ui/AppFrame";
import { focusRefIfAvailable } from "./trackerAccessibility";
import {
  createInitialDraft,
  parseDraftToCreateInput,
  recordToEditorDraft,
  type TrackerEditorDraftByDomain,
} from "./trackerEditorModel";
import { captureDeviceTimeZone } from "./trackerLocalTime";
import { useManualTrackerService } from "./ManualTrackerServiceContext";
import {
  type AnyEditorSnapshot,
  type AnyListFact,
  type CreateEditorSnapshot,
  type DomainAction,
  type DomainRows,
  type EditEditorSnapshot,
  type ListFact,
  type GlobalTrackerScreenAction,
  type OperationOwner,
  type ReadOwner,
  type TrackerScreenAction,
  type TrackerScreenState,
  correlatedAction,
  sameOperationOwner,
  sameReadOwner,
  stateDomain,
  trackerScreenReducer,
} from "./trackerScreenState";
import { TrackerDomainSwitcher, TRACKER_DOMAIN_LABELS } from "./TrackerDomainSwitcher";
import {
  TrackerEditor,
  type TrackerGroupRefs,
  type TrackerInputRefs,
} from "./TrackerEditor";
import { PrimaryAction, SecondaryAction } from "./TrackerFormPrimitives";
import { TrackerRecordList } from "./TrackerRecordList";

const EMPTY_GROWTH_ROWS: DomainRows<"growth"> = Object.freeze([]);
const READ_FAILURE = "暂时无法读取这条记录。本机数据没有更改。";
const SAVE_FAILURE = "保存失败，本机记录没有更改。";

type FocusField = keyof TrackerInputRefs | keyof TrackerGroupRefs;
type LowRiskDomain = Exclude<TrackerDomain, "health">;

function freezeListFact<D extends TrackerDomain>(
  domain: D,
  rows: DomainRows<D>,
  presentationZone: string,
): ListFact<D> {
  return Object.freeze({ domain, rows, presentationZone });
}

function initialState(): TrackerScreenState {
  const prior = freezeListFact("growth", EMPTY_GROWTH_ROWS, "");
  return Object.freeze({
    tag: "list.loading",
    source: "ordinary",
    owner: Object.freeze({
      mountEpoch: 0,
      generation: 0,
      domain: "growth",
      focusSession: 0,
      kind: "list",
      recordId: undefined,
    }),
    prior,
  });
}

function stateListFact(state: TrackerScreenState): AnyListFact {
  switch (state.tag) {
    case "list.loading": return state.prior;
    case "list.ready.empty":
    case "list.ready.rows":
    case "list.error": return state.fact;
    case "create.editing":
    case "edit.editing": return state.editor.prior;
    case "edit.loading":
    case "edit.error": return state.prior;
    case "read.suspended": return state.request.prior;
    case "mutation.submitting": return state.prior.prior;
  }
}

function stateEditor(state: TrackerScreenState): AnyEditorSnapshot | null {
  if (state.tag === "create.editing" || state.tag === "edit.editing") return state.editor;
  if (state.tag === "mutation.submitting") return state.prior;
  return null;
}

function freezeDraft<D extends TrackerDomain>(
  draft: TrackerEditorDraftByDomain[D],
): TrackerEditorDraftByDomain[D] {
  return Object.freeze({ ...draft }) as TrackerEditorDraftByDomain[D];
}

function createSnapshot<D extends TrackerDomain>(
  domain: D,
  draft: TrackerEditorDraftByDomain[D],
  capturedZone: string,
  prior: ListFact<D>,
): CreateEditorSnapshot<D> {
  return Object.freeze({
    mode: "create",
    domain,
    draft: freezeDraft(draft),
    initialDraft: freezeDraft(draft),
    baseline: null,
    capturedZone,
    errors: Object.freeze({}),
    prior,
  });
}

function editSnapshot<D extends TrackerDomain>(
  domain: D,
  draft: TrackerEditorDraftByDomain[D],
  baseline: TrackerRecordByDomain[D],
  capturedZone: string,
  prior: ListFact<D>,
): EditEditorSnapshot<D> {
  return Object.freeze({
    mode: "edit",
    domain,
    draft: freezeDraft(draft),
    initialDraft: freezeDraft(draft),
    baseline,
    capturedZone,
    errors: Object.freeze({}),
    prior,
  });
}

function validRowsForDomain<D extends TrackerDomain>(
  domain: D,
  value: unknown,
): value is DomainRows<D> {
  if (!Array.isArray(value)) return false;
  try {
    for (const row of value) normalizePersistedTrackerRecord(domain, row);
    return true;
  } catch {
    return false;
  }
}

function validRecordForDomain<D extends TrackerDomain>(
  domain: D,
  id: string,
  value: unknown,
): value is TrackerRecordByDomain[D] {
  if (value === null || typeof value !== "object") return false;
  try {
    const normalized = normalizePersistedTrackerRecord(domain, value as TrackerRecordByDomain[D]);
    return normalized.id === id;
  } catch {
    return false;
  }
}

function serviceValidationFailure(error: TrackerValidationError): Readonly<{ field: string; message: string }> {
  const messages: Readonly<Record<string, string>> = Object.freeze({
    measurements: "体重、身长、头围请至少填写一项。",
    amountMl: "配方奶需要填写量。",
    durationMin: "母乳需要填写时长。",
    sleepEnd: "结束时间需要晚于开始时间。",
    title: "标题需要填写，且最多 200 个字符。",
  });
  const knownFields = new Set([
    "measurementDate", "measurements", "weightG", "heightCm", "headCm", "feedTime",
    "feedType", "amountMl", "durationMin", "sleepStart", "sleepEnd", "sleepType",
    "nightWakings", "diaperTime", "diaperType", "recordDate", "recordType", "title",
    "notes", "description",
  ]);
  return knownFields.has(error.field)
    ? Object.freeze({ field: error.field, message: messages[error.field] ?? "请检查标出的内容后再保存。" })
    : Object.freeze({ field: "form", message: "请检查标出的内容后再保存。" });
}

export function ManualTrackerScreen() {
  const service = useManualTrackerService();
  const [state, reactDispatch] = useReducer(trackerScreenReducer, undefined, initialState);
  const stateRef = useRef(state);
  const mountedRef = useRef(true);
  const mountEpochRef = useRef(1);
  const generationRef = useRef(0);
  const focusSessionRef = useRef(0);
  const operationIdRef = useRef(0);
  const [focusRequest, setFocusRequest] = useState<Readonly<{ id: number; field: FocusField }> | null>(null);
  const [listFocusRequest, setListFocusRequest] = useState(0);
  const consumedListFocusRef = useRef(0);
  const listHeadingRef = useRef<Text>(null);

  const inputRefObjects = useMemo(() => ({
    measurementDate: { current: null as TextInput | null },
    weightG: { current: null as TextInput | null },
    heightCm: { current: null as TextInput | null },
    headCm: { current: null as TextInput | null },
    notes: { current: null as TextInput | null },
    feedTimeDate: { current: null as TextInput | null },
    feedTime: { current: null as TextInput | null },
    amountMl: { current: null as TextInput | null },
    durationMin: { current: null as TextInput | null },
    sleepStartDate: { current: null as TextInput | null },
    sleepStart: { current: null as TextInput | null },
    sleepEndDate: { current: null as TextInput | null },
    sleepEnd: { current: null as TextInput | null },
    nightWakings: { current: null as TextInput | null },
    diaperTimeDate: { current: null as TextInput | null },
    diaperTime: { current: null as TextInput | null },
    recordDate: { current: null as TextInput | null },
    title: { current: null as TextInput | null },
    description: { current: null as TextInput | null },
  }), []);
  const groupRefObjects = useMemo(() => ({
    feedType: { current: null as View | null },
    sleepType: { current: null as View | null },
    diaperType: { current: null as View | null },
    recordType: { current: null as View | null },
  }), []);
  const inputRefs: TrackerInputRefs = inputRefObjects;
  const groupRefs: TrackerGroupRefs = groupRefObjects;

  const send = useCallback(<D extends TrackerDomain,>(action: DomainAction<D> | GlobalTrackerScreenAction) => {
    const reducerAction: TrackerScreenAction = action.type === "BLURRED"
      || action.type === "VALIDATION_FAILED"
      || action.type === "RETURN_TO_LIST"
      ? action
      : correlatedAction(action);
    stateRef.current = trackerScreenReducer(stateRef.current, reducerAction);
    reactDispatch(reducerAction);
  }, []);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (focusRequest === null) return;
    const target = focusRequest.field in groupRefObjects
      ? groupRefObjects[focusRequest.field as keyof typeof groupRefObjects]
      : inputRefObjects[focusRequest.field as keyof typeof inputRefObjects];
    focusRefIfAvailable(target);
  }, [focusRequest, groupRefObjects, inputRefObjects]);

  useEffect(() => {
    if (listFocusRequest <= consumedListFocusRef.current || listHeadingRef.current === null) return;
    consumedListFocusRef.current = listFocusRequest;
    focusRefIfAvailable(listHeadingRef);
  }, [listFocusRequest, state]);

  useEffect(() => () => {
    mountedRef.current = false;
    mountEpochRef.current += 1;
    generationRef.current += 1;
  }, []);

  const makeListOwner = useCallback(<D extends TrackerDomain,>(domain: D): ReadOwner<D, "list"> => {
    generationRef.current += 1;
    return Object.freeze({
      mountEpoch: mountEpochRef.current,
      generation: generationRef.current,
      domain,
      focusSession: focusSessionRef.current,
      kind: "list",
      recordId: undefined,
    });
  }, []);

  const makeGetOwner = useCallback(<D extends TrackerDomain,>(domain: D, id: string): ReadOwner<D, "get"> => {
    generationRef.current += 1;
    return Object.freeze({
      mountEpoch: mountEpochRef.current,
      generation: generationRef.current,
      domain,
      focusSession: focusSessionRef.current,
      kind: "get",
      recordId: id,
    });
  }, []);

  const ownsRead = useCallback((owner: ReadOwner): boolean => {
    if (
      !mountedRef.current
      || owner.mountEpoch !== mountEpochRef.current
      || owner.generation !== generationRef.current
      || owner.focusSession !== focusSessionRef.current
      || owner.domain !== stateDomain(stateRef.current)
    ) return false;
    const current = stateRef.current;
    return (current.tag === "list.loading" && current.source === "ordinary" && sameReadOwner(current.owner, owner))
      || (current.tag === "edit.loading" && sameReadOwner(current.owner, owner));
  }, []);

  const ownsOperationRefresh = useCallback((owner: OperationOwner): boolean => {
    if (!mountedRef.current || owner.mountEpoch !== mountEpochRef.current) return false;
    const current = stateRef.current;
    return current.tag === "list.loading"
      && current.source === "mutation-refresh"
      && sameOperationOwner(current.owner, owner);
  }, []);

  const runOrdinaryList = useCallback(<D extends TrackerDomain,>(
    owner: ReadOwner<D, "list">,
    prior: ListFact<D>,
    presentationZone: string,
  ) => {
    void service.list(owner.domain, 100).then(
      (rows) => {
        if (!ownsRead(owner)) return;
        if (!validRowsForDomain(owner.domain, rows)) {
          send({ type: "LIST_FAILED", owner });
          return;
        }
        send({
          type: "LIST_SUCCEEDED",
          owner,
          fact: freezeListFact(owner.domain, rows, presentationZone),
        });
      },
      () => {
        if (ownsRead(owner)) send({ type: "LIST_FAILED", owner });
      },
    );
  }, [ownsRead, send, service]);

  const startList = useCallback(<D extends TrackerDomain,>(
    domain: D,
    prior: ListFact<D>,
    notice?: string,
  ) => {
    const owner = makeListOwner(domain);
    const zoneResult = captureDeviceTimeZone();
    const presentationZone = zoneResult.status === "available" ? zoneResult.zone : prior.presentationZone;
    const next = Object.freeze({
      tag: "list.loading" as const,
      source: "ordinary" as const,
      owner,
      prior,
      notice,
    });
    send({ type: "LIST_STARTED", next });
    runOrdinaryList(owner, prior, presentationZone);
  }, [makeListOwner, runOrdinaryList, send]);

  const requestRecord = useCallback(<D extends TrackerDomain,>(domain: D, id: string, prior: ListFact<D>) => {
    const zoneResult = captureDeviceTimeZone();
    if (zoneResult.status !== "available") return;
    const owner = makeGetOwner(domain, id);
    const next = Object.freeze({
      tag: "edit.loading" as const,
      owner,
      id,
      capturedZone: zoneResult.zone,
      prior,
    });
    send({ type: "GET_STARTED", next });
    void service.getById(domain, id).then(
      (record) => {
        if (!ownsRead(owner)) return;
        if (record === null) {
          const listOwner = makeListOwner(domain);
          const listNext = Object.freeze({
            tag: "list.loading" as const,
            source: "ordinary" as const,
            owner: listOwner,
            prior,
            notice: "这条记录已不存在，列表已重新读取。",
          });
          send({ type: "GET_MISSING_RELOAD_STARTED", owner, next: listNext });
          runOrdinaryList(listOwner, prior, zoneResult.zone);
          return;
        }
        if (!validRecordForDomain(domain, id, record)) {
          send({ type: "GET_FAILED", owner, message: READ_FAILURE });
          return;
        }
        const built = recordToEditorDraft(domain, record, zoneResult.zone);
        if (built.status !== "ready") {
          send({ type: "GET_FAILED", owner, message: READ_FAILURE });
          return;
        }
        send({
          type: "GET_SUCCEEDED",
          owner,
          editor: editSnapshot(domain, built.draft, record, zoneResult.zone, prior),
        });
      },
      () => {
        if (ownsRead(owner)) send({ type: "GET_FAILED", owner, message: READ_FAILURE });
      },
    );
  }, [makeGetOwner, makeListOwner, ownsRead, runOrdinaryList, send, service]);

  const resumeGet = useCallback((request: Extract<TrackerScreenState, { tag: "read.suspended" }>["request"]) => {
    if (request.kind !== "get") return;
    switch (request.prior.domain) {
      case "growth": requestRecord("growth", request.id, request.prior); break;
      case "feeding": requestRecord("feeding", request.id, request.prior); break;
      case "sleep": requestRecord("sleep", request.id, request.prior); break;
      case "diaper": requestRecord("diaper", request.id, request.prior); break;
      case "health": requestRecord("health", request.id, request.prior); break;
    }
  }, [requestRecord]);

  const resumeList = useCallback((fact: AnyListFact, notice?: string) => {
    switch (fact.domain) {
      case "growth": startList("growth", fact, notice); break;
      case "feeding": startList("feeding", fact, notice); break;
      case "sleep": startList("sleep", fact, notice); break;
      case "diaper": startList("diaper", fact, notice); break;
      case "health": startList("health", fact, notice); break;
    }
  }, [startList]);

  useFocusEffect(useCallback(() => {
    mountedRef.current = true;
    focusSessionRef.current += 1;
    const current = stateRef.current;
    if (current.tag === "mutation.submitting") return () => {
      focusSessionRef.current += 1;
      generationRef.current += 1;
      send({ type: "BLURRED", focusSession: focusSessionRef.current });
    };
    if (current.tag === "list.loading" && current.source === "mutation-refresh") return () => {
      focusSessionRef.current += 1;
      generationRef.current += 1;
      send({ type: "BLURRED", focusSession: focusSessionRef.current });
    };
    if (current.tag === "read.suspended") {
      if (current.request.kind === "get") resumeGet(current.request);
      else resumeList(current.request.prior, current.request.notice);
    } else if (
      current.tag === "list.loading"
      || current.tag === "list.ready.empty"
      || current.tag === "list.ready.rows"
      || current.tag === "list.error"
    ) {
      resumeList(stateListFact(current));
    }
    return () => {
      focusSessionRef.current += 1;
      generationRef.current += 1;
      send({ type: "BLURRED", focusSession: focusSessionRef.current });
    };
  }, [resumeGet, resumeList, send]));

  const selectDomain = useCallback((domain: TrackerDomain) => {
    const current = stateRef.current;
    if (domain === stateDomain(current) && current.tag.startsWith("list.")) return;
    const zoneResult = captureDeviceTimeZone();
    const zone = zoneResult.status === "available" ? zoneResult.zone : stateListFact(current).presentationZone;
    switch (domain) {
      case "growth": startList("growth", freezeListFact("growth", Object.freeze([]), zone)); break;
      case "feeding": startList("feeding", freezeListFact("feeding", Object.freeze([]), zone)); break;
      case "sleep": startList("sleep", freezeListFact("sleep", Object.freeze([]), zone)); break;
      case "diaper": startList("diaper", freezeListFact("diaper", Object.freeze([]), zone)); break;
      case "health": startList("health", freezeListFact("health", Object.freeze([]), zone)); break;
    }
  }, [startList]);

  const openCreate = useCallback(<D extends TrackerDomain,>(domain: D, prior: ListFact<D>) => {
    const zoneResult = captureDeviceTimeZone();
    if (zoneResult.status !== "available") return;
    const built = createInitialDraft(domain, new Date(), zoneResult.zone);
    if (built.status !== "ready") return;
    send({ type: "CREATE_REQUESTED", editor: createSnapshot(domain, built.draft, zoneResult.zone, prior) });
  }, [send]);

  const requestCreate = useCallback(() => {
    const fact = stateListFact(stateRef.current);
    switch (fact.domain) {
      case "growth": openCreate("growth", fact); break;
      case "feeding": openCreate("feeding", fact); break;
      case "sleep": openCreate("sleep", fact); break;
      case "diaper": openCreate("diaper", fact); break;
      case "health": openCreate("health", fact); break;
    }
  }, [openCreate]);

  const retryGet = useCallback(() => {
    const current = stateRef.current;
    if (current.tag !== "edit.error") return;
    switch (current.prior.domain) {
      case "growth": requestRecord("growth", current.id, current.prior); break;
      case "feeding": requestRecord("feeding", current.id, current.prior); break;
      case "sleep": requestRecord("sleep", current.id, current.prior); break;
      case "diaper": requestRecord("diaper", current.id, current.prior); break;
      case "health": requestRecord("health", current.id, current.prior); break;
    }
  }, [requestRecord]);

  const returnToList = useCallback(() => {
    send({ type: "RETURN_TO_LIST" });
    setListFocusRequest((value) => value + 1);
  }, [send]);

  const requestFieldFocus = useCallback((field: string) => {
    const aliases: Readonly<Record<string, FocusField>> = Object.freeze({
      measurementDate: "measurementDate", weightG: "weightG", heightCm: "heightCm", headCm: "headCm",
      measurements: "weightG", feedTime: "feedTime", feedType: "feedType", amountMl: "amountMl",
      durationMin: "durationMin", sleepStart: "sleepStart", sleepEnd: "sleepEnd", sleepType: "sleepType",
      nightWakings: "nightWakings", diaperTime: "diaperTime", diaperType: "diaperType",
      recordDate: "recordDate", recordType: "recordType", title: "title", notes: "notes", description: "description",
    });
    const target = aliases[field];
    if (target !== undefined) setFocusRequest((previous) => ({ id: (previous?.id ?? 0) + 1, field: target }));
  }, []);

  const startOperationRefresh = useCallback(<D extends LowRiskDomain,>(
    owner: OperationOwner<D, "create">,
    prior: ListFact<D>,
  ) => {
    const success = `${TRACKER_DOMAIN_LABELS[owner.domain]}记录已保存`;
    const next = Object.freeze({
      tag: "list.loading" as const,
      source: "mutation-refresh" as const,
      owner,
      prior,
      success,
    });
    send({ type: "OPERATION_REFRESH_STARTED", owner, next });
    setListFocusRequest((value) => value + 1);
    void service.list(owner.domain, 100).then(
      (rows) => {
        if (!ownsOperationRefresh(owner)) return;
        if (!validRowsForDomain(owner.domain, rows)) {
          send({ type: "OPERATION_REFRESH_FAILED", owner });
          return;
        }
        send({
          type: "OPERATION_REFRESH_SUCCEEDED",
          owner,
          fact: freezeListFact(owner.domain, rows, prior.presentationZone),
        });
      },
      () => {
        if (ownsOperationRefresh(owner)) send({ type: "OPERATION_REFRESH_FAILED", owner });
      },
    );
  }, [ownsOperationRefresh, send, service]);

  const submitLowRiskCreate = useCallback(async <D extends LowRiskDomain,>(prior: CreateEditorSnapshot<D>) => {
    const zoneResult = captureDeviceTimeZone();
    const currentZone = zoneResult.status === "available" ? zoneResult.zone : "";
    const parsed = parseDraftToCreateInput(prior.domain, prior.draft, currentZone);
    if (parsed.status !== "valid") {
      send({ type: "VALIDATION_FAILED", field: parsed.field, message: parsed.error });
      requestFieldFocus(parsed.field);
      return;
    }
    operationIdRef.current += 1;
    const owner: OperationOwner<D, "create"> = Object.freeze({
      mountEpoch: mountEpochRef.current,
      operationId: operationIdRef.current,
      domain: prior.domain,
      kind: "create",
    });
    send({ type: "MUTATION_STARTED", owner, prior });
    try {
      const result = await service.create(prior.domain, parsed.input);
      const current = stateRef.current;
      if (
        !mountedRef.current
        || owner.mountEpoch !== mountEpochRef.current
        || current.tag !== "mutation.submitting"
        || !sameOperationOwner(current.owner, owner)
      ) return;
      if (result.status !== "completed") {
        send({ type: "MUTATION_REJECTED", owner, message: SAVE_FAILURE });
        return;
      }
      startOperationRefresh(owner, prior.prior);
    } catch (error) {
      const current = stateRef.current;
      if (
        !mountedRef.current
        || owner.mountEpoch !== mountEpochRef.current
        || current.tag !== "mutation.submitting"
        || !sameOperationOwner(current.owner, owner)
      ) return;
      if (error instanceof TrackerValidationError) {
        const failure = serviceValidationFailure(error);
        send({ type: "MUTATION_REJECTED", owner, field: failure.field, message: failure.message });
        requestFieldFocus(failure.field);
      } else {
        send({ type: "MUTATION_REJECTED", owner, message: SAVE_FAILURE });
      }
    }
  }, [requestFieldFocus, send, service, startOperationRefresh]);

  const save = useCallback(() => {
    const current = stateRef.current;
    if (current.tag !== "create.editing") return;
    switch (current.editor.domain) {
      case "growth": void submitLowRiskCreate(current.editor); break;
      case "feeding": void submitLowRiskCreate(current.editor); break;
      case "sleep": void submitLowRiskCreate(current.editor); break;
      case "diaper": void submitLowRiskCreate(current.editor); break;
      case "health": send({ type: "VALIDATION_FAILED", field: "form", message: SAVE_FAILURE }); break;
    }
  }, [send, submitLowRiskCreate]);

  const renderList = useCallback((fact: AnyListFact, busy: boolean): ReactNode => {
    const shared = { busy, headingRef: listHeadingRef, onCreate: requestCreate };
    switch (fact.domain) {
      case "growth": return <TrackerRecordList {...shared} domain="growth" onSelectRecord={(id) => requestRecord("growth", id, fact)} records={fact.rows} timeZone={fact.presentationZone} />;
      case "feeding": return <TrackerRecordList {...shared} domain="feeding" onSelectRecord={(id) => requestRecord("feeding", id, fact)} records={fact.rows} timeZone={fact.presentationZone} />;
      case "sleep": return <TrackerRecordList {...shared} domain="sleep" onSelectRecord={(id) => requestRecord("sleep", id, fact)} records={fact.rows} timeZone={fact.presentationZone} />;
      case "diaper": return <TrackerRecordList {...shared} domain="diaper" onSelectRecord={(id) => requestRecord("diaper", id, fact)} records={fact.rows} timeZone={fact.presentationZone} />;
      case "health": return <TrackerRecordList {...shared} domain="health" onSelectRecord={(id) => requestRecord("health", id, fact)} records={fact.rows} timeZone={fact.presentationZone} />;
    }
  }, [requestCreate, requestRecord]);

  const renderEditor = useCallback((editor: AnyEditorSnapshot, busy: boolean): ReactNode => {
    const shared = {
      busy,
      errors: editor.errors,
      groupRefs,
      inputRefs,
      onBack: returnToList,
    };
    switch (editor.domain) {
      case "growth": return editor.mode === "create"
        ? <TrackerEditor {...shared} domain="growth" draft={editor.draft} mode="create" onChange={(draft) => send({ type: "DRAFT_CHANGED", domain: "growth", draft })} onSave={save} />
        : <TrackerEditor {...shared} domain="growth" draft={editor.draft} mode="edit" onChange={(draft) => send({ type: "DRAFT_CHANGED", domain: "growth", draft })} onDelete={() => undefined} onSave={() => undefined} />;
      case "feeding": return editor.mode === "create"
        ? <TrackerEditor {...shared} domain="feeding" draft={editor.draft} mode="create" onChange={(draft) => send({ type: "DRAFT_CHANGED", domain: "feeding", draft })} onSave={save} />
        : <TrackerEditor {...shared} domain="feeding" draft={editor.draft} mode="edit" onChange={(draft) => send({ type: "DRAFT_CHANGED", domain: "feeding", draft })} onDelete={() => undefined} onSave={() => undefined} />;
      case "sleep": return editor.mode === "create"
        ? <TrackerEditor {...shared} domain="sleep" draft={editor.draft} mode="create" onChange={(draft) => send({ type: "DRAFT_CHANGED", domain: "sleep", draft })} onSave={save} />
        : <TrackerEditor {...shared} domain="sleep" draft={editor.draft} mode="edit" onChange={(draft) => send({ type: "DRAFT_CHANGED", domain: "sleep", draft })} onDelete={() => undefined} onSave={() => undefined} />;
      case "diaper": return editor.mode === "create"
        ? <TrackerEditor {...shared} domain="diaper" draft={editor.draft} mode="create" onChange={(draft) => send({ type: "DRAFT_CHANGED", domain: "diaper", draft })} onSave={save} />
        : <TrackerEditor {...shared} domain="diaper" draft={editor.draft} mode="edit" onChange={(draft) => send({ type: "DRAFT_CHANGED", domain: "diaper", draft })} onDelete={() => undefined} onSave={() => undefined} />;
      case "health": return editor.mode === "create"
        ? <TrackerEditor {...shared} domain="health" draft={editor.draft} mode="create" onChange={(draft) => send({ type: "DRAFT_CHANGED", domain: "health", draft })} onSave={save} />
        : <TrackerEditor {...shared} domain="health" draft={editor.draft} mode="edit" onChange={(draft) => send({ type: "DRAFT_CHANGED", domain: "health", draft })} onDelete={() => undefined} onSave={() => undefined} />;
    }
  }, [groupRefs, inputRefs, returnToList, save, send]);

  const selectedDomain = stateDomain(state);
  const label = TRACKER_DOMAIN_LABELS[selectedDomain];
  const editing = stateEditor(state);
  let content: ReactNode;

  if (state.tag === "list.loading") {
    content = (
      <View style={{ gap: spacing.md }}>
        <TrackerDomainSwitcher disabled={state.source === "mutation-refresh"} onSelectDomain={selectDomain} selectedDomain={selectedDomain} />
        {renderList(state.prior, true)}
        <Text accessibilityLiveRegion="polite" allowFontScaling style={{ color: colors.textSecondary }}>
          正在读取{label}记录…
        </Text>
        {state.source === "mutation-refresh" ? <Text accessibilityLiveRegion="polite" allowFontScaling>{state.success}</Text> : null}
      </View>
    );
  } else if (state.tag === "list.ready.empty" || state.tag === "list.ready.rows") {
    content = (
      <View style={{ gap: spacing.md }}>
        <TrackerDomainSwitcher onSelectDomain={selectDomain} selectedDomain={selectedDomain} />
        {state.notice ? <Text accessibilityLiveRegion="assertive" accessibilityRole="alert" allowFontScaling>{state.notice}</Text> : null}
        {state.success ? <Text accessibilityLiveRegion="polite" allowFontScaling>{state.success}</Text> : null}
        {renderList(state.fact, false)}
      </View>
    );
  } else if (state.tag === "list.error") {
    content = (
      <View style={{ gap: spacing.md }}>
        <TrackerDomainSwitcher onSelectDomain={selectDomain} selectedDomain={selectedDomain} />
        {state.kind === "refresh" && state.fact.rows.length > 0
          ? renderList(state.fact, false)
          : <Text accessibilityRole="header" allowFontScaling ref={listHeadingRef}>{label}记录</Text>}
        {state.success ? <Text accessibilityLiveRegion="polite" allowFontScaling>{state.success}</Text> : null}
        <Text accessibilityLiveRegion="assertive" accessibilityRole="alert" allowFontScaling>
          {state.kind === "refresh" ? "记录可能不是最新内容。" : `暂时无法读取${label}记录。本机数据没有更改。`}
        </Text>
        <PrimaryAction label="重新读取记录" onPress={() => resumeList(state.fact)} />
      </View>
    );
  } else if (state.tag === "edit.loading" || (state.tag === "read.suspended" && state.request.kind === "get")) {
    content = (
      <View style={{ gap: spacing.md }}>
        <TrackerDomainSwitcher busy onSelectDomain={selectDomain} selectedDomain={selectedDomain} />
        <Text accessibilityRole="header" allowFontScaling>编辑{label}记录</Text>
        <SecondaryAction disabled label={`返回${label}列表`} onPress={returnToList} />
        <Text accessibilityLiveRegion="polite" allowFontScaling>正在读取这条{label}记录…</Text>
      </View>
    );
  } else if (state.tag === "edit.error") {
    content = (
      <View style={{ gap: spacing.md }}>
        <TrackerDomainSwitcher disabled onSelectDomain={selectDomain} selectedDomain={selectedDomain} />
        <Text accessibilityRole="header" allowFontScaling>编辑{label}记录</Text>
        <Text accessibilityLiveRegion="assertive" accessibilityRole="alert" allowFontScaling>{state.message}</Text>
        <PrimaryAction label="重新读取这条记录" onPress={retryGet} />
        <SecondaryAction label={`返回${label}列表`} onPress={returnToList} />
      </View>
    );
  } else if (editing !== null) {
    content = (
      <View style={{ gap: spacing.md }}>
        <TrackerDomainSwitcher busy={state.tag === "mutation.submitting"} onSelectDomain={selectDomain} selectedDomain={selectedDomain} />
        {renderEditor(editing, state.tag === "mutation.submitting")}
      </View>
    );
  } else {
    const fact = stateListFact(state);
    content = (
      <View style={{ gap: spacing.md }}>
        <TrackerDomainSwitcher busy onSelectDomain={selectDomain} selectedDomain={selectedDomain} />
        {renderList(fact, true)}
      </View>
    );
  }

  return (
    <AppFrame keyboardDismissMode="on-drag" localOnly title="记录">
      {content}
    </AppFrame>
  );
}
