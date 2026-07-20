import type { TrackerDeletion, TrackerDomain, TrackerRecordByDomain } from "../../domain/tracker/types";
import { normalizePersistedTrackerRecord } from "../../domain/tracker/validation";
import type { TrackerEditorDraftByDomain } from "./trackerEditorModel";
import type {
  TrackerHealthCreateDecision,
  TrackerUpdateDecision,
  TrackerDeleteDecision,
} from "./InlineTrackerConfirmation";
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

export type EditorSnapshot<D extends TrackerDomain = TrackerDomain> =
  | CreateEditorSnapshot<D>
  | EditEditorSnapshot<D>;

export type AnyEditorSnapshot = {
  [D in TrackerDomain]: CreateEditorSnapshot<D> | EditEditorSnapshot<D>;
}[TrackerDomain];

type OrdinaryListLoading<D extends TrackerDomain> = Readonly<{
  tag: "list.loading";
  source: "ordinary";
  owner: ReadOwner<D, "list">;
  prior: ListFact<D>;
  notice?: string;
}>;

type MutationKind = "create" | "update" | "delete";
type LowRiskDomain = Exclude<TrackerDomain, "health">;

export type MutationCompletion<
  D extends TrackerDomain,
  K extends MutationKind = MutationKind,
> = K extends "delete"
  ? Readonly<{
    kind: "delete";
    deletion: Omit<TrackerDeletion, "domain"> & Readonly<{ domain: D }>;
  }>
  : K extends "create" | "update"
    ? Readonly<{ kind: K; record: TrackerRecordByDomain[D] }>
    : never;

type RefreshListLoading<D extends TrackerDomain> = {
  [K in MutationKind]: Readonly<{
  tag: "list.loading";
  source: "mutation-refresh";
  owner: OperationOwner<D, K>;
  prior: ListFact<D>;
  completion: MutationCompletion<D, K>;
  success: string;
  }>;
}[MutationKind];

type ListReady<D extends TrackerDomain> = Readonly<{
  tag: "list.ready.empty" | "list.ready.rows";
  fact: ListFact<D>;
  notice?: string;
  success?: string;
}>;

type InitialListError<D extends TrackerDomain> = Readonly<{
  tag: "list.error";
  kind: "initial";
  fact: ListFact<D>;
}>;

type RefreshListError<D extends TrackerDomain> = {
  [K in MutationKind]: Readonly<{
    tag: "list.error";
    kind: "refresh";
    fact: ListFact<D>;
    owner: OperationOwner<D, K>;
    completion: MutationCompletion<D, K>;
    success: string;
  }>;
}[MutationKind];

type ListError<D extends TrackerDomain> = InitialListError<D> | RefreshListError<D>;

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

export type ScreenTrackerDecision =
  | TrackerHealthCreateDecision<CreateEditorSnapshot<"health">>
  | { [D in TrackerDomain]: TrackerUpdateDecision<D, EditEditorSnapshot<D>> }[TrackerDomain]
  | { [D in TrackerDomain]: TrackerDeleteDecision<D, EditEditorSnapshot<D>> }[TrackerDomain];

type HealthCreateConfirmation = Readonly<{
    tag: "confirm.healthCreate";
    owner: OperationOwner<"health", "create">;
    decision: TrackerHealthCreateDecision<CreateEditorSnapshot<"health">>;
  }>;

type UpdateConfirmation<D extends TrackerDomain> = Readonly<{
    tag: "confirm.update";
    owner: OperationOwner<D, "update">;
    decision: TrackerUpdateDecision<D, EditEditorSnapshot<D>>;
  }>;

type DeleteConfirmation<D extends TrackerDomain> = Readonly<{
    tag: "confirm.delete";
    owner: OperationOwner<D, "delete">;
    decision: TrackerDeleteDecision<D, EditEditorSnapshot<D>>;
  }>;

interface ConfirmationStateByDomain {
  readonly growth: UpdateConfirmation<"growth"> | DeleteConfirmation<"growth">;
  readonly feeding: UpdateConfirmation<"feeding"> | DeleteConfirmation<"feeding">;
  readonly sleep: UpdateConfirmation<"sleep"> | DeleteConfirmation<"sleep">;
  readonly diaper: UpdateConfirmation<"diaper"> | DeleteConfirmation<"diaper">;
  readonly health: HealthCreateConfirmation | UpdateConfirmation<"health"> | DeleteConfirmation<"health">;
}

type ConfirmationState<D extends TrackerDomain> = ConfirmationStateByDomain[D];

