/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

import type {
	LocalMailKind, LocalProjectRow, LocalRequirement, LocalRequirements, LocalService, LocalSettings, LocalSettingsChange, LocalSetupForm,
} from '../../shared/localStack';
import { stackVocabulary, type Vocabulary } from '../../shared/ownLayout';

// The deciding half of local projects: what the requirements
// mean, what the wizard's answers write into `.env`, and what `docker ps` says a project's state
// is. Pure, so every case is provable without an engine; `service.ts` is the half that runs
// things.
//
// ## The stack is the published one, unmodified
//
// The project folder is what github.com/snoutdata/snout-stack's README tells a person to make by
// hand: its `compose.yaml`, a `.env` from `snout-stack init`, and `functions/`. The desktop only
// answers the questions a person would otherwise edit `.env` for, so a project set up here can be
// run, upgraded and backed up with the README alone, and the folder is never the app's secret.

/** The compose plugin version the stack's README requires (`required: false` on a dependency). */
export const MIN_COMPOSE = '2.24.0';

/** Below this much memory for the engine the stack still starts, but say so. */
export const MIN_ENGINE_MEMORY = 2 * 1024 ** 3;

// ## The files are pinned and checked before anything is written or run; the images are tags
//
// The stack is downloaded from ONE commit of github.com/snoutdata/snout-stack, never from a
// branch, and each file must match the SHA-256 written here before the folder is even made: a
// compose file is what Docker runs, so a changed or substituted one is refused with a sentence
// rather than started. The compose file names STACK_IMAGE, the image `init` runs from.
//
// The IMAGES are not pinned the same way. STACK_IMAGE, and every image the compose file names, is
// a registry TAG, which whoever can push to that repository can move; the stack's releases publish
// no digest to pin to. What the check above holds is which tags are run, not the bytes behind them.
//
// Bumping the stack is a change here: a newer commit, each file's SHA-256 read AT that commit
// (never at `main`), and the image tag its compose.yaml names.

/** The snout-stack commit a new project is made from. */
export const STACK_COMMIT = '69ceb27cc9d9e134adb57e58353bc863ea6f2098';

/** Where the published stack is read from: that commit, never a branch. */
export const STACK_SOURCE = `https://raw.githubusercontent.com/snoutdata/snout-stack/${STACK_COMMIT}`;

/** The image the pinned compose file runs (and `snout-stack init` is run from): a tag, not a digest. */
export const STACK_IMAGE = 'ghcr.io/snoutdata/snout-stack:0.1.8';

/** The files a project folder starts with, fetched from STACK_SOURCE, each with its SHA-256. */
export const STACK_FILES: ReadonlyArray<{ path: string; sha256: string }> = [
	{ path: 'compose.yaml', sha256: '86dff9dfe812e049ca42365d4e595b9cc4918f3826119833db1de4dffb40705f' },
	{ path: 'functions/hello/index.ts', sha256: '741726834d88cf3c6d00bee959a991aee7b4ec0ec42b23530a389da7eb7065d9' },
];

/** Why a downloaded stack file must not be used, or null when it is the pinned one. */
export function stackFileProblem(file: { path: string; sha256: string }, bytes: Uint8Array): string | null {
	const actual = createHash('sha256').update(bytes).digest('hex');
	if (actual === file.sha256) {
		return null;
	}
	return `The downloaded ${file.path} is not the published snout-stack file this version of the app expects (its SHA-256 does not match), so nothing was written or run. Try again later, or report it.`;
}

/**
 * Every stack file, downloaded and checked, before any of it is written: either all of them as
 * the pinned bytes, or the sentence that refuses them.
 */
export async function downloadStack(fetcher: typeof fetch): Promise<{ files: Map<string, Uint8Array> } | { problem: string }> {
	const files = new Map<string, Uint8Array>();
	for (const file of STACK_FILES) {
		let bytes: Uint8Array;
		try {
			const res = await fetcher(`${STACK_SOURCE}/${file.path}`, { signal: AbortSignal.timeout(30000) });
			if (!res.ok) {
				return { problem: `Could not download the stack: ${file.path}: HTTP ${res.status}` };
			}
			bytes = new Uint8Array(await res.arrayBuffer());
		} catch (err) {
			return { problem: `Could not download the stack: ${err instanceof Error ? err.message : String(err)}` };
		}
		const problem = stackFileProblem(file, bytes);
		if (problem) {
			return { problem };
		}
		files.set(file.path, bytes);
	}
	return { files };
}

// --- auth's emails ------------------------------------------------------------------------------

/** The five the dashboard lists, in its order. */
export const MAIL_KINDS_ORDER: ReadonlyArray<LocalMailKind> = ['confirmation', 'invite', 'magic_link', 'email_change', 'recovery'];

/** Where a project's own templates are kept, served to auth by the `mail-templates` service. */
export const MAIL_DIR = 'auth/templates';

/** The .env names that hold one email's subject and the URL of its template. */
export function mailEnv(kind: LocalMailKind): { subject: string; template: string } {
	return { subject: `MAIL_SUBJECT_${kind.toUpperCase()}`, template: `MAIL_TEMPLATE_${kind.toUpperCase()}` };
}

/** Where auth reads a project's own template: the static server on the stack's network. */
export function mailTemplateUrl(kind: LocalMailKind): string {
	return `http://mail-templates:8080/${kind}.html`;
}

/** Auth's own subjects and bodies: what the stack's auth server sends when nothing is set. */
export const MAIL_DEFAULTS: Readonly<Record<LocalMailKind, { subject: string; body: string }>> = {
	invite: {
		subject: "You have been invited",
		body: '<h2>You have been invited</h2>\n\n<p>Follow the link below to accept the invitation and create your account.</p>\n<p><a href="{{ .ConfirmationURL }}">Accept the invitation</a></p>',
	},
	confirmation: {
		subject: "Confirm your email address",
		body: '<h2>Confirm your email address</h2>\n\n<p>Follow the link below to confirm this address and finish signing up.</p>\n<p><a href="{{ .ConfirmationURL }}">Confirm your email address</a></p>',
	},
	recovery: {
		subject: "Reset your password",
		body: '<h2>Reset your password</h2>\n\n<p>Follow the link below to choose a new password. If you did not ask for this, you can ignore this email.</p>\n<p><a href="{{ .ConfirmationURL }}">Reset your password</a></p>',
	},
	magic_link: {
		subject: "Your sign-in link",
		body: '<h2>Your sign-in link</h2>\n\n<p>Follow the link below to sign in. It works once, and not for long.</p>\n<p><a href="{{ .ConfirmationURL }}">Sign in</a></p>',
	},
	email_change: {
		subject: "Confirm your new email address",
		body: '<h2>Confirm your new email address</h2>\n\n<p>Follow the link below to make {{ .NewEmail }} the address on your account. If you did not ask for this, you can ignore this email.</p>\n<p><a href="{{ .ConfirmationURL }}">Confirm the new address</a></p>',
	},
};

export function isMailKind(value: unknown): value is LocalMailKind {
	return typeof value === 'string' && (MAIL_KINDS_ORDER as ReadonlyArray<string>).includes(value);
}

