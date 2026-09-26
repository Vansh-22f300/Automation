/**
 * Bootstrap helper: create a human user for local development sign-in.
 *
 * Phase 4 gives the platform a password login flow, but there is deliberately no
 * public signup — accounts are provisioned, not self-registered. This CLI is the
 * development-only counterpart to `tenant:create` / `apikey:create`: it mints the
 * first human login so the existing `/login` flow can be exercised end to end.
 *
 *   pnpm user:create
 *   pnpm user:create --email you@example.com --name "You" --tenant <tenantId>
 *
 * Anything not passed as a flag is prompted for. The password is ALWAYS prompted
 * (never a flag, so it cannot leak into shell history), read with terminal echo
 * suppressed, and never printed, logged, or stored in plaintext — only its
 * Argon2id hash (via the shared `argon2PasswordHasher`) reaches the database,
 * exactly what the login service verifies against.
 *
 * Guard rails, because this writes real rows to the real development database:
 *   - refuses to run unless NODE_ENV is `development` (never production or test);
 *   - refuses a DATABASE_URL whose database name looks like a test DB, so it can
 *     never be pointed at TEST_DATABASE_URL by accident;
 *   - never silently picks a tenant — an explicit `--tenant`, or an interactive
 *     choice from the listed tenants, is required;
 *   - it is a bootstrap utility, not a registration endpoint: no signup, email
 *     verification, or reset — out of scope on purpose.
 */

import { createInterface } from 'node:readline/promises';
import type { Interface as ReadlineInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

import { sql } from 'drizzle-orm';

import type { Env } from '@/config/env.js';
import { loadEnv } from '@/config/env.js';
import { createDatabase, describeDatabaseUrl } from '@/db/client.js';
import { createLogger } from '@/observability/logger.js';
import { argon2PasswordHasher } from '@/auth/password.js';
import { memberships, membershipRole, passwordCredentials, tenants, users } from '@/db/schema.js';

type Role = (typeof membershipRole.enumValues)[number];
type TenantRow = { id: string; name: string };

interface Flags {
  email?: string;
  name?: string;
  tenant?: string;
  role?: string;
  yes: boolean;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

/** Write a message to stderr and exit non-zero. Never carries secret material. */
function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function printUsage(): void {
  process.stdout.write(
    [
      'usage: pnpm user:create [--email <email>] [--name <name>] [--tenant <tenantId>]',
      '                        [--role owner|member] [--yes]',
      '',
      'Creates one human user (users + password_credentials + membership) for local',
      'development sign-in. Prompts for anything omitted; the password is always',
      'prompted securely and is never accepted as a flag.',
      '',
    ].join('\n') + '\n',
  );
}

function formatTenantList(list: readonly TenantRow[]): string {
  return list.map((t, index) => `  [${index + 1}] ${t.name}  (${t.id})`).join('\n');
}

function parseFlags(argv: readonly string[]): Flags {
  const flags: Flags = { yes: false };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    let key = arg;
    let inline: string | undefined;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq !== -1) {
      key = arg.slice(0, eq);
      inline = arg.slice(eq + 1);
    }
    const value = (): string => {
      if (inline !== undefined) return inline;
      const next = argv[i + 1];
      if (next === undefined) fail(`Missing value for ${arg}`);
      i += 1;
      return next;
    };
    switch (key) {
      case '--email':
        flags.email = value();
        break;
      case '--name':
        flags.name = value();
        break;
      case '--tenant':
        flags.tenant = value();
        break;
      case '--role':
        flags.role = value();
        break;
      case '--yes':
      case '-y':
        flags.yes = true;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
      default:
        fail(`Unknown argument: ${arg}`);
    }
    i += 1;
  }
  return flags;
}

/**
 * Refuse to run anywhere that could be production or a test database. This CLI
 * writes a real, permanent login row, so the environment must be unambiguously a
 * developer's own machine pointed at the normal development database.
 */