type DirectCreateSubmitting<D extends LowRiskDomain> = Readonly<{
  tag: "mutation.submitting";
  owner: OperationOwner<D, "create">;
  prior: CreateEditorSnapshot<D>;
  phase: "direct";
  decision?: never;
}>;

type HealthCreateProbeSubmitting = Readonly<{
  tag: "mutation.submitting";
  owner: OperationOwner<"health", "create">;
  prior: CreateEditorSnapshot<"health">;
  phase: "probe";
  decision?: never;
}>;

type UpdateProbeSubmitting<D extends TrackerDomain> = Readonly<{
  tag: "mutation.submitting";
  owner: OperationOwner<D, "update">;
  prior: EditEditorSnapshot<D>;
  phase: "probe";
  decision?: never;
}>;

type DeleteProbeSubmitting<D extends TrackerDomain> = Readonly<{
  tag: "mutation.submitting";
  owner: OperationOwner<D, "delete">;
  prior: EditEditorSnapshot<D>;
  phase: "probe";
  decision?: never;
}>;

type ConfirmedSubmitting<D extends TrackerDomain> =
  | Readonly<{
    tag: "mutation.submitting";
    owner: OperationOwner<D, "update">;
    prior: EditEditorSnapshot<D>;
    phase: "confirmed";
    decision: TrackerUpdateDecision<D, EditEditorSnapshot<D>>;
  }>
  | Readonly<{
    tag: "mutation.submitting";
    owner: OperationOwner<D, "delete">;
    prior: EditEditorSnapshot<D>;
    phase: "confirmed";
    decision: TrackerDeleteDecision<D, EditEditorSnapshot<D>>;
  }>
  | (D extends "health" ? Readonly<{
    tag: "mutation.submitting";
    owner: OperationOwner<"health", "create">;
    prior: CreateEditorSnapshot<"health">;
    phase: "confirmed";
    decision: TrackerHealthCreateDecision<CreateEditorSnapshot<"health">>;
  }> : never);

interface MutationSubmittingByDomain {
  readonly growth: DirectCreateSubmitting<"growth"> | UpdateProbeSubmitting<"growth"> | DeleteProbeSubmitting<"growth"> | ConfirmedSubmitting<"growth">;
  readonly feeding: DirectCreateSubmitting<"feeding"> | UpdateProbeSubmitting<"feeding"> | DeleteProbeSubmitting<"feeding"> | ConfirmedSubmitting<"feeding">;
  readonly sleep: DirectCreateSubmitting<"sleep"> | UpdateProbeSubmitting<"sleep"> | DeleteProbeSubmitting<"sleep"> | ConfirmedSubmitting<"sleep">;
  readonly diaper: DirectCreateSubmitting<"diaper"> | UpdateProbeSubmitting<"diaper"> | DeleteProbeSubmitting<"diaper"> | ConfirmedSubmitting<"diaper">;
  readonly health: HealthCreateProbeSubmitting | UpdateProbeSubmitting<"health"> | DeleteProbeSubmitting<"health"> | ConfirmedSubmitting<"health">;
}

type MutationSubmitting<D extends TrackerDomain> = MutationSubmittingByDomain[D];

type MutationCompleted<D extends TrackerDomain> = {
  [K in MutationKind]: Readonly<{
    tag: "mutation.completed";
    owner: OperationOwner<D, K>;
    prior: K extends "create" ? CreateEditorSnapshot<D> : EditEditorSnapshot<D>;
    completion: MutationCompletion<D, K>;
  }>;
}[MutationKind];

export type DomainState<D extends TrackerDomain> =
  | OrdinaryListLoading<D>
  | RefreshListLoading<D>
  | ListReady<D>
  | ListError<D>
  | Readonly<{ tag: "create.editing"; editor: CreateEditorSnapshot<D>; notice?: string }>
  | EditLoading<D>
  | EditError<D>
  | Readonly<{ tag: "edit.editing"; editor: EditEditorSnapshot<D>; notice?: string }>
  | SuspendedRead<D>
  | ConfirmationState<D>
  | MutationSubmitting<D>
  | MutationCompleted<D>;

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

type DirectCreateStartedAction<D extends LowRiskDomain> = Readonly<{
    type: "MUTATION_STARTED";
    owner: OperationOwner<D, "create">;
    prior: CreateEditorSnapshot<D>;
    phase?: "direct";
    decision?: never;
  }>;