/** Why a template would send a mail nobody can act on (the cloud's own check), or null. */
export function mailTemplateProblem(subject: string, body: string): string | null {
	if (!subject.trim() || !body.trim()) {
		return "A template needs a subject and a body.";
	}
	if (subject.includes('\n')) {
		return "The subject is one line.";
	}
	if (!/\{\{\s*\.(ConfirmationURL|Token|TokenHash)\s*\}\}/.test(body)) {
		return "The template must include {{ .ConfirmationURL }} (or {{ .Token }}), or your users get an email with nothing to click.";
	}
	if ((body.match(/\{\{/g) ?? []).length !== (body.match(/\}\}/g) ?? []).length) {
		return "The template has an unmatched {{ or }}.";
	}
	return null;
}

// --- functions' secrets -------------------------------------------------------------------------
//
// functions/.env, read by the deploy step and handed to every function as variables (the stack's
// own convention, selfhost/src/functions.rs). The app lists the NAMES and never reads a value back,
// as the cloud's secrets do.

/** A secret's name: a variable name, and not one the platform sets. */
export function secretNameProblem(name: string): string | null {
	if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) {
		return "A secret's name is letters, digits and underscores, and does not start with a digit.";
	}
	if (/^(SNOUTDATA_|DENO_)/i.test(name)) {
		return "Names starting SNOUTDATA_ or DENO_ are the platform's.";
	}
	return null;
}

/** Why a value cannot be a secret, or null: the stack's reader is one line per variable. */
export function secretValueProblem(value: string): string | null {
	if (value.length === 0) {
		return "A secret needs a value.";
	}
	return /[\r\n]/.test(value) ? "A secret is one line. For a key file, store it base64 encoded and decode it in the function." : null;
}

/** The names set in a functions/.env. */
export function secretNames(text: string): string[] {
	return [...parseEnv(text).keys()].sort((a, b) => a.localeCompare(b));
}

/** functions/.env with one secret set (or, with `value` null, removed), every other line kept. */
export function withSecret(text: string, name: string, value: string | null): string {
	const kept = text.split(/\r?\n/).filter((line) => {
		const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
		return !(match && match[1] === name);
	});
	while (kept.length > 0 && kept[kept.length - 1] === '') {
		kept.pop();
	}
	if (value !== null) {
		// The stack's reader trims the value and takes off ONE pair of outer quotes, nothing else
		// (selfhost/src/functions.rs `parse_dotenv`), so single quotes round any value but a newline.
		kept.push(`${name}=${/^[A-Za-z0-9_.,:/@+=-]+$/.test(value) ? value : `'${value}'`}`);
	}
	return kept.length > 0 ? `${kept.join('\n')}\n` : '';
}

// --- the data API switch ------------------------------------------------------------------------
//
// The cloud dashboard has a Data API switch; locally the data API (REST, and GraphQL, which REST
// serves) is the stack's `rest` container. Stopping it is not a switch, because the next `up` starts
// it again, so the switch is a compose PROFILE: a `compose.override.yaml` (compose reads it beside
// `compose.yaml` on its own, so the README's `docker compose up` honours it too) puts `rest` in the
// `data-api` profile, and `COMPOSE_PROFILES` in `.env` says whether it runs. Nothing in the stack
// depends on `rest`, and with it off the gateway answers /rest/v1 with its own 502 sentence.

export const DATA_API_PROFILE = 'data-api';

/** First line of the override this app writes; any other override is the user's and is left alone. */
export const OVERRIDE_MARK = '# Written by the SnoutData desktop app';

/**
 * The app's additions to the published stack, in the one file compose reads beside it, so the
 * README's own `docker compose up` runs them too and `compose.yaml` stays the published one:
 *
 * - the data API runs only while COMPOSE_PROFILES includes `data-api` (its switch);
 * - auth's email subjects and templates come from MAIL_* in .env, and a template the project has
 *   made its own is served to auth from `auth/templates` by a static file server (auth fetches a
 *   template by URL, as the auth server does, and an empty value means its built-in one).
 */
export const APP_OVERRIDE = `${OVERRIDE_MARK}. Keep the first line: the app rewrites only a file that has it.
# The data API runs only while COMPOSE_PROFILES in .env includes data-api. Auth's email subjects and
# templates are MAIL_* in .env; the templates themselves are auth/templates/<kind>.html.
services:
  rest:
    profiles: [${DATA_API_PROFILE}]
  auth:
    environment:
${MAIL_KINDS_ORDER.map((kind) => `      AUTH_MAILER_SUBJECTS_${kind.toUpperCase()}: \${${mailEnv(kind).subject}:-}
      AUTH_MAILER_TEMPLATES_${kind.toUpperCase()}: \${${mailEnv(kind).template}:-}`).join('\n')}
  mail-templates:
    image: docker.io/library/busybox:1.37
    command: ["httpd", "-f", "-p", "8080", "-h", "/www"]
    restart: unless-stopped
    volumes:
      - ./${MAIL_DIR}:/www:ro
`;

/** Whether an override is ours but written by an older app, so it is brought up to date. */
export function overrideStale(override: string | null): boolean {
	return override !== null && override.startsWith(OVERRIDE_MARK) && override !== APP_OVERRIDE;
}

/** A profile list with one profile added or taken out, the rest in their order. */
export function withProfile(profiles: string, profile: string, on: boolean): string {
	const list = profiles.split(',').map((p) => p.trim()).filter((p) => p && p !== profile);
	if (on) {
		list.push(profile);
	}
	return list.join(',');
}

/**
 * Whether the data API runs. Without our override `rest` has no profile and always runs; with it,
 * only while the profile is listed. Compose's own default for an unset COMPOSE_PROFILES is the
 * stack's: `objects,images`, which does not include it.
 */
export function dataApiOn(env: Map<string, string>, override: string | null): boolean {
	if (override === null || !override.startsWith(OVERRIDE_MARK)) {
		return true;
	}
	return (env.get('COMPOSE_PROFILES') ?? 'objects,images').split(',').map((p) => p.trim()).includes(DATA_API_PROFILE);
}

/** The services that are meant to run once and exit 0. */
const ONE_SHOTS = new Set(['setup', 'functions-deploy']);

/** The services a running project has, whatever its profiles. `objects` and `images` are optional. */
export const CORE_SERVICES: ReadonlyArray<string> = ['db', 'auth', 'rest', 'metadata', 'storage', 'realtime', 'functions', 'gateway'];

// --- names --------------------------------------------------------------------------------------

/** A folder- and compose-safe name: lower case, letters, digits and dashes. */
export function slugify(name: string): string {
	const slug = name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
	return slug || 'project';
}

/**
 * The compose project name. The stack's compose file names itself `snout-stack`, so two projects
 * on one machine would share containers and volumes; `-p` overrides it, from the ref, which is
 * unique and never changes.
 */
