import { ownData } from './data.js';
import type { MaRequestBudget, MaRuntimeError } from './public-types.js';

const messages: Record<string, string> = {
  MA_MEMORY_STATE_INVALID: 'The saved memory verification record is invalid or has unsafe file permissions. Inspect the existing record before continuing; no memory operation was replayed.',
  MA_MEMORY_IDENTITY_MISMATCH: 'The saved memory verification belongs to a different session or provider profile. Reopen its original session; no memory operation was replayed.',
  MA_COMPLETION_CONTEXT_INVALID: 'The saved tool exchange is inconsistent. Reconcile the saved session before requesting a closing summary.',
  MA_COMPLETION_TOOL_FORBIDDEN: 'The closing response attempted new work. No new tool execution was authorized.',
  MA_COMPLETION_EXTRA_CALL_FORBIDDEN: 'The protected closing turn permits only one model request. No additional request was authorized.',
  MA_RESUME_SESSION_NOT_FOUND: 'The requested saved session was not found. Check its identity or explicitly create a new session.',
  MA_PI_SESSION_ROUND_TRIP_FAILED: 'The Pi session could not be saved and reopened consistently. No model request was sent.',
  MA_BRANCH_TARGET_NOT_FOUND: 'The selected branch entry is not in this saved session. Refresh the session history and select an existing entry; no model request was sent.',
  MA_LEGACY_SESSION_ARCHIVE_ONLY: 'This session belongs to the previous MA engine. Its history is preserved; start a new MA Next session to continue.',
  MA_SESSION_CLOSED: 'This session is closed. Open a new session to continue.',
  MA_BOOTSTRAP_INVALID: 'The MA session configuration is incomplete or inconsistent. Refresh the client configuration.',
  MA_INPUT_INVALID: 'This input format is not supported. Use text or an image supported by the selected model.',
  MA_HOST_EVENT_DELIVERY_FAILED: 'The client connection interrupted delivery of the result. Check the saved session before starting another action.',
  MA_MODEL_IMAGE_UNSUPPORTED: 'The selected model does not accept images. Choose an image-capable profile or remove the image.',
  MA_OPERATION_PRICE_SNAPSHOT_UNAVAILABLE: 'This request is outside the selected approved price profile. Reduce its context or choose an explicitly priced profile; no new model request was authorized.',
  MA_OPERATION_BUDGET_EXCEEDED: 'This request exceeds the available task budget. Reduce its context or explicitly approve more budget; no new model request was authorized.',
  MTEAM_REQUEST_BUDGET_EXCEEDED: 'This request exceeds the available task budget. Adjust the request or explicitly approve more budget.',
  INSUFFICIENT_CREDITS: 'There are not enough available credits for this request. Check the task budget and account balance.',
  MA_OPERATION_QUOTE_EXPIRED: 'The approved request quote changed before dispatch. Refresh the request approval before continuing.',
  MA_MODEL_REQUEST_REJECTED: 'The selected model rejected the request format or parameters. Correct the model profile before explicitly trying again.',
  MA_MODEL_CONFIG_OVERRIDE_FORBIDDEN: 'This model profile overrides protected request fields. Remove those overrides before starting the session.',
  MA_MODEL_PREPARATION_MISMATCH: 'The selected model or request approval changed. Refresh the session before trying again.',
  MA_MODEL_MISSING_FINISH: 'The model connection ended without a confirmed completion. Its execution remains unresolved.',
  MA_MODEL_OUTCOME_UNKNOWN: 'The model execution could not be confirmed. Check its existing receipt before retrying.',
  MA_EXECUTION_UNRESOLVED: 'An earlier execution has an unknown result. Verify that execution before starting another action.',
  MA_RECOVERY_REQUIRED: 'This saved session requires execution reconciliation before it can continue.',
  MA_VUI_FRAME_INVALID: 'The virtual UI returned an invalid or mismatched frame. Reopen the current view before acting.',
  MA_SESSION_BUSY: 'This session is already running or closing. Stop the current turn or wait for it to finish.',
  MA_SKILL_ARGUMENT_REQUIRED: 'A required skill argument is missing. Supply the arguments declared by that skill.',
  MA_SKILL_ARGUMENT_TYPE: 'A skill argument has the wrong type. Check the skill argument declaration.',
  MA_SKILL_ARGUMENTS_INVALID: 'Skill arguments must use name=value syntax.',
  MA_TURN_DEADLINE: 'The current task reached its approved time limit. Resume with a new authorized turn.',
  TURN_REVOKED: 'This turn was stopped. Start a new authorized turn to continue.',
  TURN_JOURNAL_FAILED: 'Execution records could not be saved. Restore local storage before continuing.',
  TURN_RECOVERY_REQUIRED: 'This saved session requires execution reconciliation before it can continue.',
  UNAUTHORIZED: 'The model session is no longer authorized. Sign in again or refresh its authorization.',
  FORBIDDEN: 'The selected action is not permitted by this session.',
  MODEL_UNAVAILABLE: 'The selected model service is unavailable. Check its service status before retrying.',
};