type HealthCreateProbeStartedAction = Readonly<{
    type: "MUTATION_STARTED";
    owner: OperationOwner<"health", "create">;
    prior: CreateEditorSnapshot<"health">;
    phase: "probe";
    decision?: never;
  }>;

type UpdateProbeStartedAction<D extends TrackerDomain> = Readonly<{
    type: "MUTATION_STARTED";
    owner: OperationOwner<D, "update">;
    prior: EditEditorSnapshot<D>;
    phase: "probe";
    decision?: never;
  }>;

type DeleteProbeStartedAction<D extends TrackerDomain> = Readonly<{
    type: "MUTATION_STARTED";
    owner: OperationOwner<D, "delete">;
    prior: EditEditorSnapshot<D>;
    phase: "probe";
    decision?: never;
  }>;

type UpdateConfirmedStartedAction<D extends TrackerDomain> = Readonly<{
    type: "MUTATION_STARTED";
    owner: OperationOwner<D, "update">;
    prior: EditEditorSnapshot<D>;
    phase: "confirmed";
    decision: TrackerUpdateDecision<D, EditEditorSnapshot<D>>;
  }>;

type DeleteConfirmedStartedAction<D extends TrackerDomain> = Readonly<{
    type: "MUTATION_STARTED";
    owner: OperationOwner<D, "delete">;
    prior: EditEditorSnapshot<D>;
    phase: "confirmed";
    decision: TrackerDeleteDecision<D, EditEditorSnapshot<D>>;
  }>;

type HealthCreateConfirmedStartedAction = Readonly<{
    type: "MUTATION_STARTED";
    owner: OperationOwner<"health", "create">;
    prior: CreateEditorSnapshot<"health">;
    phase: "confirmed";
    decision: TrackerHealthCreateDecision<CreateEditorSnapshot<"health">>;
  }>;

type EditMutationStartedAction<D extends TrackerDomain> =
  | UpdateProbeStartedAction<D>
  | DeleteProbeStartedAction<D>
  | UpdateConfirmedStartedAction<D>
  | DeleteConfirmedStartedAction<D>;

interface MutationStartedActionByDomain {
  readonly growth: DirectCreateStartedAction<"growth"> | EditMutationStartedAction<"growth">;
  readonly feeding: DirectCreateStartedAction<"feeding"> | EditMutationStartedAction<"feeding">;
  readonly sleep: DirectCreateStartedAction<"sleep"> | EditMutationStartedAction<"sleep">;
  readonly diaper: DirectCreateStartedAction<"diaper"> | EditMutationStartedAction<"diaper">;
  readonly health: HealthCreateProbeStartedAction | HealthCreateConfirmedStartedAction | EditMutationStartedAction<"health">;
}

type MutationStartedAction<D extends TrackerDomain> = MutationStartedActionByDomain[D];

interface ConfirmationRequiredActionByDomain {
  readonly growth: Readonly<{ type: "CONFIRMATION_REQUIRED"; owner: OperationOwner<"growth", "update">; next: UpdateConfirmation<"growth"> }>
    | Readonly<{ type: "CONFIRMATION_REQUIRED"; owner: OperationOwner<"growth", "delete">; next: DeleteConfirmation<"growth"> }>;
  readonly feeding: Readonly<{ type: "CONFIRMATION_REQUIRED"; owner: OperationOwner<"feeding", "update">; next: UpdateConfirmation<"feeding"> }>
    | Readonly<{ type: "CONFIRMATION_REQUIRED"; owner: OperationOwner<"feeding", "delete">; next: DeleteConfirmation<"feeding"> }>;
  readonly sleep: Readonly<{ type: "CONFIRMATION_REQUIRED"; owner: OperationOwner<"sleep", "update">; next: UpdateConfirmation<"sleep"> }>
    | Readonly<{ type: "CONFIRMATION_REQUIRED"; owner: OperationOwner<"sleep", "delete">; next: DeleteConfirmation<"sleep"> }>;
  readonly diaper: Readonly<{ type: "CONFIRMATION_REQUIRED"; owner: OperationOwner<"diaper", "update">; next: UpdateConfirmation<"diaper"> }>
    | Readonly<{ type: "CONFIRMATION_REQUIRED"; owner: OperationOwner<"diaper", "delete">; next: DeleteConfirmation<"diaper"> }>;
  readonly health: Readonly<{ type: "CONFIRMATION_REQUIRED"; owner: OperationOwner<"health", "create">; next: HealthCreateConfirmation }>
    | Readonly<{ type: "CONFIRMATION_REQUIRED"; owner: OperationOwner<"health", "update">; next: UpdateConfirmation<"health"> }>
    | Readonly<{ type: "CONFIRMATION_REQUIRED"; owner: OperationOwner<"health", "delete">; next: DeleteConfirmation<"health"> }>;
}