export function composeProject(ref: string): string {
	return `snout-${ref.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
}

/** A project ref as `snout-stack init` makes them: 13 characters, a letter first. */
export function isRef(value: string): boolean {
	return /^[a-z][a-z0-9]{12}$/.test(value);
}

/** The image `init` runs from: the very one the downloaded compose file pins for `setup`. */
export function stackImageFrom(compose: string): string | null {
	const match = /(?:ghcr\.io\/snoutdata|\$\{SNOUT_IMAGES:-ghcr\.io\/snoutdata\})\/snout-stack:([A-Za-z0-9._-]+)/.exec(compose);
	return match ? `ghcr.io/snoutdata/snout-stack:${match[1]}` : null;
}

/** The names a project's gateway serves, from the compose file in its folder: the snout-stack tag
 *  it runs decides (shared/ownLayout.ts, `stackVocabulary`). Null (unreadable) is a current stack. */
export function composeVocabulary(compose: string | null): Vocabulary {
	const image = compose === null ? null : stackImageFrom(compose);
	return stackVocabulary(image ? image.slice(image.lastIndexOf(':') + 1) : null);
}

// --- .env ---------------------------------------------------------------------------------------

/** Undo `envValue`'s quoting. */
function unquote(raw: string): string {
	const value = raw.trim();
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1);
	}
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1).replace(/\\(["\\$])/g, '$1').replace(/\\n/g, '\n');
	}
	// Compose strips an inline comment from an unquoted value when a space precedes the `#`.
	const comment = value.search(/\s#/);
	return comment >= 0 ? value.slice(0, comment).trimEnd() : value;
}

/** Every `NAME=value` line, last one winning, as compose reads them. */
export function parseEnv(text: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const line of text.split(/\r?\n/)) {
		const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
		if (match) {
			out.set(match[1], unquote(match[2]));
		}
	}
	return out;
}

/** A value written so compose reads back exactly it: plain when it can be, quoted when not. */
export function envValue(value: string): string {
	if (/^[A-Za-z0-9_.,:/@+=-]*$/.test(value)) {
		return value;
	}
	if (!value.includes("'") && !value.includes('\n')) {
		return `'${value}'`;
	}
	return `"${value.replace(/(["\\$])/g, '\\$1').replace(/\n/g, '\\n')}"`;
}

/**
 * Set values in an `.env`, keeping everything else (the comments `init` wrote, anything the user
 * added). A name already there is rewritten where it stands; a new one is appended under one
 * marker line. `undefined` leaves a name alone; an empty string writes it empty.
 */
export function applyEnv(text: string, values: Record<string, string | undefined>): string {
	const pending = new Map(Object.entries(values).filter((e): e is [string, string] => e[1] !== undefined));
	const lines = text.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(lines[i]);
		if (match && pending.has(match[1])) {
			lines[i] = `${match[1]}=${envValue(pending.get(match[1]) as string)}`;
			pending.delete(match[1]);
		}
	}
	let out = lines.join('\n');
	if (pending.size > 0) {
		const marker = '# Set by the SnoutData desktop app.';
		if (!out.includes(marker)) {
			out = `${out.replace(/\n*$/, '')}\n\n${marker}\n`;
		} else if (!out.endsWith('\n')) {
			out += '\n';
		}
		for (const [name, value] of pending) {
			out += `${name}=${envValue(value)}\n`;
		}
	}
	return out;
}

function flag(value: boolean): string {
	return value ? 'true' : 'false';
}

function apiUrlFor(port: number): string {
	return `http://localhost:${port}`;
}

/** What the wizard's answers write into `.env`, over what `init` made. */
export function envFor(form: LocalSetupForm): Record<string, string | undefined> {
	const profiles = [form.bundledStorage ? 'objects' : '', form.images ? 'images' : '', DATA_API_PROFILE].filter(Boolean).join(',');
	const values: Record<string, string | undefined> = {
		COMPOSE_PROFILES: profiles,
		API_EXTERNAL_URL: apiUrlFor(form.apiPort),
		SITE_URL: form.siteUrl.trim(),
		API_BIND: form.exposeApi ? '0.0.0.0' : '127.0.0.1',
		API_PORT: String(form.apiPort),
		DB_BIND: '127.0.0.1',
		DB_PORT: String(form.dbPort),
		AUTH_MAILER_AUTOCONFIRM: flag(form.autoconfirm),
		AUTH_DISABLE_SIGNUP: flag(form.disableSignup),
	};
	if (form.smtp && form.smtp.host.trim()) {
		Object.assign(values, {
			SMTP_HOST: form.smtp.host.trim(),
			SMTP_PORT: String(form.smtp.port),
			SMTP_USER: form.smtp.user,
			SMTP_PASS: form.smtp.pass,
			SMTP_ADMIN_EMAIL: form.smtp.adminEmail.trim(),
			SMTP_SENDER_NAME: form.smtp.senderName,
		});
	}
	if (!form.bundledStorage && form.s3) {
		Object.assign(values, {
			S3_ENDPOINT: form.s3.endpoint.trim(),
			S3_BUCKET: form.s3.bucket.trim(),
			S3_REGION: form.s3.region.trim() || 'us-east-1',
			S3_ACCESS_KEY: form.s3.accessKey,
			S3_SECRET_KEY: form.s3.secretKey,
			// The stack creates its own bucket only in the store it brought.
			S3_CREATE_BUCKET: 'false',
		});
	}
	return values;
}

/** Why the form cannot be sent, or null. The ports' availability is asked separately. */
export function formProblem(form: LocalSetupForm): string | null {
	if (!form.name.trim()) {
		return "Give the project a name.";
	}
	if (!form.folder.trim()) {
		return "Choose a folder for the project.";
	}
	for (const [label, port] of [["API port", form.apiPort], ["Database port", form.dbPort]] as const) {
		if (!Number.isInteger(port) || port < 1024 || port > 65535) {
			return `${label} must be a number from 1024 to 65535.`;
		}
	}
	if (form.apiPort === form.dbPort) {
		return "The API and the database need different ports.";
	}
	if (!/^https?:\/\/\S+$/.test(form.siteUrl.trim())) {
		return "Site URL must start with http:// or https://.";
	}
	if (!form.bundledStorage) {
		const s3 = form.s3;
		if (!s3 || !s3.endpoint.trim() || !s3.bucket.trim() || !s3.accessKey || !s3.secretKey) {
			return "Without the bundled file store, give your own S3 endpoint, bucket and keys.";
		}
	}
	return null;
}

function bool(env: Map<string, string>, name: string, fallback: boolean): boolean {
	const value = env.get(name);
	return value === undefined || value === '' ? fallback : value.toLowerCase() === 'true';
}

function int(env: Map<string, string>, name: string, fallback: number): number {
	const value = Number.parseInt(env.get(name) ?? '', 10);
	return Number.isFinite(value) ? value : fallback;
}

