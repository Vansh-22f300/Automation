/**
 * Step-input reference resolution — the smallest thing that could possibly work.
 *
 * A step's configured input may reference the run's state with a mustache-style
 * token: `{{trigger.payload}}`, `{{steps.first.output}}`, or a deeper path into
 * either (`{{trigger.payload.id}}`). That is the *entire* grammar. There is
 * deliberately no templating, no concatenation, no operators, no function calls.
 *
 * **Security: there is no code execution here.** References are resolved by
 * splitting a dotted path and walking plain objects — never by `eval`, `Function`,
 * a template engine, or anything that interprets the token as code. An input that
 * looks like an expression is treated as data. An unknown or unreachable
 * reference fails cleanly with a `PermanentError` (retrying cannot fix a typo'd
 * path) rather than silently resolving to `undefined`.
 *
 * The resolver reads *through* an `ExecutionContext`; it holds no state of its own.
 */

import { PermanentError } from '@/domain/errors.js';
import type { ExecutionContext } from '@/domain/execution-context.js';

/** A whole-string reference: the string is exactly one `{{ … }}` token, nothing else. */
const WHOLE_REFERENCE = /^\{\{\s*([^{}]+?)\s*\}\}$/;

/** A path segment: a reference path is dotted segments of these safe tokens. */
const PATH_SEGMENT = /^[A-Za-z0-9_]+$/;

/** True if `value` is a non-null, non-array object we can index into. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Walk a dotted path from a root object, or throw `PermanentError` if any segment
 * is missing or leads into a non-object. No optional chaining semantics: an
 * unreachable path is an error, not an `undefined`.
 */
function walkPath(root: unknown, segments: string[], reference: string): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (!isRecord(current) || !(segment in current)) {
      throw new PermanentError(
        'unresolved_reference',
        `reference "${reference}" could not be resolved: no value at "${segment}"`,
        { details: { reference } },
      );
    }
    current = current[segment];
  }
  return current;
}

/**
 * Resolve a single `{{ … }}` reference against the context.
 *
 * The supported roots are `trigger` (the trigger context) and `steps` (per-step
 * outputs, addressed as `steps.<stepKey>.output[.…]`). Anything else is an
 * unknown reference and fails.
 */
export function resolveReference(reference: string, context: ExecutionContext): unknown {
  const path = reference.trim();
  const segments = path.split('.');

  if (segments.length === 0 || segments.some((s) => !PATH_SEGMENT.test(s))) {
    throw new PermanentError('invalid_reference', `reference "${reference}" is not a valid path`, {
      details: { reference },
    });
  }

  const [root, ...rest] = segments;

  if (root === 'trigger') {
    return walkPath(context.getTrigger(), rest, reference);
  }

  if (root === 'steps') {
    // steps.<stepKey>.output[.…] — the step must have run and must be referenced
    // via its `output`, mirroring how results are stored in the context.
    const [stepKey, field, ...tail] = rest;
    if (stepKey === undefined || field === undefined) {
      throw new PermanentError(
        'invalid_reference',
        `reference "${reference}" must address a step as steps.<stepKey>.output`,
        { details: { reference } },
      );
    }
    if (!context.hasStep(stepKey)) {
      throw new PermanentError(
        'unresolved_reference',
        `reference "${reference}" refers to step "${stepKey}", which has not run`,
        { details: { reference } },
      );
    }
    if (field !== 'output') {
      throw new PermanentError(
        'invalid_reference',
        `reference "${reference}": only ".output" is addressable on a step`,
        { details: { reference } },
      );
    }
    return walkPath(context.getStepOutput(stepKey), tail, reference);
  }

  throw new PermanentError(
    'unknown_reference_root',
    `reference "${reference}" has unknown root "${root}" (expected "trigger" or "steps")`,
    { details: { reference } },
  );
}

/**
 * Resolve references throughout an input value.
 *
 * A string that is *entirely* a `{{ … }}` token becomes the referenced value
 * (preserving its type — an object stays an object, not a stringification).
 * Objects and arrays are resolved element-wise. Any other value passes through
 * untouched. Strings that merely *contain* a token but are not solely one are
 * left verbatim: partial interpolation is not part of this grammar.
 */
export function resolveInput(input: unknown, context: ExecutionContext): unknown {
  if (typeof input === 'string') {
    const match = WHOLE_REFERENCE.exec(input);
    return match ? resolveReference(match[1]!, context) : input;
  }
  if (Array.isArray(input)) {
    return input.map((item) => resolveInput(item, context));
  }
  if (isRecord(input)) {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      resolved[key] = resolveInput(value, context);
    }
    return resolved;
  }
  return input;
}
