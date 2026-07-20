import type { TrackerDomain, TrackerRecordByDomain } from "../../domain/tracker/types";
import type { TrackerEditorDraftByDomain } from "./trackerEditorModel";
import type { TrackerFormErrors } from "./TrackerEditor";

export type DomainRows<D extends TrackerDomain> = readonly TrackerRecordByDomain[D][];

export type ListFact<D extends TrackerDomain> = Readonly<{
  domain: D;
  rows: DomainRows<D>;
  presentationZone: string;
}>;

export interface TrackerRowsByDomain {
  readonly growth: ListFact<"growth">;
  readonly feeding: ListFact<"feeding">;
  readonly sleep: ListFact<"sleep">;
  readonly diaper: ListFact<"diaper">;
  readonly health: ListFact<"health">;
}

export type AnyListFact = TrackerRowsByDomain[TrackerDomain];

export type ReadOwner<
  D extends TrackerDomain = TrackerDomain,
  K extends "list" | "get" = "list" | "get",
> = Readonly<{
  mountEpoch: number;
  generation: number;
  domain: D;
  focusSession: number;
  kind: K;
  recordId: K extends "get" ? string : undefined;
}>;

export type OperationOwner<
  D extends TrackerDomain = TrackerDomain,
  K extends "create" | "update" | "delete" = "create" | "update" | "delete",
> = Readonly<{
  mountEpoch: number;
  operationId: number;
  domain: D;
  kind: K;
}>;

type EditorCommon<D extends TrackerDomain> = Readonly<{
  domain: D;
  draft: TrackerEditorDraftByDomain[D];
  initialDraft: TrackerEditorDraftByDomain[D];
  capturedZone: string;
  errors: TrackerFormErrors;
  prior: ListFact<D>;
}>;

export type CreateEditorSnapshot<D extends TrackerDomain> = EditorCommon<D> & Readonly<{
  mode: "create";
  baseline: null;
}>;

export type EditEditorSnapshot<D extends TrackerDomain> = EditorCommon<D> & Readonly<{
  mode: "edit";
  baseline: TrackerRecordByDomain[D];
}>;

export type EditorSnapshot<D extends TrackerDomain = TrackerDomain> = D extends TrackerDomain
  ? CreateEditorSnapshot<D> | EditEditorSnapshot<D>
  : never;

export type AnyEditorSnapshot = EditorSnapshot<TrackerDomain>;

type OrdinaryListLoading<D extends TrackerDomain> = Readonly<{
  tag: "list.loading";
  source: "ordinary";
  owner: ReadOwner<D, "list">;
  prior: ListFact<D>;
  notice?: string;
}>;

type RefreshListLoading<D extends TrackerDomain> = Readonly<{
  tag: "list.loading";
  source: "mutation-refresh";
  owner: OperationOwner<D>;
  prior: ListFact<D>;
  success: string;
}>;

type ListReady<D extends TrackerDomain> = Readonly<{
  tag: "list.ready.empty" | "list.ready.rows";
  fact: ListFact<D>;
  notice?: string;
  success?: string;
}>;

type ListError<D extends TrackerDomain> = Readonly<{
  tag: "list.error";
  kind: "initial" | "refresh";
  fact: ListFact<D>;
  success?: string;
}>;

type EditLoading<D extends TrackerDomain> = Readonly<{
  tag: "edit.loading";
  owner: ReadOwner<D, "get">;
  id: string;
  capturedZone: string;
  prior: ListFact<D>;
}>;

type EditError<D extends TrackerDomain> = Readonly<{
  tag: "edit.error";
  id: string;
  prior: ListFact<D>;
  message: string;
}>;

type SuspendedRead<D extends TrackerDomain> = Readonly<{
  tag: "read.suspended";
  request:
    | Readonly<{ kind: "list"; prior: ListFact<D>; notice?: string }>
    | Readonly<{ kind: "get"; id: string; capturedZone: string; prior: ListFact<D> }>;
}>;

type CreateSubmitting<D extends TrackerDomain> = Readonly<{
  tag: "mutation.submitting";
  owner: OperationOwner<D, "create">;
  prior: CreateEditorSnapshot<D>;
}>;

export type DomainState<D extends TrackerDomain> =
  | OrdinaryListLoading<D>
  | RefreshListLoading<D>
  | ListReady<D>
  | ListError<D>
  | Readonly<{ tag: "create.editing"; editor: CreateEditorSnapshot<D> }>
  | EditLoading<D>
  | EditError<D>
  | Readonly<{ tag: "edit.editing"; editor: EditEditorSnapshot<D> }>
  | SuspendedRead<D>
  | CreateSubmitting<D>;