/** The changeable settings, read off `.env` with the compose file's own defaults. */
export function settingsFromEnv(env: Map<string, string>): LocalSettings {
	return {
		siteUrl: env.get('SITE_URL') ?? 'http://localhost:3000',
		apiPort: int(env, 'API_PORT', 8000),
		dbPort: int(env, 'DB_PORT', 5432),
		exposeApi: (env.get('API_BIND') ?? '0.0.0.0') !== '127.0.0.1',
		autoconfirm: bool(env, 'AUTH_MAILER_AUTOCONFIRM', false),
		disableSignup: bool(env, 'AUTH_DISABLE_SIGNUP', false),
		smtpHost: env.get('SMTP_HOST') ?? '',
		smtpPort: int(env, 'SMTP_PORT', 587),
		smtpUser: env.get('SMTP_USER') ?? '',
		smtpAdminEmail: env.get('SMTP_ADMIN_EMAIL') ?? '',
		smtpSenderName: env.get('SMTP_SENDER_NAME') ?? '',
		smtpPassSet: (env.get('SMTP_PASS') ?? '') !== '',
		googleEnabled: bool(env, 'GOOGLE_ENABLED', false),
		googleClientId: env.get('GOOGLE_CLIENT_ID') ?? '',
		githubEnabled: bool(env, 'GITHUB_ENABLED', false),
		githubClientId: env.get('GITHUB_CLIENT_ID') ?? '',
		fileSizeLimitMb: Math.round(int(env, 'STORAGE_FILE_SIZE_LIMIT', 52428800) / (1024 * 1024)),
		publicUrl: env.get('API_EXTERNAL_URL') ?? apiUrlFor(int(env, 'API_PORT', 8000)),
		clientAddressHeader: env.get('GATEWAY_CLIENT_ADDRESS_HEADER') ?? '',
		redirectUrls: list(env.get('AUTH_URI_ALLOW_LIST')),
		functionsMemoryMb: int(env, 'FUNCTIONS_MEMORY_MB', 256),
		functionsWallMs: int(env, 'FUNCTIONS_WALL_MS', 60000),
		functionsCpuMs: int(env, 'FUNCTIONS_CPU_MS', 5000),
		functionsContainerMb: memoryMb(env.get('FUNCTIONS_CONTAINER_MEMORY'), 1024),
		functionsNoVerify: list(env.get('FUNCTIONS_NO_VERIFY_JWT')),
	};
}

/** A comma-separated .env value as a list, blanks dropped. */
function list(value: string | undefined): string[] {
	return (value ?? '').split(',').map((v) => v.trim()).filter(Boolean);
}

/** A compose memory size (`1g`, `512m`, bytes) in MB. */
export function memoryMb(value: string | undefined, fallback: number): number {
	const match = /^\s*(\d+(?:\.\d+)?)\s*([kmgt]?)b?\s*$/i.exec(value ?? '');
	if (!match) {
		return fallback;
	}
	const scale: Record<string, number> = { '': 1 / (1024 * 1024), k: 1 / 1024, m: 1, g: 1024, t: 1024 * 1024 };
	return Math.round(Number(match[1]) * scale[match[2].toLowerCase()]);
}

/**
 * Where clients reach the gateway after a change. A public address the user set wins; otherwise,
 * while it is still the local default, it follows the API port, so a port change does not leave
 * every sign-in link pointing at the old one.
 */
function publicUrlAfter(change: LocalSettingsChange, current: LocalSettings | undefined): string | undefined {
	if (change.publicUrl !== undefined && change.publicUrl.trim() !== (current?.publicUrl ?? '')) {
		return change.publicUrl.trim().replace(/\/+$/, '');
	}
	if (change.apiPort === undefined) {
		return undefined;
	}
	if (!current || current.publicUrl === apiUrlFor(current.apiPort)) {
		return apiUrlFor(change.apiPort);
	}
	return undefined;
}

/** What a settings change writes. Only the fields given; a secret only when it is non-empty. */
export function envForSettings(change: LocalSettingsChange, current?: LocalSettings): Record<string, string | undefined> {
	const str = (v: string | undefined): string | undefined => (v === undefined ? undefined : v.trim());
	const num = (v: number | undefined): string | undefined => (v === undefined ? undefined : String(v));
	const yes = (v: boolean | undefined): string | undefined => (v === undefined ? undefined : flag(v));
	const secret = (v: string | undefined): string | undefined => (v ? v : undefined);
	return {
		SITE_URL: str(change.siteUrl),
		API_PORT: num(change.apiPort),
		API_EXTERNAL_URL: publicUrlAfter(change, current),
		GATEWAY_CLIENT_ADDRESS_HEADER: str(change.clientAddressHeader),
		DB_PORT: num(change.dbPort),
		API_BIND: change.exposeApi === undefined ? undefined : change.exposeApi ? '0.0.0.0' : '127.0.0.1',
		AUTH_MAILER_AUTOCONFIRM: yes(change.autoconfirm),
		AUTH_DISABLE_SIGNUP: yes(change.disableSignup),
		SMTP_HOST: str(change.smtpHost),
		SMTP_PORT: num(change.smtpPort),
		SMTP_USER: str(change.smtpUser),
		SMTP_PASS: secret(change.smtpPass),
		SMTP_ADMIN_EMAIL: str(change.smtpAdminEmail),
		SMTP_SENDER_NAME: change.smtpSenderName,
		GOOGLE_ENABLED: yes(change.googleEnabled),
		GOOGLE_CLIENT_ID: str(change.googleClientId),
		GOOGLE_SECRET: secret(change.googleSecret),
		GITHUB_ENABLED: yes(change.githubEnabled),
		GITHUB_CLIENT_ID: str(change.githubClientId),
		GITHUB_SECRET: secret(change.githubSecret),
		STORAGE_FILE_SIZE_LIMIT: change.fileSizeLimitMb === undefined ? undefined : String(Math.max(1, Math.round(change.fileSizeLimitMb)) * 1024 * 1024),
		AUTH_URI_ALLOW_LIST: change.redirectUrls === undefined ? undefined : change.redirectUrls.map((u) => u.trim()).filter(Boolean).join(','),
		FUNCTIONS_MEMORY_MB: num(change.functionsMemoryMb === undefined ? undefined : Math.round(change.functionsMemoryMb)),
		FUNCTIONS_WALL_MS: num(change.functionsWallMs === undefined ? undefined : Math.round(change.functionsWallMs)),
		FUNCTIONS_CPU_MS: num(change.functionsCpuMs === undefined ? undefined : Math.round(change.functionsCpuMs)),
		FUNCTIONS_CONTAINER_MEMORY: change.functionsContainerMb === undefined ? undefined : `${Math.round(change.functionsContainerMb)}m`,
		FUNCTIONS_NO_VERIFY_JWT: change.functionsNoVerify === undefined ? undefined : change.functionsNoVerify.filter(isFunctionName).join(','),
	};
}

/** Why a settings change cannot be written, or null: the limits the runtime itself holds to. */
export function settingsProblem(change: LocalSettingsChange): string | null {
	for (const url of change.redirectUrls ?? []) {
		if (url.trim() && !/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(url.trim())) {
			return `${url.trim()} is not an address. Each redirect address starts with its scheme, like https://.`;
		}
		if (url.includes(',')) {
			return "A redirect address cannot hold a comma.";
		}
	}
	if (change.functionsMemoryMb !== undefined && (change.functionsMemoryMb < 64 || change.functionsMemoryMb > 4096)) {
		return "A function's memory is between 64 and 4096 MB.";
	}
	if (change.functionsContainerMb !== undefined && change.functionsContainerMb < 256) {
		return "The functions together need at least 256 MB.";
	}
	if (change.functionsMemoryMb !== undefined && change.functionsContainerMb !== undefined && change.functionsMemoryMb > change.functionsContainerMb) {
		return "One function cannot have more memory than all of them share.";
	}
	if (change.functionsWallMs !== undefined && (change.functionsWallMs < 1000 || change.functionsWallMs > 3600000)) {
		return "A call may run between 1 second and 1 hour.";
	}
	if (change.functionsCpuMs !== undefined && (change.functionsCpuMs < 100 || change.functionsCpuMs > 600000)) {
		return "A call's CPU time is between 100 ms and 10 minutes.";
	}
	return null;
}

