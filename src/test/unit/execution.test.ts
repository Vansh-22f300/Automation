/**
 * Unit tests for the framework-free execution primitives: the run-state machine,
 * the execution context, the reference resolver, and the step-handler registry.
 *
 * These need no database — they prove the pure logic the engine is built from.
 * The engine's transactional behaviour (advance-one-step, atomicity, idempotency,
 * version pinning) is proven against real PostgreSQL in the integration suite.
 */

import { describe, expect, it } from 'vitest';

import { PermanentError } from '@/domain/errors.js';
import { ExecutionContext } from '@/domain/execution-context.js';
import { resolveInput, resolveReference } from '@/domain/references.js';
import {
  assertRunTransition,
  canTransitionRun,
  InvalidRunTransitionError,
  isTerminalRunStatus,
} from '@/domain/run-state.js';
import { defaultStepHandlerRegistry, NoopStepHandler, StepHandlerRegistry } from '@/domain/step-handler.js';
import type { RunContext } from '@/domain/workflow-run.js';

const baseContext = (): RunContext => ({
  trigger: { source: 'stripe', event_id: 'evt-1', payload: { id: 'cus_123', amount: 42 } },
  steps: {},
});

describe('run-state machine', () => {
  it('permits the transitions Step 6 uses', () => {
    expect(canTransitionRun('queued', 'running')).toBe(true);
    expect(canTransitionRun('running', 'succeeded')).toBe(true);
    expect(canTransitionRun('running', 'failed')).toBe(true);
    expect(canTransitionRun('running', 'running')).toBe(true);
  });

  it('forbids leaving a terminal state', () => {
    expect(canTransitionRun('succeeded', 'running')).toBe(false);
    expect(canTransitionRun('failed', 'running')).toBe(false);
    expect(canTransitionRun('cancelled', 'succeeded')).toBe(false);
    for (const s of ['succeeded', 'failed', 'cancelled'] as const) {
      expect(isTerminalRunStatus(s)).toBe(true);
    }
    expect(isTerminalRunStatus('running')).toBe(false);
  });

  it('assertRunTransition throws on an illegal move', () => {
    expect(() => assertRunTransition('succeeded', 'running')).toThrow(InvalidRunTransitionError);
    expect(() => assertRunTransition('running', 'succeeded')).not.toThrow();
  });
});

describe('ExecutionContext', () => {
  it('exposes the trigger and records step outputs without aliasing the source', () => {
    const source = baseContext();
    const ctx = new ExecutionContext(source);

    expect(ctx.getTrigger().source).toBe('stripe');
    expect(ctx.hasStep('first')).toBe(false);

    ctx.setStepOutput('first', { ok: true });
    expect(ctx.hasStep('first')).toBe(true);
    expect(ctx.getStepOutput('first')).toEqual({ ok: true });

    // The original context object is untouched — the engine snapshots explicitly.
    expect(source.steps).toEqual({});
    expect(ctx.snapshot().steps).toEqual({ first: { output: { ok: true } } });
  });
});

describe('reference resolver', () => {
  it('resolves trigger and step references by walking plain objects', () => {
    const ctx = new ExecutionContext(baseContext());
    ctx.setStepOutput('first', { total: 100 });

    expect(resolveReference('trigger.source', ctx)).toBe('stripe');
    expect(resolveReference('trigger.payload.id', ctx)).toBe('cus_123');
    expect(resolveReference('steps.first.output', ctx)).toEqual({ total: 100 });
    expect(resolveReference('steps.first.output.total', ctx)).toBe(100);
  });

  it('fails cleanly on unknown or unreachable references — never returns undefined', () => {
    const ctx = new ExecutionContext(baseContext());
    expect(() => resolveReference('bogus.thing', ctx)).toThrow(PermanentError);
    expect(() => resolveReference('trigger.payload.missing', ctx)).toThrow(PermanentError);
    expect(() => resolveReference('steps.never.output', ctx)).toThrow(PermanentError);
    expect(() => resolveReference('steps.first.notoutput', ctx)).toThrow(PermanentError);
  });

  it('substitutes whole-string references in an input, preserving types, and leaves data alone', () => {
    const ctx = new ExecutionContext(baseContext());
    ctx.setStepOutput('first', { total: 100 });

    const input = {
      literal: 'hello',
      amount: '{{trigger.payload.amount}}',
      nested: { total: '{{steps.first.output.total}}', keep: 7 },
      list: ['{{trigger.source}}', 'x'],
      notAReference: 'prefix {{trigger.source}} suffix',
    };

    expect(resolveInput(input, ctx)).toEqual({
      literal: 'hello',
      amount: 42, // number preserved, not stringified
      nested: { total: 100, keep: 7 },
      list: ['stripe', 'x'],
      notAReference: 'prefix {{trigger.source}} suffix', // partial interpolation is not supported
    });
  });

  it('does not execute code — an expression-looking token is treated as an unknown path', () => {
    const ctx = new ExecutionContext(baseContext());
    expect(() => resolveReference('constructor.constructor', ctx)).toThrow(PermanentError);
    // A token that is not a clean dotted path is rejected outright, never evaluated.
    expect(() => resolveReference('1+1', ctx)).toThrow(PermanentError);
  });
});

describe('step-handler registry', () => {
  it('resolves noop and produces a deterministic output', async () => {
    const registry = defaultStepHandlerRegistry();
    const handler = registry.get('noop');
    const result = await handler.execute({
      step: { key: 'first', type: 'noop', config: {} },
      context: new ExecutionContext(baseContext()),
      input: {},
    });
    expect(result.output).toEqual({ ok: true });
    expect(result.usage).toBeUndefined();
    expect(handler).toBeInstanceOf(NoopStepHandler);
  });

  it('throws a clean error for a type with no registered handler', () => {
    const empty = new StepHandlerRegistry();
    expect(() => empty.get('noop')).toThrow(PermanentError);
  });
});