function assertSafeEnvironment(env: Env): void {
  if (env.NODE_ENV !== 'development') {
    fail(
      `Refusing to run: NODE_ENV is "${env.NODE_ENV}". ` +
        'user:create is a development-only bootstrap and runs only when NODE_ENV=development.',
    );
  }
  const target = describeDatabaseUrl(env.DATABASE_URL);
  if (/test/i.test(target.database)) {
    fail(
      `Refusing to run: DATABASE_URL points at "${target.database}", which looks like a test ` +
        'database. This command creates real dev users and must never write to TEST_DATABASE_URL.',
    );
  }
}

function resolveRole(flagRole: string | undefined): Role {
  if (flagRole === undefined) return 'owner';
  const roles = membershipRole.enumValues;
  if (!(roles as readonly string[]).includes(flagRole)) {
    fail(`--role must be one of: ${roles.join(', ')}`);
  }
  return flagRole as Role;
}

// --- prompt plumbing ---------------------------------------------------------
// Two input modes, chosen by whether stdin is a TTY:
//   * Interactive (TTY): a readline interface whose output is a muted pass-through
//     around stdout — while `muted`, readline's echo of the characters being typed
//     is dropped, so the password never reaches the screen. The prompt label is
//     written straight to stdout (outside the mute); the Enter newline that the
//     mute swallows is restored by hand.
//   * Non-interactive (piped stdin, e.g. scripted dev setup / CI): no readline is
//     created — attaching one would drain and close the pipe during the async gap
//     before the password prompt. Instead stdin is read to EOF once and consumed
//     line by line. The password still arrives on stdin, never as a flag/argv, and
//     there is no terminal echo to suppress.
let muted = false;
const maskedOutput = new Writable({
  write(chunk, _encoding, callback) {
    if (!muted) process.stdout.write(chunk as Buffer);
    callback();
  },
});

const isInteractive = process.stdin.isTTY === true;

// Lazily read all of piped stdin (non-interactive only), then hand out one line
// per call. A trailing newline does not yield a phantom empty final line.
let stdinLines: string[] | null = null;
async function nextPipedLine(): Promise<string> {
  if (stdinLines === null) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8').replace(/\r\n/g, '\n');
    stdinLines = text.split('\n');
    if (stdinLines.length > 0 && stdinLines[stdinLines.length - 1] === '') stdinLines.pop();
  }
  return stdinLines.shift() ?? '';
}

const rl: ReadlineInterface | null = isInteractive
  ? createInterface({ input: process.stdin, output: maskedOutput, terminal: true })
  : null;
rl?.on('SIGINT', () => {
  process.stdout.write('\n');
  process.exit(130);
});

async function ask(query: string): Promise<string> {
  if (rl === null) return (await nextPipedLine()).trim();
  return (await rl.question(query)).trim();
}

async function askHidden(query: string): Promise<string> {
  if (rl === null) return await nextPipedLine();
  process.stdout.write(query);
  muted = true;
  try {
    return await rl.question('');
  } finally {
    muted = false;
    process.stdout.write('\n');
  }
}

async function selectTenant(
  list: readonly TenantRow[],
  flagTenant: string | undefined,
): Promise<TenantRow> {
  if (flagTenant !== undefined) {
    const match = list.find((t) => t.id === flagTenant);
    if (match === undefined) {
      fail(`No tenant has id ${flagTenant}. Available tenants:\n${formatTenantList(list)}`);
    }
    return match;
  }
  if (!isInteractive) {
    if (list.length === 1) return list[0]!;
    fail(
      `Multiple tenants exist — pass --tenant <tenantId> when not interactive:\n${formatTenantList(list)}`,
    );
  }
  process.stdout.write(`Select a tenant:\n${formatTenantList(list)}\n`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const raw = await ask(`Tenant [1-${list.length}]: `);
    const choice = Number.parseInt(raw, 10);
    if (Number.isInteger(choice) && choice >= 1 && choice <= list.length) {
      return list[choice - 1]!;
    }
    process.stderr.write('Enter one of the listed numbers.\n');
  }
  fail('No tenant selected.');
}