export interface TrackerScreenStateByDomain {
  readonly growth: DomainState<"growth">;
  readonly feeding: DomainState<"feeding">;
  readonly sleep: DomainState<"sleep">;
  readonly diaper: DomainState<"diaper">;
  readonly health: DomainState<"health">;
}

export type CorrelatedTrackerScreenState = TrackerScreenStateByDomain[TrackerDomain];
export type TrackerScreenState = CorrelatedTrackerScreenState;

type ListStartedAction<D extends TrackerDomain> = Readonly<{
  type: "LIST_STARTED";
  next: OrdinaryListLoading<D>;
}>;

type ListSucceededAction<D extends TrackerDomain> = Readonly<{
  type: "LIST_SUCCEEDED";
  owner: ReadOwner<D, "list">;
  fact: ListFact<D>;
}>;

type ListFailedAction<D extends TrackerDomain> = Readonly<{
  type: "LIST_FAILED";
  owner: ReadOwner<D, "list">;
}>;

type GetStartedAction<D extends TrackerDomain> = Readonly<{
  type: "GET_STARTED";
  next: EditLoading<D>;
}>;

type GetSucceededAction<D extends TrackerDomain> = Readonly<{
  type: "GET_SUCCEEDED";
  owner: ReadOwner<D, "get">;
  editor: EditEditorSnapshot<D>;
}>;

type GetFailedAction<D extends TrackerDomain> = Readonly<{
  type: "GET_FAILED";
  owner: ReadOwner<D, "get">;
  message: string;
}>;

type GetMissingReloadAction<D extends TrackerDomain> = Readonly<{
  type: "GET_MISSING_RELOAD_STARTED";
  owner: ReadOwner<D, "get">;
  next: OrdinaryListLoading<D>;
}>;

type CreateRequestedAction<D extends TrackerDomain> = Readonly<{
  type: "CREATE_REQUESTED";
  editor: CreateEditorSnapshot<D>;
}>;

type DraftChangedAction<D extends TrackerDomain> = Readonly<{
  type: "DRAFT_CHANGED";
  domain: D;
  draft: TrackerEditorDraftByDomain[D];
}>;

type MutationStartedAction<D extends TrackerDomain> = Readonly<{
  type: "MUTATION_STARTED";
  owner: OperationOwner<D, "create">;
  prior: CreateEditorSnapshot<D>;
}>;

type MutationRejectedAction<D extends TrackerDomain> = Readonly<{
  type: "MUTATION_REJECTED";
  owner: OperationOwner<D, "create">;
  field?: string;
  message: string;
}>;

type RefreshStartedAction<D extends TrackerDomain> = Readonly<{
  type: "OPERATION_REFRESH_STARTED";
  owner: OperationOwner<D, "create">;
  next: RefreshListLoading<D>;
}>;

type RefreshSucceededAction<D extends TrackerDomain> = Readonly<{
  type: "OPERATION_REFRESH_SUCCEEDED";
  owner: OperationOwner<D, "create">;
  fact: ListFact<D>;
}>;

type RefreshFailedAction<D extends TrackerDomain> = Readonly<{
  type: "OPERATION_REFRESH_FAILED";
  owner: OperationOwner<D, "create">;
}>;

export type DomainAction<D extends TrackerDomain> =
  | ListStartedAction<D>
  | ListSucceededAction<D>
  | ListFailedAction<D>
  | GetStartedAction<D>
  | GetSucceededAction<D>
  | GetFailedAction<D>
  | GetMissingReloadAction<D>
  | CreateRequestedAction<D>
  | DraftChangedAction<D>
  | MutationStartedAction<D>
  | MutationRejectedAction<D>
  | RefreshStartedAction<D>
  | RefreshSucceededAction<D>
  | RefreshFailedAction<D>;

export interface TrackerScreenActionByDomain {
  readonly growth: DomainAction<"growth">;
  readonly feeding: DomainAction<"feeding">;
  readonly sleep: DomainAction<"sleep">;
  readonly diaper: DomainAction<"diaper">;
  readonly health: DomainAction<"health">;
}

