// Public facade for the turn lifecycle. The implementation lives in ./turns/,
// one module per concern; every consumer (API routes, CLI, tests) imports from
// here so the internal layout can evolve without breaking call sites.
//
//   turns/create-turn.ts    createTurn / answerClarification / plan parking
//   turns/dispatch.ts       approveTurn / dispatchTurn (DAG run) / interruptTurn
//   turns/final-delivery.ts decideTurnFinalDelivery + final repair pass
//   turns/turn-store.ts     listTurns / getTurn / deleteTurn / access scoping
//   turns/planning.ts       heuristic plan + task titling/patching
//   turns/fix-loop.ts       review gate + fixer task derivation
//   turns/artifacts.ts      intake/plan/report artifact builders
//   turns/handoffs.ts       handoff cards + agent prompt context
//   turns/workspace.ts      workspace resolution + run-output hygiene
//   turns/live-activity.ts  response-time runtime transcripts
export { answerClarification, createTurn, type CreateTurnInput } from './turns/create-turn.js';
export {
  approveTurn,
  dispatchTurn,
  interruptTurn,
  type ApprovalInput,
  type DispatchInput,
} from './turns/dispatch.js';
export { decideTurnFinalDelivery, type FinalDeliveryInput } from './turns/final-delivery.js';
export { deleteTurn, getTurn, listTurns } from './turns/turn-store.js';
export { plannedTaskPatches } from './turns/planning.js';
export {
  isReviewGateTask,
  makeFixerTask,
  repairedTargetArtifact,
  reviewSeverities,
  shouldAttemptFix,
} from './turns/fix-loop.js';
export { type DispatchResponse, type TurnResponse } from './turns/responses.js';
export { ActionError } from './turns/errors.js';
