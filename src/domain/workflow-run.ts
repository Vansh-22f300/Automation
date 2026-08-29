/**
 * The initial context of a workflow run.
 *
 * A run carries a small, structured state document. At creation it holds only the
 * trigger that started it and an empty `steps` map that the executor (Step 5+)
 * will fill as it runs each step. This is deliberately *not* a general context
 * engine — just the minimal, stable shape the run needs to exist.
 */

/** The trigger facts a run is born knowing. */
export interface TriggerContext {
  readonly source: string;
  readonly event_id: string;
  readonly payload: unknown;
}

/** The whole run-context document as stored in `workflow_runs.context`. */
export interface RunContext {
  readonly trigger: TriggerContext;
  /** Per-step results, keyed by step key. Empty until execution runs (later). */
  readonly steps: Record<string, unknown>;
}

/** Build the context for a newly created run from its triggering event. */
export function buildRunContext(input: {
  source: string;
  eventId: string;
  payload: unknown;
}): RunContext {
  return {
    trigger: { source: input.source, event_id: input.eventId, payload: input.payload },
    steps: {},
  };
}