export type CorrelatedTrackerScreenAction = TrackerScreenActionByDomain[TrackerDomain];
export type GlobalTrackerScreenAction =
  | Readonly<{ type: "BLURRED"; focusSession: number }>
  | Readonly<{ type: "VALIDATION_FAILED"; field: string; message: string }>
  | Readonly<{ type: "RETURN_TO_LIST" }>;

export type TrackerScreenAction = CorrelatedTrackerScreenAction | GlobalTrackerScreenAction;

export function correlatedAction<D extends TrackerDomain>(action: DomainAction<D>): CorrelatedTrackerScreenAction {
  return action as CorrelatedTrackerScreenAction;
}

export function sameReadOwner(left: ReadOwner, right: ReadOwner): boolean {
  return left.mountEpoch === right.mountEpoch
    && left.generation === right.generation
    && left.domain === right.domain
    && left.focusSession === right.focusSession
    && left.kind === right.kind
    && left.recordId === right.recordId;
}

export function sameOperationOwner(left: OperationOwner, right: OperationOwner): boolean {
  return left.mountEpoch === right.mountEpoch
    && left.operationId === right.operationId
    && left.domain === right.domain
    && left.kind === right.kind;
}

function listDomain(state: TrackerScreenState): TrackerDomain {
  switch (state.tag) {
    case "list.loading": return state.prior.domain;
    case "list.ready.empty":
    case "list.ready.rows":
    case "list.error": return state.fact.domain;
    case "create.editing":
    case "edit.editing": return state.editor.domain;
    case "edit.loading":
    case "edit.error": return state.prior.domain;
    case "read.suspended": return state.request.prior.domain;
    case "mutation.submitting": return state.prior.domain;
  }
}

function correlatedState(value: DomainState<TrackerDomain>): TrackerScreenState {
  return value as TrackerScreenState;
}

function frozenDraft<D extends TrackerDomain>(draft: TrackerEditorDraftByDomain[D]): TrackerEditorDraftByDomain[D] {
  return Object.freeze({ ...draft }) as TrackerEditorDraftByDomain[D];
}

function editorWithErrors(editor: AnyEditorSnapshot, errors: TrackerFormErrors): TrackerScreenState {
  const next = Object.freeze({ ...editor, errors: Object.freeze({ ...errors }) });
  return next.mode === "create"
    ? correlatedState(Object.freeze({ tag: "create.editing", editor: next }))
    : correlatedState(Object.freeze({ tag: "edit.editing", editor: next }));
}