export function parseRequestBudget(value: unknown): MaRequestBudget | undefined {
  const input = ownData(value, 'inputBudget');
  const currentUnits = ownData(input, 'currentUnits'); const maxUnits = ownData(input, 'maxUnits');
  const maxOutputUnits = ownData(value, 'maxOutputUnits'); const availableCredits = ownData(value, 'availableCredits');
  const requiredCredits = ownData(value, 'requiredCredits');
  const constraint = ownData(value, 'constraint'); const basis = ownData(value, 'requiredCreditsBasis');
  if (ownData(value, 'schemaVersion') !== 1 || ownData(input, 'measurementId') !== 'provider-json-utf8-plus-framing-v1'
    || ownData(input, 'unit') !== 'conservative_input_units'
    || ![currentUnits, maxUnits, maxOutputUnits, availableCredits, requiredCredits].every(number => typeof number === 'number' && Number.isSafeInteger(number) && number >= 0)
    || maxOutputUnits === 0
    || (constraint !== undefined && (typeof constraint !== 'string' || !['supplier-risk', 'tokens', 'price-snapshot'].includes(constraint)))
    || (constraint === undefined && (requiredCredits as number) <= (availableCredits as number))
    || (constraint === 'price-snapshot' ? basis !== 'bounded-replacement' : basis !== undefined)) return undefined;
  return { schemaVersion: 1, inputBudget: { measurementId: 'provider-json-utf8-plus-framing-v1', unit: 'conservative_input_units',
    currentUnits: currentUnits as number, maxUnits: maxUnits as number }, maxOutputUnits: maxOutputUnits as number,
    availableCredits: availableCredits as number, requiredCredits: requiredCredits as number,
    ...(constraint ? { constraint: constraint as MaRequestBudget['constraint'] } : {}),
    ...(basis ? { requiredCreditsBasis: 'bounded-replacement' as const } : {}) };
}

/** Fixed public text and a narrowly validated budget hint only; no raw provider data. */
export function publicRuntimeError(error: unknown): MaRuntimeError {
  const nested = ownData(error, 'error');
  const body = ownData(nested, 'error') ?? nested;
  for (const code of [ownData(error, 'code'), ownData(body, 'code'), ownData(error, 'message')]) {
    if (typeof code === 'string' && Object.hasOwn(messages, code)) {
      const hint = ['MA_OPERATION_BUDGET_EXCEEDED', 'MA_OPERATION_PRICE_SNAPSHOT_UNAVAILABLE', 'INSUFFICIENT_CREDITS'].includes(code)
        ? parseRequestBudget(ownData(body, 'requestBudget') ?? ownData(error, 'requestBudget')) : undefined;
      return { code, message: messages[code], ...(hint ? { requestBudget: hint } : {}) };
    }
  }
  return { code: 'MA_RUNTIME_FAILED', message: 'The MA runtime could not complete this turn. Your input and saved execution records are retained.' };
}