/** Why a public address cannot be used, or null. */
export function publicUrlProblem(url: string): string | null {
	const value = url.trim();
	if (!/^https?:\/\/[^\s/]+(:\d+)?(\/[^\s]*)?$/.test(value)) {
		return "The address must start with http:// or https:// and name a host.";
	}
	// Plain http is fine on this machine and on the local network (a phone testing an app), and
	// nowhere else: sign-in tokens would cross the internet in the clear.
	const host = /^https?:\/\/([^/:]+)/.exec(value)?.[1] ?? '';
	const local = /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[a-z0-9-]+\.local)$/i.test(host);
	if (value.startsWith('http://') && !local) {
		return "A public address must be https://. Put a TLS proxy (Caddy, nginx) in front of the gateway.";
	}
	return null;
}

// --- the gateway --------------------------------------------------------------------------------

/**
 * The gateway paths the app may call with the server key on the user's behalf: the identity
 * operator API, files, and the data API, under our names (`/v1/identity/operator/`, `/v1/files/`,
 * `/v1/data/`) and the earlier ones the pinned stack serves (shared/ownLayout.ts). Nothing else, and nothing that could leave the gateway: a path,
 * never a URL, with no `..` and no doubled slash.
 *
 * Checked on the path as the gateway will route it, not as it was written: `fetch` turns `%2e%2e`
 * into `..` and resolves it, so `/rest/v1/%2e%2e/%2e%2e/functions/v1/x` would otherwise pass the
 * prefix test and land outside the list with the service key. So the path part is percent-decoded
 * until it stops changing, an encoded slash or backslash is refused outright (the decoded path
 * would route somewhere the written one does not say), and the URL parser's own normalisation must
 * agree with the decoded path and stay on the list too.
 */
