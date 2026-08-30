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

import { outputSchemaSchema } from '@/domain/output-schema.js';

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

/** The step types the engine understands. */
export const SUPPORTED_STEP_TYPES = ['noop', 'llm'] as const;
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

/** Default ceiling on tokens an `llm` step lets the model generate. */
export const DEFAULT_LLM_MAX_OUTPUT_TOKENS = 1024;
/** Hard ceiling on the configurable token limit, a guard against runaway cost. */
export const LLM_MAX_OUTPUT_TOKENS_LIMIT = 16_384;

/**
 * Tool names follow the same safe-identifier shape as step keys: lowercase,
 * starting with a letter, then letters/digits/underscores, up to 64 chars. This
 * is validated at authoring time so a malformed name is rejected before it could
 * ever be looked up in the registry.
 */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

/** Default number of tool rounds an `llm` step will run before giving up. */
export const DEFAULT_MAX_TOOL_ROUNDS = 3;
/** Hard cap on tool rounds — a bound against a runaway request/tool ping-pong. */
export const MAX_TOOL_ROUNDS_LIMIT = 5;

/**
 * A single tool binding on an `llm` step. `name` is a platform-registered tool
 * (the registry is the source of truth); `connection_id` is the TRUSTED workflow
 * config that binds the tool to a specific connection. `connection_id` is never
 * model input — it lives here, on the binding, structurally separate from the
 * model's argument path. `.strict()` rejects any other key.
 */
const llmToolBinding = z
  .object({
    name: z
      .string()
      .regex(TOOL_NAME_PATTERN, 'tool name must be a lowercase identifier (a-z, 0-9, _), starting with a letter'),
    connection_id: z.uuid('connection_id must be a valid UUID'),
  })
  .strict();

/**
 * The config of an `llm` step — the first step type that performs real AI
 * reasoning. Deliberately small:
 *
 * - `system` — the developer's instruction to the model. It is **static**: the
 *   trust boundary (see the LLM step handler) keeps configured instructions
 *   structurally separate from workflow data, so a reference token here is
 *   forbidden. It must never carry `{{…}}`; untrusted data goes in `input`.
 * - `input` — the user/content turn. A single string that is either a literal or
 *   one whole `{{…}}` reference resolved by the existing safe resolver against the
 *   run context (`{{trigger.payload.text}}`, `{{steps.classify.output}}`). This is
 *   the *only* place a reference is allowed, and the only place untrusted data
 *   enters the prompt.
 * - `output_schema` — the declarative, data-only shape the model must return
 *   (see `@/domain/output-schema`); compiled to a runtime validator, never code.
 * - `model` — optional per-step override; absent means the provider's default.
 * - `max_output_tokens` — ceiling on generated tokens; defaults, and is capped.
 *
 * `.strict()` rejects any other key. Temperature and multi-turn history are out
 * of scope for this step.
 */
const llmStep = z
  .object({
    key: stepKey,
    type: z.literal('llm'),
    config: z
      .object({
        system: z
          .string()
          .min(1, 'system instruction must not be empty')
          .refine(
            (s) => !s.includes('{{'),
            'system instruction must not contain references ("{{…}}"): it is a static, trusted instruction, ' +
              'kept separate from untrusted workflow data (which belongs in "input")',
          ),
        input: z.string().min(1, 'input must not be empty'),
        output_schema: outputSchemaSchema,
        model: z.string().min(1).optional(),
        max_output_tokens: z
          .number()
          .int('max_output_tokens must be an integer')
          .min(1, 'max_output_tokens must be at least 1')
          .max(LLM_MAX_OUTPUT_TOKENS_LIMIT, `max_output_tokens must not exceed ${LLM_MAX_OUTPUT_TOKENS_LIMIT}`)
          .default(DEFAULT_LLM_MAX_OUTPUT_TOKENS),
        /**
         * Tools the model may REQUEST during this step. Each binds a
         * platform-registered tool to a trusted connection. Absent → the step
         * cannot call tools at all (the no-tools path). Duplicate tool names are
         * rejected below.
         */
        tools: z.array(llmToolBinding).optional(),
        /**
         * How many request→execute rounds the bounded loop will run before the
         * step fails. Defaults, and is hard-capped, to bound cost and ping-pong.
         */
        max_tool_rounds: z
          .number()
          .int('max_tool_rounds must be an integer')
          .min(1, 'max_tool_rounds must be at least 1')
          .max(MAX_TOOL_ROUNDS_LIMIT, `max_tool_rounds must not exceed ${MAX_TOOL_ROUNDS_LIMIT}`)
          .default(DEFAULT_MAX_TOOL_ROUNDS),
      })
      .strict()
      .superRefine((config, ctx) => {
        // Unique tool names within one step: a duplicate binding is a wiring bug,
        // and the handler's model→connection map has one entry per name.
        if (config.tools !== undefined) {
          const seen = new Set<string>();
          for (const [index, tool] of config.tools.entries()) {
            if (seen.has(tool.name)) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `duplicate tool name "${tool.name}"`,
                path: ['tools', index, 'name'],
              });
            }
            seen.add(tool.name);
          }
        }
      }),
  })
  .strict();

/** The validated config of an `llm` step. */
export type LlmStepConfig = z.infer<typeof llmStep>['config'];

/**
 * A single step. A discriminated union on `type` so that (a) each type can carry
 * its own config shape, and (b) an unsupported `type` produces a clear "invalid
 * discriminator" error rather than being coerced.
 */
export const stepSchema = z.discriminatedUnion('type', [noopStep, llmStep]);

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