export function trackerScreenReducer(
  state: TrackerScreenState,
  action: TrackerScreenAction,
): TrackerScreenState {
  switch (action.type) {
    case "LIST_STARTED":
      if (action.next.owner.domain !== action.next.prior.domain) return state;
      return correlatedState(action.next);
    case "LIST_SUCCEEDED":
      if (
        state.tag !== "list.loading"
        || state.source !== "ordinary"
        || !sameReadOwner(state.owner, action.owner)
        || action.fact.domain !== state.prior.domain
      ) return state;
      return correlatedState(Object.freeze({
        tag: action.fact.rows.length === 0 ? "list.ready.empty" : "list.ready.rows",
        fact: action.fact,
        notice: state.notice,
      }));
    case "LIST_FAILED":
      if (
        state.tag !== "list.loading"
        || state.source !== "ordinary"
        || !sameReadOwner(state.owner, action.owner)
      ) return state;
      return correlatedState(Object.freeze({ tag: "list.error", kind: "initial", fact: state.prior }));
    case "GET_STARTED":
      if (
        action.next.owner.domain !== action.next.prior.domain
        || action.next.owner.recordId !== action.next.id
      ) return state;
      return correlatedState(action.next);
    case "GET_SUCCEEDED":
      if (
        state.tag !== "edit.loading"
        || !sameReadOwner(state.owner, action.owner)
        || action.editor.mode !== "edit"
        || action.editor.domain !== state.prior.domain
        || action.editor.prior !== state.prior
        || action.editor.baseline.id !== state.id
      ) return state;
      return correlatedState(Object.freeze({ tag: "edit.editing", editor: action.editor }));
    case "GET_FAILED":
      if (state.tag !== "edit.loading" || !sameReadOwner(state.owner, action.owner)) return state;
      return correlatedState(Object.freeze({ tag: "edit.error", id: state.id, prior: state.prior, message: action.message }));
    case "GET_MISSING_RELOAD_STARTED":
      if (
        state.tag !== "edit.loading"
        || !sameReadOwner(state.owner, action.owner)
        || action.next.owner.domain !== state.prior.domain
        || action.next.prior !== state.prior
      ) return state;
      return correlatedState(action.next);
    case "CREATE_REQUESTED":
      if (action.editor.mode !== "create" || action.editor.baseline !== null) return state;
      return correlatedState(Object.freeze({ tag: "create.editing", editor: action.editor }));
    case "DRAFT_CHANGED":
      if (
        (state.tag !== "create.editing" && state.tag !== "edit.editing")
        || state.editor.domain !== action.domain
        || action.draft.domain !== action.domain
      ) return state;
      return state.editor.mode === "create"
        ? correlatedState(Object.freeze({
          tag: "create.editing",
          editor: Object.freeze({ ...state.editor, draft: frozenDraft(action.draft), errors: Object.freeze({}) }),
        }))
        : correlatedState(Object.freeze({
          tag: "edit.editing",
          editor: Object.freeze({ ...state.editor, draft: frozenDraft(action.draft), errors: Object.freeze({}) }),
        }));
    case "VALIDATION_FAILED":
      if (state.tag !== "create.editing" && state.tag !== "edit.editing") return state;
      return editorWithErrors(
        state.editor,
        Object.freeze({ ...state.editor.errors, [action.field]: action.message }),
      );
    case "MUTATION_STARTED":
      if (
        state.tag !== "create.editing"
        || action.owner.kind !== "create"
        || action.owner.domain !== action.prior.domain
        || action.prior.mode !== "create"
        || state.editor !== action.prior
      ) return state;
      return correlatedState(Object.freeze({ tag: "mutation.submitting", owner: action.owner, prior: action.prior }));
    case "MUTATION_REJECTED":
      if (
        state.tag !== "mutation.submitting"
        || !sameOperationOwner(state.owner, action.owner)
        || state.prior.domain !== action.owner.domain
      ) return state;
      return editorWithErrors(
        state.prior,
        Object.freeze({ ...state.prior.errors, [action.field ?? "form"]: action.message }),
      );
    case "OPERATION_REFRESH_STARTED":
      if (
        state.tag !== "mutation.submitting"
        || !sameOperationOwner(state.owner, action.owner)
        || action.next.source !== "mutation-refresh"
        || !sameOperationOwner(action.next.owner, action.owner)
        || action.next.prior !== state.prior.prior
        || action.next.prior.domain !== action.owner.domain
      ) return state;
      return correlatedState(action.next);
    case "OPERATION_REFRESH_SUCCEEDED":
      if (
        state.tag !== "list.loading"
        || state.source !== "mutation-refresh"
        || !sameOperationOwner(state.owner, action.owner)
        || action.fact.domain !== state.prior.domain
      ) return state;
      return correlatedState(Object.freeze({
        tag: action.fact.rows.length === 0 ? "list.ready.empty" : "list.ready.rows",
        fact: action.fact,
        success: state.success,
      }));
    case "OPERATION_REFRESH_FAILED":
      if (
        state.tag !== "list.loading"
        || state.source !== "mutation-refresh"
        || !sameOperationOwner(state.owner, action.owner)
      ) return state;
      return correlatedState(Object.freeze({ tag: "list.error", kind: "refresh", fact: state.prior, success: state.success }));
    case "BLURRED":
      if (state.tag === "list.loading" && state.source === "ordinary") {
        return correlatedState(Object.freeze({
          tag: "read.suspended",
          request: Object.freeze({ kind: "list", prior: state.prior, notice: state.notice }),
        }));
      }
      if (state.tag === "edit.loading") {
        return correlatedState(Object.freeze({
          tag: "read.suspended",
          request: Object.freeze({
            kind: "get",
            id: state.id,
            capturedZone: state.capturedZone,
            prior: state.prior,
          }),
        }));
      }
      return state;
    case "RETURN_TO_LIST": {
      if (state.tag === "edit.error") {
        return correlatedState(Object.freeze({
          tag: state.prior.rows.length === 0 ? "list.ready.empty" : "list.ready.rows",
          fact: state.prior,
        }));
      }
      if (state.tag === "create.editing" || state.tag === "edit.editing") {
        return correlatedState(Object.freeze({
          tag: state.editor.prior.rows.length === 0 ? "list.ready.empty" : "list.ready.rows",
          fact: state.editor.prior,
        }));
      }
      return state;
    }
  }
}

export function stateDomain(state: TrackerScreenState): TrackerDomain {
  return listDomain(state);
}