export function apiPathAllowed(path: string): boolean {
	if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /\s/.test(path)) {
		return false;
	}
	// The query cannot change the route, and may hold a literal `%` (a `like` filter), so only the
	// path part is decoded.
	const pathname = path.split(/[?#]/, 1)[0];
	let decoded = pathname;
	for (let round = 0; ; round++) {
		// At every depth: a gateway that decodes once more than we expect must not find one either.
		if (/%(2f|5c)/i.test(decoded)) {
			return false;
		}
		const next = decodeAsciiEscapes(decoded);
		if (next === decoded) {
			break;
		}
		if (round >= 8) {
			return false;
		}
		decoded = next;
	}
	if (decoded.includes('..') || decoded.includes('//') || decoded.includes('\\') || path.includes('..')) {
		return false;
	}
	// What the URL parser makes of it (dot segments, `%2e` read as `.`) must be what was checked.
	let routed: string;
	try {
		const url = new URL(path, 'http://gateway.invalid');
		if (url.origin !== 'http://gateway.invalid') {
			return false;
		}
		routed = url.pathname;
	} catch {
		return false;
	}
	for (let round = 0; round < 10; round++) {
		const next = decodeAsciiEscapes(routed);
		if (next === routed) {
			break;
		}
		routed = next;
	}
	const listed = /^\/(v1\/identity\/operator\/|v1\/files\/|v1\/data\/|auth\/v1\/admin\/|storage\/v1\/|rest\/v1\/)/;
	return routed === decoded && listed.test(decoded) && listed.test(pathname);
}

/**
 * One round of percent-decoding, of the ASCII escapes only. Never throws (a stray `%` in a file
 * name is left as it is, as a lenient server would), and the characters that can move a route
 * (`.`, `/`, `\`) are all ASCII, so a multi-byte escape left encoded hides nothing.
 */
function decodeAsciiEscapes(text: string): string {
	return text.replace(/%([0-7][0-9a-f])/gi, (_match, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/** A service's refusal as a sentence: each server words its error under a different key. */
export function apiErrorMessage(body: unknown, text: string, status: number): string {
	if (body && typeof body === 'object') {
		const b = body as Record<string, unknown>;
		for (const key of ['msg', 'message', 'error_description', 'error']) {
			if (typeof b[key] === 'string' && (b[key] as string).trim()) {
				return b[key] as string;
			}
		}
	}
	return text.trim().slice(0, 300) || `HTTP ${status}`;
}

/** A Postgres URL for the project's owner. */
export function dbUrl(ref: string, password: string, port: number): string {
	return `postgresql://${ref}_owner:${encodeURIComponent(password)}@127.0.0.1:${port}/${ref}`;
}

// --- ports --------------------------------------------------------------------------------------

/** The first port from `preferred` up that nobody holds: not another local project, not a listener. */
export function suggestPort(preferred: number, taken: ReadonlySet<number>, isFree: (port: number) => boolean, limit = 50): number {
	for (let port = preferred; port < preferred + limit; port++) {
		if (!taken.has(port) && isFree(port)) {
			return port;
		}
	}
	return preferred;
}

// --- requirements -------------------------------------------------------------------------------

/** What `service.ts` found out about this machine, for `evaluateRequirements` to judge. */
export interface EngineFacts {
	platform: NodeJS.Platform;
	/** The `docker` binary, or null when there is none. */
	dockerPath: string | null;
	/** Docker Desktop (or Podman Desktop) is installed, so it can be started. */
	desktopInstalled: boolean;
	/** `docker info`: null when the CLI could not reach an engine, with why. */
	info: { serverVersion: string; operatingSystem: string; memTotal: number } | null;
	infoError?: string;
	/** `docker compose version --short`, or null when the plugin is missing. */
	composeVersion: string | null;
	/** The published stack could be reached. */
	network: boolean;
	networkError?: string;
}

/** `v2.29.1-desktop.1` → `[2, 29, 1]`. */
export function parseVersion(text: string): number[] | null {
	const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)] : null;
}

export function versionAtLeast(text: string, minimum: string): boolean {
	const have = parseVersion(text);
	const want = parseVersion(minimum) as number[];
	if (!have) {
		return false;
	}
	for (let i = 0; i < 3; i++) {
		if (have[i] !== want[i]) {
			return have[i] > want[i];
		}
	}
	return true;
}

function installLink(platform: NodeJS.Platform): { label: string; url: string } {
	if (platform === 'linux') {
		return { label: "Install Docker Engine", url: 'https://docs.docker.com/engine/install/' };
	}
	return { label: "Get Docker Desktop", url: 'https://www.docker.com/products/docker-desktop/' };
}

function gib(bytes: number): string {
	return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/** Each requirement, judged, with what to do about the ones that are not met. */
export function evaluateRequirements(facts: EngineFacts): LocalRequirements {
	const items: LocalRequirement[] = [];
	const link = installLink(facts.platform);

	if (!facts.dockerPath) {
		items.push({
			id: 'docker',
			label: "Docker",
			status: 'fail',
			detail: "The docker command was not found on this computer.",
			advice: facts.platform === 'linux'
				? "Install Docker Engine and the Compose plugin, then check again. Podman works too when its docker command is installed."
				: "Install Docker Desktop, start it once, then check again. Podman Desktop works too with its Docker compatibility switched on.",
			link,
		});
		return { ready: false, items };
	}
	items.push({ id: 'docker', label: "Docker", status: 'ok', detail: `Found at ${facts.dockerPath}.` });

	if (!facts.info) {
		const denied = /permission denied/i.test(facts.infoError ?? '');
		items.push({
			id: 'engine',
			label: "Engine running",
			status: 'fail',
			detail: denied
				? "Docker is running, but this account may not use it."
				: "Docker is installed but not running.",
			advice: denied
				? "Add yourself to the docker group (\"sudo usermod -aG docker $USER\"), sign out and back in, then check again."
				: facts.desktopInstalled
					? "Start Docker Desktop and wait until it says it is running, then check again."
					: facts.platform === 'linux'
						? "Start it (\"sudo systemctl start docker\"), then check again."
						: "Start your container engine, then check again.",
			canStartEngine: !denied && facts.desktopInstalled,
		});
	} else {
		items.push({
			id: 'engine',
			label: "Engine running",
			status: 'ok',
			detail: `${facts.info.operatingSystem || "Docker"} ${facts.info.serverVersion}.`.replace(/\s+\./, '.'),
		});
	}

	if (!facts.composeVersion) {
		items.push({
			id: 'compose',
			label: "Docker Compose",
			status: 'fail',
			detail: "The Compose plugin (docker compose) is not installed.",
			advice: facts.platform === 'linux'
				? "Install the docker-compose-plugin package, then check again."
				: "Docker Desktop includes it: update Docker Desktop, then check again.",
			link: { label: "Install Compose", url: 'https://docs.docker.com/compose/install/' },
		});
	} else if (!versionAtLeast(facts.composeVersion, MIN_COMPOSE)) {
		items.push({
			id: 'compose',
			label: "Docker Compose",
			status: 'fail',
			detail: `Compose ${facts.composeVersion} is installed; the stack needs ${MIN_COMPOSE} or later.`,
			advice: "Update Docker (or the Compose plugin), then check again.",
			link: { label: "Install Compose", url: 'https://docs.docker.com/compose/install/' },
		});
	} else {
		items.push({ id: 'compose', label: "Docker Compose", status: 'ok', detail: `Compose ${facts.composeVersion}.` });
	}

	if (facts.info) {
		const memory = facts.info.memTotal;
		items.push(memory > 0 && memory < MIN_ENGINE_MEMORY
			? {
				id: 'memory',
				label: "Memory",
				status: 'warn',
				detail: `The engine has ${gib(memory)} of memory.`,
				advice: "The stack uses about 170 MB idle and about 360 MB under load, but pulling and starting it is happier with 2 GB or more. Raise it in Docker Desktop's settings (Resources) if setup is slow.",
			}
			: { id: 'memory', label: "Memory", status: 'ok', detail: memory > 0 ? `The engine has ${gib(memory)}; the stack uses about 170 MB idle and about 360 MB under load.` : "The stack uses about 170 MB idle and about 360 MB under load." });
	}

	items.push(facts.network
		? { id: 'network', label: "Download", status: 'ok', detail: "The published stack is reachable." }
		: {
			id: 'network',
			label: "Download",
			status: 'fail',
			detail: `The published stack could not be reached${facts.networkError ? ` (${facts.networkError})` : ''}.`,
			advice: "Setup downloads the stack's compose file from GitHub and its images (about 670 MB) from ghcr.io. Check the connection or proxy, then check again.",
		});

	return {
		ready: items.every((i) => i.status !== 'fail'),
		items,
		engine: facts.info ? facts.info.operatingSystem || undefined : undefined,
	};
}

// --- state --------------------------------------------------------------------------------------

/** One line of `docker ps -a --format '{{json .}}'`, as far as this reads it. */
interface PsLine {
	/** Docker writes ; Podman's docker-compatible output writes an object. */
	Labels?: string | Record<string, string>;
	State?: string;
	Status?: string;
}

function labelOf(labels: string | Record<string, string>, name: string): string | undefined {
	if (typeof labels !== 'string') {
		return labels[name];
	}
	for (const part of labels.split(',')) {
		const eq = part.indexOf('=');
		if (eq > 0 && part.slice(0, eq) === name) {
			return part.slice(eq + 1);
		}
	}
	return undefined;
}

/**
 * Every compose-made container on the engine, grouped by compose project. One `docker ps` for
 * the whole list rather than a `compose ps` per project: the panel asks often, and `compose ps`
 * also needs each project's `.env` to read its own file.
 */
export function parseDockerPs(stdout: string): Map<string, LocalService[]> {
	const out = new Map<string, LocalService[]>();
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.trim()) {
			continue;
		}
		let row: PsLine;
		try {
			row = JSON.parse(line) as PsLine;
		} catch {
			continue;
		}
		const labels = row.Labels ?? '';
		const project = labelOf(labels, 'com.docker.compose.project');
		const name = labelOf(labels, 'com.docker.compose.service');
		if (!project || !name) {
			continue;
		}
		// A one-off (`compose run`) is not the service: it would show functions-deploy twice.
		if (labelOf(labels, 'com.docker.compose.oneoff')?.toLowerCase() === 'true') {
			continue;
		}
		const status = row.Status ?? '';
		const health = /\((healthy|unhealthy|health: starting)\)/.exec(status)?.[1]?.replace('health: ', '') ?? '';
		const exit = /Exited \((-?\d+)\)/.exec(status);
		const list = out.get(project) ?? [];
		list.push({
			name,
			state: (row.State ?? '').toLowerCase() || 'unknown',
			health,
			oneShot: ONE_SHOTS.has(name),
			exitCode: exit ? Number(exit[1]) : null,
		});
		out.set(project, list);
	}
	for (const list of out.values()) {
		list.sort((a, b) => a.name.localeCompare(b.name));
	}
	return out;
}

/** A project's state from its services. */
export function projectState(services: LocalService[]): LocalProjectRow['state'] {
	const longRunning = services.filter((s) => !s.oneShot);
	if (longRunning.length === 0) {
		return 'stopped';
	}
	const running = longRunning.filter((s) => s.state === 'running');
	if (running.length === 0) {
		return 'stopped';
	}
	if (running.some((s) => s.health === 'starting') || longRunning.some((s) => s.state === 'restarting' || s.state === 'created')) {
		return 'starting';
	}
	const core = CORE_SERVICES.filter((name) => longRunning.some((s) => s.name === name));
	const coreUp = core.every((name) => running.some((s) => s.name === name && s.health !== 'unhealthy'));
	return coreUp && running.length === longRunning.length ? 'running' : 'partial';
}

/** The last few lines of a failed command, for a sentence: the error is nearly always there. */
export function tailOf(text: string, lines = 6): string {
	return text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length > 0).slice(-lines).join('\n');
}

