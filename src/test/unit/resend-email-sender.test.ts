import { describe, expect, it } from 'vitest';
import pino, { type DestinationStream, type Logger } from 'pino';

import {
  ResendEmailSender,
  ResendDeliveryError,
} from '@/auth/email/resend-email-sender.js';
import { AuthEmailNotifier } from '@/auth/email/auth-email-notifier.js';
import { isAppError } from '@/domain/errors.js';
import { FakeFetch } from '@/test/support/fake-fetch.js';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const API_KEY = 're_test_secret_key_MUST_NOT_LEAK';
const FROM = 'AI Workforce <noreply@mail.example.test>';
const TO = 'recipient@example.test';
const RAW_TOKEN = 'raw-verification-token-MUST-NOT-LEAK';
const VERIFY_URL = `https://frontend.example.test/backend/auth/verify-email?token=${RAW_TOKEN}`;
const RESET_URL = `https://frontend.example.test/backend/auth/reset-password?token=${RAW_TOKEN}`;

/**
 * A pino logger whose every serialized line is captured, so a test can assert
 * that no secret (key, token, link, or rendered body) is ever written.
 */
function capturingLogger(): { logger: Logger; text: () => string } {
  const chunks: string[] = [];
  const stream: DestinationStream = {
    write: (s) => {
      chunks.push(s);
    },
  };
  const logger = pino({ level: 'trace' }, stream);
  return { logger, text: () => chunks.join('') };
}

/** Headers reach the fake as a plain record in these tests. */
function headersOf(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>;
}

describe('ResendEmailSender', () => {
  it('A. POSTs a verification email to the Resend endpoint with the right shape', async () => {
    const fake = new FakeFetch({ status: 200 });
    const { logger, text } = capturingLogger();
    const sender = new ResendEmailSender({ apiKey: API_KEY, from: FROM, logger, fetch: fake.fetch });

    await sender.sendVerificationEmail({
      to: TO,
      name: 'Ada',
      verifyUrl: VERIFY_URL,
      expiresInMinutes: 1440,
    });

    expect(fake.calls).toHaveLength(1);
    const { url, init } = fake.lastCall!;
    expect(url).toBe(RESEND_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(headersOf(init).authorization).toBe(`Bearer ${API_KEY}`);
    expect(headersOf(init)['content-type']).toBe('application/json');

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.from).toBe(FROM);
    expect(body.to).toEqual([TO]);
    expect(typeof body.subject).toBe('string');
    expect((body.subject as string).length).toBeGreaterThan(0);
    expect(body.html).toContain(VERIFY_URL);
    expect(body.text).toContain(VERIFY_URL);

    // Secrets discipline: metadata only in logs — never key/token/link/recipient/body.
    const logs = text();
    expect(logs).toContain('"email_kind":"verification"');
    expect(logs).not.toContain(API_KEY);
    expect(logs).not.toContain(RAW_TOKEN);
    expect(logs).not.toContain(VERIFY_URL);
    expect(logs).not.toContain(TO);
    expect(logs).not.toContain(body.html as string);
  });

  it('B. POSTs a password-reset email with the reset link and kind', async () => {
    const fake = new FakeFetch({ status: 200 });
    const { logger, text } = capturingLogger();
    const sender = new ResendEmailSender({ apiKey: API_KEY, from: FROM, logger, fetch: fake.fetch });

    await sender.sendPasswordResetEmail({
      to: TO,
      name: null,
      resetUrl: RESET_URL,
      expiresInMinutes: 60,
    });

    const body = JSON.parse(fake.lastCall!.init.body as string) as Record<string, unknown>;
    expect(body.to).toEqual([TO]);
    expect(body.html).toContain(RESET_URL);
    expect(body.text).toContain(RESET_URL);
    const logs = text();
    expect(logs).toContain('"email_kind":"password_reset"');
    expect(logs).not.toContain(RAW_TOKEN);
    expect(logs).not.toContain(RESET_URL);
  });

  it.each([401, 403, 422, 429, 500, 503])(
    'C/D. throws a leak-free ResendDeliveryError on HTTP %i',
    async (status) => {
      const providerDetail = 'PROVIDER_BODY_THAT_MUST_NOT_LEAK';
      const fake = new FakeFetch({ status, body: { name: 'error', message: providerDetail } });
      const { logger, text } = capturingLogger();
      const sender = new ResendEmailSender({ apiKey: API_KEY, from: FROM, logger, fetch: fake.fetch });

      const err = await sender
        .sendVerificationEmail({ to: TO, name: 'Ada', verifyUrl: VERIFY_URL, expiresInMinutes: 1440 })
        .then(() => undefined)
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ResendDeliveryError);
      const delivery = err as ResendDeliveryError;
      expect(delivery.status).toBe(status);
      expect(delivery.emailKind).toBe('verification');
      // A provider transport failure is NOT part of the workflow-execution taxonomy.
      expect(isAppError(err)).toBe(false);
      // The error carries only safe metadata — no provider body, key, token, or recipient.
      const errText = `${delivery.message} ${delivery.stack ?? ''}`;
      expect(errText).not.toContain(providerDetail);
      expect(errText).not.toContain(API_KEY);
      expect(errText).not.toContain(RAW_TOKEN);
      expect(errText).not.toContain(TO);
      // And nothing sensitive was logged on the failure path.
      const logs = text();
      expect(logs).not.toContain(providerDetail);
      expect(logs).not.toContain(API_KEY);
      expect(logs).not.toContain(RAW_TOKEN);
    },
  );

  it('E. propagates a network/timeout failure unchanged (not wrapped)', async () => {
    const boom = Object.assign(new Error('socket hang up'), { name: 'FetchError' });
    const fake = new FakeFetch({ throwError: boom });
    const { logger } = capturingLogger();
    const sender = new ResendEmailSender({ apiKey: API_KEY, from: FROM, logger, fetch: fake.fetch });

    const err = await sender
      .sendVerificationEmail({ to: TO, name: null, verifyUrl: VERIFY_URL, expiresInMinutes: 1440 })
      .catch((e: unknown) => e);

    expect(err).toBe(boom);
    expect(err).not.toBeInstanceOf(ResendDeliveryError);
  });
});

