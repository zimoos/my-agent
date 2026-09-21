# MA Runtime Module

## Ownership and current scope

- Feature development A owns production files and this module document. Independent Q owns tests and fixtures; feature development must not edit them.
- Batch A1 defines only the six exported data contracts in `contracts.ts`; those types do not validate or authorize values. Batch A2 adds only the standalone execution journal and its structural/association validation.
- `execution-journal.ts` owns a private per-session `execution.jsonl` and `.writer.lock`. Its writer assigns contiguous sequence numbers, accepts at most 256 unfinished appends including the active sync, and synchronizes accepted records before resolving them. A write/sync failure prevents further writes by that instance.
- Complete invalid records are corruption; an unconfirmed final segment is reported separately and prevents opening a writer. Never truncate, skip corrupt complete lines, or clear a crashed writer's lock. `readExecutionJournal` is diagnostic only and does not acquire write authority or repair data.
- A2 does not implement identity issuance, tool/Cloud authorization, Turn gating, Pi history restoration, or owner-death lock recovery. A recorded receipt remains caller-supplied data, not independently verified external evidence.
- A3 adds `turn-gate.ts` for a fresh journal in one process. Its async factory reads the journal before exposing the gate. Existing records or an incomplete tail require recovery; read/write failure pauses the gate. Neither path silently resumes an old Turn.
- One journal object has one gate owner: calls for the same session share initialization and the same gate instance; a conflicting session is rejected with `TURN_INVALID_SCOPE`. Ownership is registered before journal reading, so concurrent factory calls share cancellation state. A newly opened journal object still follows the existing-record recovery requirement.
- `stop` fences the target Turn synchronously, including a pending registration or dispatch fsync. Dispatch attempts already entering the journal remain in-flight even if cancellation prevents returning a permit. A permit proves durable local intent only, not tool authorization, a Cloud budget grant, or remote execution.
- A3 binds subsequent Turns to the first operationId and budgetRef; a larger epoch or new stage does not grant a new budget. Trusted task rebinding and external receipt verification remain later facade/tool-bridge work. Diagnostic recovery may clear an old dispatch only for a matching full Invocation and non-unknown receipt; stopConfirmed alone cannot clear unknown risk.
- Follow the coordinator's frozen batch scope. Later journal, event, permit, and constructor contracts require their own approved implementation node.

## Boundaries for later implementation

- Pi owns model conversation history and its execution loop. This module may own execution correlation and recovery facts, but must not introduce a second transcript or loop.
- Host identity, permissions, current Turn, and Cloud budget authorization must be checked at their trusted boundaries. A TypeScript shape, ID string, hash, or receipt is not proof of authorization.
- Keep model logicalCallId/callId separate from tool toolCallId/executionId. Keep tool serverId and toolName together when correlating receipts.
- Do not persist raw tool arguments, credentials, Host tokens, or resolvable Secure Input references in execution journals or model history. Persist only the approved hashes, scope data, and safe receipt references.
- Future execution dispatch must follow durable intent recording; future receipt confirmation must follow durable receipt storage. A2 supplies durable journal records but does not wire either ordering guarantee into an executor or Pi.
- Unknown execution results must remain unknown until supported by trustworthy evidence. Cancellation, transport disconnect, or process exit alone does not prove remote execution stopped or that effects did not occur.
- Ordinary confirmed diagnostic failures do not become permanent unfinished obligations. An unrelated success must not erase an unknown effect or an unmet required action.
- This module must not claim Mission acceptance, change Cloud balances, implement Agora internal memory, or silently fall back to the old Agent loop.