type ConfirmationRequiredAction<D extends TrackerDomain> = ConfirmationRequiredActionByDomain[D];

type ConfirmationCancelledAction = Readonly<{
  type: "CONFIRMATION_CANCELLED";
  decision: ScreenTrackerDecision;
}>;

type NormalizedNoopAction<D extends TrackerDomain> = Readonly<{
  type: "NORMALIZED_NOOP";
  owner: OperationOwner<D, "update">;
  editor: EditEditorSnapshot<D>;
}>;

type MutationRejectedAction<D extends TrackerDomain> = Readonly<{
  type: "MUTATION_REJECTED";
  owner: OperationOwner<D>;
  field?: string;
  message: string;
}>;

type MutationCompletedAction<D extends TrackerDomain> = {
  [K in MutationKind]: Readonly<{
    type: "MUTATION_COMPLETED";
    owner: OperationOwner<D, K>;
    completion: MutationCompletion<D, K>;
  }>;
}[MutationKind];

type RefreshStartedAction<D extends TrackerDomain> = {
  [K in MutationKind]: Readonly<{
    type: "OPERATION_REFRESH_STARTED";
    owner: OperationOwner<D, K>;
    next: Readonly<{
      tag: "list.loading";
      source: "mutation-refresh";
      owner: OperationOwner<D, K>;
      prior: ListFact<D>;
      success: string;
    }>;
  }>;
}[MutationKind];

type RefreshSucceededAction<D extends TrackerDomain> = Readonly<{
  type: "OPERATION_REFRESH_SUCCEEDED";
  owner: OperationOwner<D>;
  fact: ListFact<D>;
}>;