describe('AuthEmailNotifier best-effort delivery via ResendEmailSender', () => {
  const APP_ORIGIN = 'https://frontend.example.test';

  it('F. swallows a provider HTTP failure so the caller flow is never coupled to delivery', async () => {
    const fake = new FakeFetch({ status: 422, body: { name: 'validation_error' } });
    const { logger, text } = capturingLogger();
    const sender = new ResendEmailSender({ apiKey: API_KEY, from: FROM, logger, fetch: fake.fetch });
    const notifier = new AuthEmailNotifier(sender, APP_ORIGIN, logger);

    await expect(
      notifier.sendVerification({ to: TO, name: 'Ada', rawToken: RAW_TOKEN }),
    ).resolves.toBeUndefined();

    // The transport received the built link (the token lives only inside the link)…
    const body = JSON.parse(fake.lastCall!.init.body as string) as Record<string, unknown>;
    expect(body.html).toContain(RAW_TOKEN);
    // …but the swallowed failure logged metadata only — no token, link, or key.
    const logs = text();
    expect(logs).toContain('best-effort');
    expect(logs).toContain('"err_name":"ResendDeliveryError"');
    expect(logs).not.toContain(RAW_TOKEN);
    expect(logs).not.toContain('/backend/auth/verify-email');
    expect(logs).not.toContain(API_KEY);
  });

  it('F2. swallows a network failure on the reset path too', async () => {
    const fake = new FakeFetch({
      throwError: Object.assign(new Error('timed out'), { name: 'AbortError' }),
    });
    const { logger, text } = capturingLogger();
    const sender = new ResendEmailSender({ apiKey: API_KEY, from: FROM, logger, fetch: fake.fetch });
    const notifier = new AuthEmailNotifier(sender, APP_ORIGIN, logger);

    await expect(
      notifier.sendPasswordReset({ to: TO, name: null, rawToken: RAW_TOKEN }),
    ).resolves.toBeUndefined();
    expect(text()).toContain('"err_name":"AbortError"');
  });
});