/** A function name the runtime will serve: a folder name, not `_shared`, not a dotfile. */
export function isFunctionName(name: string): boolean {
	return /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(name);
}

/** The new-function template: the same shape as the stack's own `hello`. */
export function functionTemplate(name: string): string {
	return [
		`// A function: functions/${name}/index.ts, served at /functions/v1/${name}.`,
		'// Deploy a change from the Functions section of the project, or: docker compose run --rm functions-deploy',
		'Deno.serve(async (req) => {',
		'\tconst body = await req.json().catch(() => ({}));',
		`\treturn Response.json({ function: ${JSON.stringify(name)}, received: body });`,
		'});',
		'',
	].join('\n');
}

// --- keys, passwords and exports (the Settings section) -----------------------------------------
//
// What the cloud's control plane does for a hosted project, done here for a local one with the
// stack's own rules: the keys are HS256 tokens signed with JWT_SECRET exactly as `snout-stack init`
// signs them (selfhost/src/keys.rs), and the owner's password reaches Postgres as a SCRAM verifier,
// so the clear text is never in a statement the server could log.

/** `bytes` random bytes as base64url: safe on a `.env` line and in a connection string. */
export function randomSecret(bytes: number): string {
	return randomBytes(bytes).toString('base64url');
}

/** An HS256 token, signed as the stack signs one. */
export function signHs256(secret: string, claims: Record<string, unknown>): string {
	const head = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url');
	const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
	const mac = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
	return `${head}.${body}.${mac}`;
}

/** The role names a project's keys carry. A stack `snout-stack init` made from 0.1.6 on is in the
 *  new layout and has `snout_app`/`snout_server` (0.1.8's init signs its keys with them); one made
 *  before is in the old layout and has only `anon`/`service_role`. */
export type KeyRole = 'snout_app' | 'snout_server' | 'anon' | 'service_role';

/** A project API key: the stack's claims (keys.rs `api_key`), keys in serde_json's sorted order. */
export function apiKey(secret: string, role: KeyRole): string {
	return signHs256(secret, { exp: 4102444800, iat: 0, iss: 'snoutdata', role });
}

/** The roles to sign a project's keys with: the new names when its `.env` says the database is in
 *  the new layout (`REST_ANON_ROLE=snout_app`, which `init` writes and the README's move to the new
 *  layout adds), else the old names, the only ones an old-layout database has. A key signed with
 *  the old names keeps working in a new-layout database while they are alias roles of the new. */
export function keyRoles(env: ReadonlyMap<string, string>): { app: KeyRole; server: KeyRole } {
	return env.get('REST_ANON_ROLE') === 'snout_app'
		? { app: 'snout_app', server: 'snout_server' }
		: { app: 'anon', server: 'service_role' };
}

/** The `.env` names of the two keys, ours first: `snout-stack init` writes the earlier pair
 *  (`ANON_KEY`, `SERVICE_ROLE_KEY`) and its compose file reads them, so either may be in a `.env`. */
export const KEY_ENV = {
	app: ['APP_KEY', 'ANON_KEY'],
	server: ['SERVER_KEY', 'SERVICE_ROLE_KEY'],
} as const;

/** A key out of `.env`, under whichever of its names the file uses. */
export function envKey(env: ReadonlyMap<string, string>, which: keyof typeof KEY_ENV): string | undefined {
	for (const name of KEY_ENV[which]) {
		const value = env.get(name);
		if (value) {
			return value;
		}
	}
	return undefined;
}

/** A new JWT secret and the two keys signed with it: what rotating the keys writes into `.env`,
 *  under each name the file already carries (the stack's own when it carries neither), signed with
 *  the role names its database has (`keyRoles`). */
export function rotatedKeys(env: ReadonlyMap<string, string> = new Map(), secret = randomSecret(48)): Record<string, string> {
	const out: Record<string, string> = { JWT_SECRET: secret };
	const roles = keyRoles(env);
	for (const [which, role] of [['app', roles.app], ['server', roles.server]] as const) {
		const names = KEY_ENV[which].filter((name) => env.has(name));
		for (const name of names.length > 0 ? names : [KEY_ENV[which][1]]) {
			out[name] = apiKey(secret, role);
		}
	}
	return out;
}

/** A SCRAM-SHA-256 verifier (RFC 5802/7677), the form Postgres stores: `alter role … password '<this>'`. */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
	const salted = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256');
	const clientKey = createHmac('sha256', salted).update('Client Key').digest();
	const storedKey = createHash('sha256').update(clientKey).digest();
	const serverKey = createHmac('sha256', salted).update('Server Key').digest();
	return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/** The statement that sets the owner's password. The ref is checked, the verifier is base64 and `$:`. */
export function ownerPasswordSql(ref: string, verifier: string): string {
	if (!isRef(ref) || !/^SCRAM-SHA-256\$\d+:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(verifier)) {
		throw new Error('Not a project ref or a SCRAM verifier.');
	}
	return `alter role "${ref}_owner" with password '${verifier}';\n`;
}

/** The folder in a project an export is written to, beside .env (and kept out of git with it). */
export const EXPORT_DIR = 'backups';

/** An export's file name: the ref and the moment, so a listing sorts by time. */
export function exportName(ref: string, at: Date): string {
	const stamp = at.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
	return `${ref}-${stamp}.dump`;
}

/** A file name `exportName` could have made: nothing else in the folder is restored from. */
export function isExportName(name: string): boolean {
	return /^[a-z][a-z0-9]{12}-\d{8}-\d{6}\.dump$/.test(name);
}

/** Where an export is copied inside the `db` container for a restore, and removed after. */
export const RESTORE_FILE = '/tmp/snout-restore.dump';

/** The database an export is restored into, beside the project's, until the swap. */
export function restoreScratch(ref: string): string {
	if (!isRef(ref)) {
		throw new Error('Not a project ref.');
	}
	return `${ref}_restore`;
}

/**
 * A restore, step one, as a shell script for the `db` container: the export into a SCRATCH
 * database beside the project's, which is not touched, so a restore that fails changes nothing.
 *
 * - The scratch database comes from template0: the dump makes everything in it.
 * - Event triggers are left out of the main pass and made last, because the stack's privilege
 *   guard (an extension) watches them: it refuses a superuser's event trigger whose function a
 *   non-superuser owns, and core refuses to hand an event trigger to a non-superuser afterwards.
 *   So each function is lent to the admin for the `create event trigger`, and a trigger the export
 *   says the OWNER had (the guard made it so when the owner created it) is then made again as the
 *   owner, the way it first was. Those names are whatever a role chose (a quote, a dollar sign), so
 *   the export's lines reach the database as one psql-quoted literal and parse_ident reads them
 *   there; nothing from the export is ever assembled into SQL in the shell.
 * - pg_cron is left out too, with its jobs: it can be created only in the database named by
 *   `cron.database_name`, which is the project's and not the scratch one, so it is restored after
 *   the swap (`restoreAfterSwapScript`).
 * - The database's own settings and grants are copied from the project's database, which is what
 *   the export's `--create` entry would have carried and a plain restore does not.
 */