type RefreshFailedAction<D extends TrackerDomain> = Readonly<{
  type: "OPERATION_REFRESH_FAILED";
  owner: OperationOwner<D>;
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
  | ConfirmationRequiredAction<D>
  | ConfirmationCancelledAction
  | NormalizedNoopAction<D>
  | MutationRejectedAction<D>
  | MutationCompletedAction<D>
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

type DirectCreateStartedArgs = {
  [D in LowRiskDomain]: readonly [
    owner: OperationOwner<D, "create">,
    prior: CreateEditorSnapshot<D>,
  ];
}[LowRiskDomain];

type UpdateProbeStartedArgs = {
  [D in TrackerDomain]: readonly [
    owner: OperationOwner<D, "update">,
    prior: EditEditorSnapshot<D>,
  ];
}[TrackerDomain];

type DeleteProbeStartedArgs = {
  [D in TrackerDomain]: readonly [
    owner: OperationOwner<D, "delete">,
    prior: EditEditorSnapshot<D>,
  ];
}[TrackerDomain];

type UpdateDecisionArgs = {
  [D in TrackerDomain]: readonly [
    owner: OperationOwner<D, "update">,
    decision: TrackerUpdateDecision<D, EditEditorSnapshot<D>>,
  ];
}[TrackerDomain];

type DeleteDecisionArgs = {
  [D in TrackerDomain]: readonly [
    owner: OperationOwner<D, "delete">,
    decision: TrackerDeleteDecision<D, EditEditorSnapshot<D>>,
  ];
}[TrackerDomain];

type MutationCompletedArgs = {
  [D in TrackerDomain]: {
    [K in MutationKind]: readonly [
      owner: OperationOwner<D, K>,
      completion: MutationCompletion<D, K>,
    ];
  }[MutationKind];
}[TrackerDomain];

type OperationRefreshStartedArgs = {
  [D in TrackerDomain]: {
    [K in MutationKind]: readonly [
      owner: OperationOwner<D, K>,
      prior: ListFact<D>,
      success: string,
    ];
  }[MutationKind];
}[TrackerDomain];

export function correlatedAction<D extends TrackerDomain>(action: DomainAction<D>): CorrelatedTrackerScreenAction {
  return action as CorrelatedTrackerScreenAction;
}

export function directCreateStartedAction(
  ...[owner, prior]: DirectCreateStartedArgs
): CorrelatedTrackerScreenAction {
  return { type: "MUTATION_STARTED", owner, prior, phase: "direct" } as CorrelatedTrackerScreenAction;
}

export function updateProbeStartedAction(
  ...[owner, prior]: UpdateProbeStartedArgs
): CorrelatedTrackerScreenAction {
  return { type: "MUTATION_STARTED", owner, prior, phase: "probe" } as CorrelatedTrackerScreenAction;
}

export function deleteProbeStartedAction(
  ...[owner, prior]: DeleteProbeStartedArgs
): CorrelatedTrackerScreenAction {
  return { type: "MUTATION_STARTED", owner, prior, phase: "probe" } as CorrelatedTrackerScreenAction;
}

export function updateConfirmationRequiredAction(
  ...[owner, decision]: UpdateDecisionArgs
): CorrelatedTrackerScreenAction {
  return {
    type: "CONFIRMATION_REQUIRED",
    owner,
    next: Object.freeze({ tag: "confirm.update", owner, decision }),
  } as CorrelatedTrackerScreenAction;
}

export function deleteConfirmationRequiredAction(
  ...[owner, decision]: DeleteDecisionArgs
): CorrelatedTrackerScreenAction {
  return {
    type: "CONFIRMATION_REQUIRED",
    owner,
    next: Object.freeze({ tag: "confirm.delete", owner, decision }),
  } as CorrelatedTrackerScreenAction;
}

export function updateConfirmedStartedAction(
  ...[owner, decision]: UpdateDecisionArgs
): CorrelatedTrackerScreenAction {
  return {
    type: "MUTATION_STARTED", owner, prior: decision.prior, phase: "confirmed", decision,
  } as CorrelatedTrackerScreenAction;
}

export function deleteConfirmedStartedAction(
  ...[owner, decision]: DeleteDecisionArgs
): CorrelatedTrackerScreenAction {
  return {
    type: "MUTATION_STARTED", owner, prior: decision.prior, phase: "confirmed", decision,
  } as CorrelatedTrackerScreenAction;
}

export function mutationCompletedAction(
  ...[owner, completion]: MutationCompletedArgs
): CorrelatedTrackerScreenAction {
  return { type: "MUTATION_COMPLETED", owner, completion } as CorrelatedTrackerScreenAction;
}

export function operationRefreshStartedAction(
  ...[owner, prior, success]: OperationRefreshStartedArgs
): CorrelatedTrackerScreenAction {
  return {
    type: "OPERATION_REFRESH_STARTED",
    owner,
    next: Object.freeze({ tag: "list.loading", source: "mutation-refresh", owner, prior, success }),
  } as CorrelatedTrackerScreenAction;
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
    case "confirm.healthCreate":
    case "confirm.update":
    case "confirm.delete": return state.decision.domain;
    case "edit.loading":
    case "edit.error": return state.prior.domain;
    case "read.suspended": return state.request.prior.domain;
    case "mutation.submitting": return state.prior.domain;
    case "mutation.completed": return state.prior.domain;
  }
}

