/**
 * The workflow definition schema — the first real, validated shape of a
 * workflow's logic.
 *
 * A definition is the immutable JSON document stored in
 * `workflow_versions.definition`. This module is the single authority on what a
 * valid one looks like, so three very different producers agree on one contract:
 * manual workflow creation, new-version creation, and (later) AI-generated
 * workflows. Validation lives here, in framework-free domain code, not in a route
 * handler or the database.
 *
 * Scope for this stage is deliberately tiny: **linear workflows of `noop`
 * steps.** No branching, conditions, loops, parallelism, sub-workflows, waits or
 * real step types exist yet, and the schema is written to *reject* them rather
 * than quietly ignore them — an unknown step type is an error, not a no-op. The
 * shape is designed to grow (the step is already a discriminated union on
 * `type`), so adding `llm`/`action` later is a new union member plus a schema
 * version bump, not a rewrite.
 */

import { z } from 'zod';

/**
 * The definition-format version, distinct from a workflow's row `version`
 * number. It identifies which *schema* the document was written against, so a
 * future format change is an explicit, detectable bump rather than a silent
 * reinterpretation of old data. Only `1` exists today.
 */
export const DEFINITION_SCHEMA_VERSION = 1;

/**
 * Step keys are safe identifiers: lowercase, starting with a letter, then
 * letters/digits/underscores, up to 64 chars. They are referenced by other steps
 * (once ordering/branching exists) and appear in logs and run state, so they must
 * be predictable tokens — not arbitrary text with spaces, punctuation or casing
 * surprises.
 */
export const STEP_KEY_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** The step types the engine understands. Only `noop` in this stage. */
export const SUPPORTED_STEP_TYPES = ['noop'] as const;
export type StepType = (typeof SUPPORTED_STEP_TYPES)[number];

const stepKey = z
  .string()
  .regex(STEP_KEY_PATTERN, 'step key must be a lowercase identifier (a-z, 0-9, _), starting with a letter');

/**
 * A `noop` step: does nothing when executed (execution is not built here). Its
 * config is an empty object — `.strict()` rejects unknown keys so a typo'd or
 * unsupported option fails validation instead of being silently dropped.
 */
const noopStep = z
  .object({
    key: stepKey,
    type: z.literal('noop'),
    config: z.object({}).strict().default({}),
  })
  .strict();

/**
 * A single step. A discriminated union on `type` so that (a) each type can carry
 * its own config shape, and (b) an unsupported `type` produces a clear "invalid
 * discriminator" error rather than being coerced. Today the union has one member.
 */
export const stepSchema = z.discriminatedUnion('type', [noopStep]);

export type WorkflowStep = z.infer<typeof stepSchema>;

/**
 * A complete workflow definition: a schema version and a non-empty, ordered list
 * of steps with unique keys. `.strict()` forbids stray top-level fields so the
 * document cannot smuggle in structure the engine will not honour.
 */
export const workflowDefinitionSchema = z
  .object({
    version: z.literal(DEFINITION_SCHEMA_VERSION),
    steps: z.array(stepSchema).min(1, 'a workflow needs at least one step'),
  })
  .strict()
  .superRefine((definition, ctx) => {
    const seen = new Set<string>();
    for (const [index, step] of definition.steps.entries()) {
      if (seen.has(step.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate step key "${step.key}"`,
          path: ['steps', index, 'key'],
        });
      }
      seen.add(step.key);
    }
  });

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

/**
 * Parse and validate an unknown value as a workflow definition. Returns the
 * validated (and defaulted) definition or throws `ZodError`. Callers that want a
 * domain error should catch and translate.
 */
export function parseWorkflowDefinition(input: unknown): WorkflowDefinition {
  return workflowDefinitionSchema.parse(input);
}
