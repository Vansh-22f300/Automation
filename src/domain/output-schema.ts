/**
 * Declarative output schemas for the `llm` workflow step — **data, never code.**
 *
 * An `llm` step must produce machine-readable, validated structured output; it may
 * not "return JSON" as free text that someone later `JSON.parse`s and hopes for.
 * So a step's definition carries an *output schema*: a small, declarative document
 * describing the shape the model must return. Because a definition is stored as
 * JSON (and will one day be authored by an AI), that schema has to be pure data —
 * there is no place here for executable code, arbitrary JavaScript, `eval`, or a
 * caller-supplied validator function.
 *
 * This module is the single authority on that format. It does two things:
 *
 *   1. `outputSchemaSchema` — a Zod meta-schema that validates the declarative
 *      document itself, so an unsupported construct (`$ref`, `pattern`, `anyOf`,
 *      `type: "integer"`, a recursive definition, …) is *rejected at workflow
 *      definition time* rather than silently ignored.
 *   2. `compileOutputSchema` — a pure walker that turns a validated declarative
 *      schema into a runtime Zod schema, which the LLM step hands to
 *      `LlmProvider.completeStructured` and re-validates the result against.
 *
 * The supported subset is deliberately tiny — object, string, number, boolean,
 * string enum, and simple arrays. It is NOT full JSON Schema: no recursion, no
 * `$ref`, no combinators, no format/pattern constraints. Nesting of objects and
 * arrays is allowed but depth-bounded, so a pathological document cannot blow the
 * stack while compiling.
 *
 * Security note: free-text fields (`description`, enum values) forbid the `{{`
 * substring. References belong only in a step's `input`; keeping them out of the
 * schema means the engine's generic reference pre-resolution never rewrites any
 * part of the schema, so the schema stays static, trusted structure.
 */

import { z } from 'zod';

import { PermanentError } from '@/domain/errors.js';

/**
 * Maximum nesting depth the compiler will descend. Object/array nesting is fine,
 * but a definition nested past this is refused rather than risking a deep or
 * cyclic walk — the declarative format has no `$ref`, so legitimate schemas are
 * shallow.
 */
const MAX_SCHEMA_DEPTH = 10;

/** A string that must not smuggle in a reference token — schema text is static. */
const staticText = z
  .string()
  .refine((s) => !s.includes('{{'), 'must not contain "{{" (references are only allowed in a step\'s input)');

/**
 * The declarative node types. A discriminated union on `type` so an unsupported
 * type produces a clear error, and `.strict()` on every member so an unknown key
 * (a JSON-Schema construct we do not support) fails validation instead of being
 * dropped.
 *
 * Typed via `z.ZodType` + `z.lazy` because `object`/`array` nodes nest other
 * nodes. The lazy reference is the union itself, so nesting composes without a
 * bespoke recursive type.
 */
export type OutputSchemaNode =
  | { readonly type: 'string'; readonly description?: string | undefined }
  | { readonly type: 'number'; readonly description?: string | undefined }
  | { readonly type: 'boolean'; readonly description?: string | undefined }
  | { readonly type: 'enum'; readonly values: readonly string[]; readonly description?: string | undefined }
  | { readonly type: 'array'; readonly items: OutputSchemaNode; readonly description?: string | undefined }
  | {
      readonly type: 'object';
      readonly properties: Readonly<Record<string, OutputSchemaNode>>;
      readonly required?: readonly string[] | undefined;
      readonly description?: string | undefined;
    };

const nodeSchema: z.ZodType<OutputSchemaNode> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('string'), description: staticText.optional() }).strict(),
    z.object({ type: z.literal('number'), description: staticText.optional() }).strict(),
    z.object({ type: z.literal('boolean'), description: staticText.optional() }).strict(),
    z
      .object({
        type: z.literal('enum'),
        values: z.array(staticText).min(1, 'an enum needs at least one value'),
        description: staticText.optional(),
      })
      .strict(),
    z
      .object({ type: z.literal('array'), items: nodeSchema, description: staticText.optional() })
      .strict(),
    z
      .object({
        type: z.literal('object'),
        properties: z.record(z.string(), nodeSchema),
        required: z.array(z.string()).optional(),
        description: staticText.optional(),
      })
      .strict()
      .superRefine((node, ctx) => {
        // Every name in `required` must be a declared property; a required key
        // that does not exist is a definition bug, not a silent no-op.
        for (const name of node.required ?? []) {
          if (!(name in node.properties)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `required property "${name}" is not declared in properties`,
              path: ['required'],
            });
          }
        }
      }),
  ]),
);

/**
 * The output schema as stored in a step's config: the **root must be an object.**
 * Structured model output is a record of named fields; a bare scalar or array at
 * the root is not a useful contract and several providers' structured-output modes
 * require an object envelope, so we require one here rather than discover it later.
 */
export const outputSchemaSchema = z
  .object({
    type: z.literal('object'),
    properties: z.record(z.string(), nodeSchema),
    required: z.array(z.string()).optional(),
    description: staticText.optional(),
  })
  .strict()
  .superRefine((node, ctx) => {
    for (const name of node.required ?? []) {
      if (!(name in node.properties)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `required property "${name}" is not declared in properties`,
          path: ['required'],
        });
      }
    }
  });

/** A validated declarative output schema (root object). */
export type OutputSchema = z.infer<typeof outputSchemaSchema>;

/**
 * Compile a single declarative node into a runtime Zod schema. Pure and total
 * over the supported subset; `depth` guards against nesting past `MAX_SCHEMA_DEPTH`.
 *
 * Object nodes use Zod's default "strip unknown keys" behaviour: a model that
 * returns an extra field does not fail validation, but the extra field is dropped
 * before the data reaches workflow context — so downstream references only ever
 * see declared fields. Optionality is driven by the node's `required` list.
 */
function compileNode(node: OutputSchemaNode, depth: number): z.ZodTypeAny {
  if (depth > MAX_SCHEMA_DEPTH) {
    throw new PermanentError(
      'output_schema_too_deep',
      `output schema nests deeper than the supported limit of ${MAX_SCHEMA_DEPTH}`,
    );
  }

  switch (node.type) {
    case 'string':
      return z.string();
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'enum':
      // A non-empty string enum. `values` is guaranteed non-empty by validation.
      return z.enum([...node.values] as [string, ...string[]]);
    case 'array':
      return z.array(compileNode(node.items, depth + 1));
    case 'object': {
      const required = new Set(node.required ?? []);
      const shape: Record<string, z.ZodTypeAny> = {};
      for (const [name, child] of Object.entries(node.properties)) {
        const compiled = compileNode(child, depth + 1);
        shape[name] = required.has(name) ? compiled : compiled.optional();
      }
      return z.object(shape);
    }
  }
}

/**
 * Compile a validated declarative output schema into the runtime Zod schema the
 * LLM step uses to constrain and validate the model's structured output. The
 * result is typed as `unknown` — the shape is only known at runtime — which is
 * exactly what `completeStructured<unknown>` and a defensive re-validation want.
 */
export function compileOutputSchema(schema: OutputSchema): z.ZodType<unknown> {
  return compileNode(schema, 0) as z.ZodType<unknown>;
}