function correlatedState(value: unknown): TrackerScreenState {
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

function isDeleteReconciledPrior<D extends TrackerDomain>(
  original: ListFact<D>,
  reconciled: ListFact<D>,
  deletedId: string,
): boolean {
  if (reconciled.domain !== original.domain || reconciled.presentationZone !== original.presentationZone) return false;
  const expectedRows = original.rows.filter((row) => row.id !== deletedId);
  return reconciled.rows.length === expectedRows.length
    && expectedRows.every((row, index) => reconciled.rows[index] === row);
}

function isRecordForDomain(domain: TrackerDomain, record: unknown): boolean {
  if (record === null || typeof record !== "object") return false;
  try {
    normalizePersistedTrackerRecord(domain, record as TrackerRecordByDomain[TrackerDomain]);
    return true;
  } catch {
    return false;
  }
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
    case "MUTATION_STARTED": {
      const startingDirectCreate = state.tag === "create.editing"
        && state.editor === action.prior
        && action.owner.kind === "create"
        && action.owner.domain !== "health"
        && (action.phase === undefined || action.phase === "direct")
        && action.decision === undefined;
      const startingHealthCreateProbe = state.tag === "create.editing"
        && state.editor === action.prior
        && action.owner.kind === "create"
        && action.owner.domain === "health"
        && action.phase === "probe"
        && action.decision === undefined;
      const startingEditProbe = state.tag === "edit.editing"
        && state.editor === action.prior
        && (action.owner.kind === "update" || action.owner.kind === "delete")
        && action.phase === "probe"
        && action.decision === undefined;
      const startingFromDecision = (state.tag === "confirm.healthCreate" || state.tag === "confirm.update" || state.tag === "confirm.delete")
        && action.phase === "confirmed"
        && state.decision === action.decision
        && state.decision.prior === action.prior
        && state.decision.kind === (action.owner.kind === "create" ? "healthCreate" : action.owner.kind)
        && sameOperationOwner(state.owner, action.owner);
      if (
        (!startingDirectCreate && !startingHealthCreateProbe && !startingEditProbe && !startingFromDecision)
        || action.owner.domain !== action.prior.domain
        || (action.owner.kind === "create") !== (action.prior.mode === "create")
        || (action.owner.kind !== "create") !== (action.prior.mode === "edit")
      ) return state;
      return correlatedState(Object.freeze({
        tag: "mutation.submitting", owner: action.owner, prior: action.prior,
        phase: action.phase ?? "direct", decision: action.decision,
      }));
    }
    case "CONFIRMATION_REQUIRED":
      if (
        state.tag !== "mutation.submitting"
        || state.phase !== "probe"
        || !sameOperationOwner(state.owner, action.owner)
        || action.next.owner !== action.owner
        || action.next.decision.prior !== state.prior
        || action.next.decision.domain !== action.owner.domain
      ) return state;
      return correlatedState(action.next);
    case "CONFIRMATION_CANCELLED": {
      if (action.decision === undefined) return state;
      if (
        (state.tag !== "confirm.healthCreate" && state.tag !== "confirm.update" && state.tag !== "confirm.delete")
        || state.decision !== action.decision
      ) return state;
      return action.decision.prior.mode === "create"
        ? correlatedState(Object.freeze({ tag: "create.editing", editor: action.decision.prior }))
        : correlatedState(Object.freeze({ tag: "edit.editing", editor: action.decision.prior }));
    }
    case "NORMALIZED_NOOP":
      if (state.tag === "edit.editing") {
        if (state.editor !== action.editor || action.editor.mode !== "edit" || action.editor.domain !== action.owner.domain) return state;
        return correlatedState(Object.freeze({ tag: "edit.editing", editor: action.editor, notice: "内容没有更改。" }));
      }
      if (
        state.tag !== "mutation.submitting"
        || state.owner.kind !== "update"
        || !sameOperationOwner(state.owner, action.owner)
        || action.editor.mode !== "edit"
        || action.editor.domain !== state.prior.domain
        || state.prior.mode !== "edit"
        || action.editor.baseline !== state.prior.baseline
        || action.editor.prior !== state.prior.prior
      ) return state;
      return correlatedState(Object.freeze({ tag: "edit.editing", editor: action.editor, notice: "内容没有更改。" }));
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
    case "MUTATION_COMPLETED": {
      if (
        state.tag !== "mutation.submitting"
        || state.phase === "probe"
        || !sameOperationOwner(state.owner, action.owner)
        || action.completion.kind !== action.owner.kind
      ) return state;
      if (action.completion.kind === "delete") {
        if (
          state.prior.mode !== "edit"
          || action.completion.deletion.domain !== action.owner.domain
          || action.completion.deletion.id !== state.prior.baseline.id
        ) return state;
      } else if (
        !isRecordForDomain(action.owner.domain, action.completion.record)
        || (action.completion.kind === "create" && state.prior.mode !== "create")
        || (action.completion.kind === "update" && (
          state.prior.mode !== "edit"
          || action.completion.record.id !== state.prior.baseline.id
        ))
      ) return state;
      return correlatedState(Object.freeze({
        tag: "mutation.completed",
        owner: action.owner,
        prior: state.prior,
        completion: action.completion,
      }));
    }
    case "OPERATION_REFRESH_STARTED":
      if (
        state.tag !== "mutation.completed"
        || !sameOperationOwner(state.owner, action.owner)
        || action.next.source !== "mutation-refresh"
        || !sameOperationOwner(action.next.owner, action.owner)
        || action.next.prior.domain !== action.owner.domain
      ) return state;
      if (state.completion.kind === "delete") {
        if (!isDeleteReconciledPrior(state.prior.prior, action.next.prior, state.completion.deletion.id)) return state;
      } else if (action.next.prior !== state.prior.prior) return state;
      return correlatedState(Object.freeze({ ...action.next, completion: state.completion }));
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
      return correlatedState(Object.freeze({
        tag: "list.error",
        kind: "refresh",
        fact: state.prior,
        owner: state.owner,
        completion: state.completion,
        success: state.success,
      }));
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