export function restoreScript(ref: string): string {
	const scratch = restoreScratch(ref);
	return `set -eu
D=${RESTORE_FILE}
PSQL="psql -X -q -v ON_ERROR_STOP=1 -h 127.0.0.1 -U snoutpod_admin"
$PSQL -d postgres -c 'drop database if exists "${scratch}" with (force)'
$PSQL -d postgres -c 'create database "${scratch}" template template0 owner "${ref}_owner"'
pg_restore -l "$D" > /tmp/snout-restore.all
grep -E '${CRON_TOC}' /tmp/snout-restore.all > /tmp/snout-restore-cron.list || true
grep ' EVENT TRIGGER ' /tmp/snout-restore.all > /tmp/snout-restore-et.list || true
grep -v -E '${CRON_TOC}| EVENT TRIGGER ' /tmp/snout-restore.all > /tmp/snout-restore.list
pg_restore --exit-on-error -h 127.0.0.1 -U snoutpod_admin -d "${scratch}" -L /tmp/snout-restore.list "$D"
pg_restore -f /tmp/snout-restore-et.all.sql -L /tmp/snout-restore-et.list "$D"
grep -v '^ALTER EVENT TRIGGER .* OWNER TO ' /tmp/snout-restore-et.all.sql > /tmp/snout-restore-et.sql || true
FNS=$(grep -o 'EXECUTE FUNCTION [A-Za-z0-9_."]*' /tmp/snout-restore-et.sql | awk '{print $3}' | sort -u | sed "s/.*/'&()'/" | paste -sd, -)
grep '^ALTER EVENT TRIGGER .* OWNER TO ' /tmp/snout-restore-et.all.sql > /tmp/snout-restore-et-owners.sql || true
if [ -n "$FNS" ]; then
	$PSQL -d "${scratch}" <<SQL
create temp table lent as select format('%I.%I()', n.nspname, p.proname) as fn, pg_get_userbyid(p.proowner) as owner from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.oid = any(array[$FNS]::regprocedure[]);
do \\$\\$ declare r record; begin for r in select * from lent loop execute format('alter function %s owner to snoutpod_admin', r.fn); end loop; end \\$\\$;
\\i /tmp/snout-restore-et.sql
do \\$\\$ declare r record; begin for r in select * from lent loop execute format('alter function %s owner to %I', r.fn, r.owner); end loop; end \\$\\$;
SQL
fi
if [ -s /tmp/snout-restore-et-owners.sql ]; then
	$PSQL -d "${scratch}" <<'SQL'
\\set owners \`cat /tmp/snout-restore-et-owners.sql\`
set snout.restore_owners = :'owners';
do $$
declare r record; tags text;
begin
	for r in select e.evtname, e.evtevent, e.evttags, format('%I.%I()', n.nspname, p.proname) as fn, o.owner
		from pg_event_trigger e join pg_proc p on p.oid = e.evtfoid join pg_namespace n on n.oid = p.pronamespace
		join (select (parse_ident(m[1]))[1] as name, (parse_ident(m[2]))[1] as owner
			from regexp_matches(current_setting('snout.restore_owners'), '^ALTER EVENT TRIGGER ("(?:[^"]|"")*"|[^ "]+) OWNER TO ("(?:[^"]|"")*"|[^ ";]+);$', 'gn') as m) as o on o.name = e.evtname
		join pg_roles ro on ro.rolname = o.owner where not ro.rolsuper loop
		tags := case when r.evttags is null then '' else format(' when tag in (%s)', (select string_agg(quote_literal(t), ', ') from unnest(r.evttags) t)) end;
		execute format('drop event trigger %I', r.evtname);
		execute format('set role %I', r.owner);
		execute format('create event trigger %I on %s%s execute function %s', r.evtname, r.evtevent, tags, r.fn);
		execute 'reset role';
	end loop;
end $$;
SQL
fi
$PSQL -d postgres <<'SQL'
update pg_database set datacl = (select datacl from pg_database where datname = '${ref}'), datconnlimit = (select datconnlimit from pg_database where datname = '${ref}') where datname = '${scratch}';
do $$
declare r record; kv text;
begin
	for r in select s.setrole, s.setconfig from pg_db_role_setting s join pg_database d on d.oid = s.setdatabase where d.datname = '${ref}' loop
		foreach kv in array r.setconfig loop
			if r.setrole = 0 then
				execute format('alter database %I set %s to %L', '${scratch}', split_part(kv, '=', 1), substr(kv, length(split_part(kv, '=', 1)) + 2));
			else
				execute format('alter role %I in database %I set %s to %L', pg_get_userbyid(r.setrole), '${scratch}', split_part(kv, '=', 1), substr(kv, length(split_part(kv, '=', 1)) + 2));
			end if;
		end loop;
	end loop;
end $$;
SQL
`;
}

/** The export's pg_cron entries: the extension, its comment, and the job tables' data and grants. */
const CRON_TOC = 'EXTENSION - pg_cron|EXTENSION pg_cron|(TABLE DATA|SEQUENCE SET|ACL|DEFAULT ACL) cron |SCHEMA - cron|SCHEMA cron';

/** A restore, step three, after the swap: pg_cron and its jobs into the project's database, then the files gone. */
export function restoreAfterSwapScript(ref: string): string {
	if (!isRef(ref)) {
		throw new Error('Not a project ref.');
	}
	return `set -eu
if [ -s /tmp/snout-restore-cron.list ]; then
	pg_restore --exit-on-error -h 127.0.0.1 -U snoutpod_admin -d "${ref}" -L /tmp/snout-restore-cron.list ${RESTORE_FILE}
fi
rm -f ${RESTORE_FILE} /tmp/snout-restore.all /tmp/snout-restore.list /tmp/snout-restore-cron.list /tmp/snout-restore-et.list /tmp/snout-restore-et.sql /tmp/snout-restore-et.all.sql
`;
}

/** After a failed step one: the scratch database and the copied export, gone. */
export function restoreCleanupScript(ref: string): string {
	return `psql -X -q -h 127.0.0.1 -U snoutpod_admin -d postgres -c 'drop database if exists "${restoreScratch(ref)}" with (force)'
rm -f ${RESTORE_FILE} /tmp/snout-restore.all /tmp/snout-restore.list /tmp/snout-restore-cron.list /tmp/snout-restore-et.list /tmp/snout-restore-et.sql /tmp/snout-restore-et.all.sql
`;
}

/**
 * Step two, with the services that hold sessions stopped: Realtime's replication slot dropped (a
 * database with one cannot be dropped), the project's database renamed aside, the restored one
 * renamed into its place, and the old one dropped.
 */
export function restoreSwapSql(ref: string): string {
	const scratch = restoreScratch(ref);
	return [
		`select pg_drop_replication_slot(slot_name) from pg_replication_slots where database = '${ref}';`,
		`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${ref}' and pid <> pg_backend_pid();`,
		// One transaction: the project's name is never left pointing at nothing.
		'begin;',
		`alter database "${ref}" rename to "${ref}_replaced";`,
		`alter database "${scratch}" rename to "${ref}";`,
		'commit;',
		`drop database "${ref}_replaced" with (force);`,
		'',
	].join('\n');
}
