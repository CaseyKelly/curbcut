import {
  BudgetExceededError,
  ReplayMissError,
  StructuredOutputError,
  CallTimeoutError,
} from '@curbcut/agent';
import { describe, expect, it } from 'vitest';
import { BudgetCheckError, createCallGuard, MAX_CONSECUTIVE_REJECTIONS } from './llm';

/** An API error as the SDK throws it: an Error with a status. */
const apiError = (status: number, message = 'nope') =>
  Object.assign(new Error(message), { status });

describe('createCallGuard', () => {
  it('stops on the monthly budget or an unreadable one', () => {
    const budget = createCallGuard();
    budget.failed(new BudgetExceededError(20, 20));
    expect(budget.stopped).toMatch(/Monthly LLM budget reached/);

    const check = createCallGuard();
    check.failed(new BudgetCheckError("can't read this month's LLM spend"));
    expect(check.stopped).toMatch(/can't read/);
  });

  it.each([401, 402, 403, 404])('stops at once on a %i', (status) => {
    const guard = createCallGuard();
    guard.failed(apiError(status));
    expect(guard.stopped).toContain(`(${status})`);
  });

  it('stops after rejections in a row, like a console spend limit', () => {
    const guard = createCallGuard();
    for (let i = 1; i < MAX_CONSECUTIVE_REJECTIONS; i++) guard.failed(apiError(400));
    expect(guard.stopped).toBeUndefined();
    guard.failed(apiError(400, 'You have reached your specified API usage limits.'));
    expect(guard.stopped).toBe(
      `the API rejected ${MAX_CONSECUTIVE_REJECTIONS} requests in a row: You have reached your specified API usage limits.`,
    );
  });

  it('counts rejections only in a row', () => {
    const guard = createCallGuard();
    guard.failed(apiError(400));
    guard.failed(apiError(400));
    guard.succeeded();
    guard.failed(apiError(400));
    // An unusable answer is still an answer.
    guard.failed(new StructuredOutputError('{}', 'bad'));
    guard.failed(apiError(400));
    expect(guard.stopped).toBeUndefined();
  });

  it('keeps going after errors about one request', () => {
    const guard = createCallGuard();
    for (let i = 0; i < 5; i++) {
      guard.failed(new ReplayMissError('k'));
      guard.failed(new CallTimeoutError(1000));
      guard.failed(apiError(529));
    }
    expect(guard.stopped).toBeUndefined();
  });

  it('keeps the first reason', () => {
    const guard = createCallGuard();
    guard.failed(apiError(401, 'first'));
    guard.failed(new BudgetExceededError(20, 20));
    expect(guard.stopped).toMatch(/first/);
  });
});