async function promptEmail(fromFlag: string | undefined): Promise<string> {
  let email = fromFlag?.trim().toLowerCase() ?? '';
  if (email === '') {
    if (!isInteractive) fail('No email provided. Pass --email <email> when not interactive.');
    email = (await ask('Email: ')).toLowerCase();
  }
  if (!EMAIL_PATTERN.test(email)) fail('Enter a valid email address.');
  return email;
}

async function promptName(fromFlag: string | undefined): Promise<string | null> {
  if (fromFlag !== undefined) {
    const trimmed = fromFlag.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (!isInteractive) return null;
  const name = await ask('Name (optional): ');
  return name === '' ? null : name;
}

async function promptPassword(): Promise<string> {
  const maxAttempts = isInteractive ? 3 : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const password = await askHidden('Password: ');
    if (password.length < MIN_PASSWORD_LENGTH) {
      process.stderr.write(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.\n`);
      continue;
    }
    const confirm = await askHidden('Confirm password: ');
    if (password !== confirm) {
      process.stderr.write('Passwords did not match.\n');
      continue;
    }
    return password;
  }
  fail('Could not read a valid password.');
}

// --- run ---------------------------------------------------------------------
const flags = parseFlags(process.argv.slice(2));
const env = loadEnv();
assertSafeEnvironment(env);

const logger = createLogger(env, { service: 'cli' });
const database = createDatabase(env, logger, { service: 'cli' });
const target = describeDatabaseUrl(env.DATABASE_URL);

try {
  await database.verifyConnection();
  process.stdout.write(`target database: ${target.host}:${target.port}/${target.database}\n`);

  const tenantRows = await database.db
    .select({ id: tenants.id, name: tenants.name })
    .from(tenants)
    .orderBy(tenants.name);
  if (tenantRows.length === 0) {
    fail('No tenants exist yet. Create one first:\n  pnpm tenant:create "<name>"');
  }

  const tenant = await selectTenant(tenantRows, flags.tenant);
  const email = await promptEmail(flags.email);

  const existing = await database.db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);
  if (existing.length > 0) fail('A user with that email already exists.');

  const name = await promptName(flags.name);
  const role = resolveRole(flags.role);

  process.stdout.write(
    [
      '',
      'about to create:',
      `  email:  ${email}`,
      `  name:   ${name ?? '(none)'}`,
      `  tenant: ${tenant.name} (${tenant.id})`,
      `  role:   ${role}`,
      '',
    ].join('\n') + '\n',
  );
  if (isInteractive && !flags.yes) {
    const confirm = await ask('Create this user? [y/N]: ');
    if (!/^y(es)?$/i.test(confirm)) fail('Aborted. No user created.');
  }

  const password = await promptPassword();
  const passwordHash = await argon2PasswordHasher.hash(password);

  const userId = await database.db.transaction(async (tx) => {
    const [created] = await tx
      .insert(users)
      .values({ email, name, status: 'active' })
      .returning({ id: users.id });
    const id = created!.id;
    await tx.insert(passwordCredentials).values({ userId: id, passwordHash });
    await tx
      .insert(memberships)
      .values({ tenantId: tenant.id, userId: id, role, status: 'active' });
    return id;
  });

  process.stdout.write(
    [
      '',
      'created development user',
      `  id:     ${userId}`,
      `  email:  ${email}`,
      `  name:   ${name ?? '(none)'}`,
      `  tenant: ${tenant.name} (${tenant.id})`,
      `  role:   ${role}`,
      '',
      '  sign in at /login with this email and the password you just entered.',
      '',
    ].join('\n') + '\n',
  );
} catch (error) {
  // Never includes the password — it exists only as a local variable, never logged.
  logger.fatal({ err: error }, 'failed to create user');
  process.exitCode = 1;
} finally {
  rl?.close();
  await database.close();
}

