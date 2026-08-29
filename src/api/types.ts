/**
 * Shared Fastify instance type for this API.
 *
 * The server is built with a pino `Logger` as its `loggerInstance`, which makes
 * Fastify's instance type parameterised by that concrete logger rather than the
 * default `FastifyBaseLogger`. Every helper that registers routes or hooks on the
 * instance must agree on that same type, or `exactOptionalPropertyTypes` flags
 * the (structurally harmless) logger variance. Naming it once here keeps the
 * composition root and every `register*` helper in lock-step.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance, RawServerDefault } from 'fastify';
import type { Logger } from 'pino';

export type ApiServer = FastifyInstance<RawServerDefault, IncomingMessage, ServerResponse, Logger>;
