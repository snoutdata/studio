/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	COMMENT_MARKER,
	checkConclusion,
	commentaryPrompt,
	doneReaction,
	planReview,
	renderComment,
	renderHelp,
	review,
	reviewableFiles,
	tidyPunctuation,
} from '@snout/review-core';
import type { DatabaseSchema as ReviewSchema, LocalProbeError, Probe, ProbeFailure, ProbeResult, ReviewCommand, ReviewReport } from '@snout/review-core';

import type { ConnectionConfig } from '../../shared/connection';
import { classifyError, readOnlyError } from '../../shared/engine';
import type { QueryResult } from '../../shared/query';
import type { ReviewMethod } from '../../shared/review';
import type { ConnectionManager } from '../connectionManager';
import { readConnections } from '../configStore';
import { forgeVocabulary } from './forge';
import type { CommitStatus, Forge, IssueComment, PullRequestRef } from './forge';
import type { ReviewStore, WatchedRepo } from './reviewStore';

/*---------------------------------------------------------------------------------------------
 *  Running one review, on this machine, against a database this app is already connected to.
 *
 *  The division of labour, which is the whole design:
 *    - `@snout/review-core` decides everything and touches nothing. It reads a diff and a
 *      schema, and it EMITS probes: read-only questions it would like answered.
 *    - this file is the host. It fetches from GitHub, runs the probes through the connection
 *      manager, and posts the comment as the user.
 *
 *  Three rules it enforces on the way, none of which the core can enforce for itself:
 *
 *    1. **A probe is re-checked here before it runs.** The core asserts its probes are
 *       read-only and a test holds it to that, but this is the last place before somebody's
 *       production database, and a guard that only exists upstream is a guard that will one
 *       day be bypassed by a refactor.
 *    2. **Probes run at background priority.** They must never starve the query the user is
 *       waiting on (`backgroundGate.ts`); a review is never more urgent than the person.
 *    3. **A failed probe is a gap, never a silent pass.** It goes in the report as something
 *       that could not be checked, and the comment prints it.
 *--------------------------------------------------------------------------------------------*/

/** Statements that make a probe not a probe. Belt and braces over the core's own check. */
const WRITE_KEYWORD = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|execute|exec|copy|vacuum|lock|set)\b/i;

/** The EXPLAIN forms `@snout/review-core`'s dialects wrap a statement in (`dialect.ts`). */
const EXPLAIN_PREFIX = /^explain(?:\s*\(\s*format\s+json\s*\)|\s+format\s*=\s*json|\s+query\s+plan|\s+plan\s+for)?\s+/i;

/** Per-probe ceiling. A review is a background chore, not something worth a long lock. */
const PROBE_TIMEOUT_MS = 20_000;
/** Above this many rows on the destination, a scanning probe is skipped and reported as such. */
const PROBE_ROW_CEILING = 50_000_000;

export interface ReviewOutcome {
	repoId: string;
	prNumber: number;
	/** The pull request's title and page, so the in-app view can name it and link out to it
	 *  without a second round-trip to GitHub for something already in hand. */
	prTitle: string;
	prUrl: string;
	headSha: string;
	report: ReviewReport;
	/** The comment body, whether or not it was posted. */
	body: string;
	/** Set when the comment reached GitHub. Absent when the user has approval turned on. */
	postedCommentId?: number;
	/** True when it is waiting for the user to approve posting. */
	awaitingApproval: boolean;
	/** The rung this run actually used, which is the repository's unless it was overridden. */
	method: ReviewMethod;
	/** `success` / `failure` / `neutral`, for a status line. */
	conclusion: ReturnType<typeof checkConclusion>;
	at: number;
}

export interface RunnerDeps {
	store: ReviewStore;
	connections: ConnectionManager;
	/** Builds the client for a repository's host, with its token out of the keychain. Throws when
	 *  that host has not been connected. GitHub or GitLab — nothing below cares which. */
	forge: (repo: WatchedRepo) => Promise<Forge>;
	/** Records what happened, for the audit trail and the in-app view. */
	onOutcome?: (outcome: ReviewOutcome) => void;
	/** Progress for the tray / status bar: "reviewing PR #124". */
	onStatus?: (status: string | undefined) => void;
	/** A review has BEGUN. Distinct from `onOutcome`, and the reason it exists: everything
	 *  between here and the outcome is silence otherwise, which is what made "Check now" look
	 *  like a dead button and a pull request look unreviewed while it was being reviewed. */
	onStarted?: (repo: WatchedRepo, pr: PullRequestRef) => void;
	/**
	 * The OPTIONAL prose pass.
	 *
	 * Injected rather than imported so this file keeps no opinion about models: the findings are
	 * decided and measured before it is called, and if it is absent, or throws, the review is the
	 * review. Absent in tests, which is the point — the rule set must never need one.
	 */
	commentary?: (prompt: { system: string; user: string }, method: ReviewMethod) => Promise<{ text: string; model: string }>;
	/** The saved connections. The store on disk unless a test hands its own. */
	readConnections?: () => ConnectionConfig[];
}

/** Is this probe safe to run? Returns why not, when it is not. */
export function probeRefusal(probe: Probe, tableRows?: number, driverId?: string): string | undefined {
	const sql = probe.sql.trim();
	if (!/^(select|explain)\b/i.test(sql)) {
		return 'it is not a read';
	}
	// Oracle's EXPLAIN PLAN writes the plan into PLAN_TABLE and returns no rows, so it is a write
	// that answers nothing. The read-only session would roll it back; it is simply not sent.
	if (probe.kind === 'explain' && driverId === 'oracle') {
		return "Oracle's EXPLAIN PLAN writes to PLAN_TABLE, and a review only reads";
	}
	// `EXPLAIN <write statement>` would plan a write on some vendors; only ever explain reads.
	const body = sql.replace(/^explain[^a-z]*/i, '');
	if (WRITE_KEYWORD.test(stripStrings(body).replace(/^select\b/i, ''))) {
		return 'it contains a write keyword';
	}
	if (sql.includes(';') && sql.indexOf(';') !== sql.length - 1) {
		return 'it contains more than one statement';
	}
	// The read guard every other read in the app passes, read the way the DESTINATION reads SQL:
	// Snowflake's `->>` runs the statement after it, SQL Server needs no `;` before a COMMIT, MySQL
	// runs the inside of `/*! */`. Deep mode's EXPLAIN carries the pull request's own SELECT, so
	// the statement inside the EXPLAIN is judged on its own too: a plain EXPLAIN is a read to the
	// guard whatever follows it on some engines (an outside review, 2026-10-14).
	const guarded = readOnlyError(sql, driverId);
	if (guarded) {
		return `the read check refused it (${guarded.replace(/^Refused:\s*/, '').replace(/\.$/, '')})`;
	}
	if (probe.kind === 'explain') {
		const inner = sql.replace(EXPLAIN_PREFIX, '');
		const innerGuarded = inner === sql ? 'it is not an EXPLAIN this reviewer builds' : readOnlyError(inner, driverId);
		if (innerGuarded) {
			return `the read check refused the statement it explains (${innerGuarded.replace(/^Refused:\s*/, '').replace(/\.$/, '')})`;
		}
	}
	if (tooCostly(probe, tableRows)) {
		return `\`${probe.table}\` is too large to count without cost (${tableRows!.toLocaleString()} rows)`;
	}
	return undefined;
}

/** A counting probe on a table too large to scan for a review. */
function tooCostly(probe: Probe, tableRows: number | undefined): boolean {
	return probe.cost === 'scan' && tableRows !== undefined && tableRows > PROBE_ROW_CEILING;
}

/** What the reviewer says when a command was written before the latest push. */
export function movedNote(pullRequest: string, headSha: string): string {
	return `This ${pullRequest} changed after the review was asked for, so it was not run: a review runs only on the commit that was there when it was asked. To review the latest commit (\`${headSha.slice(0, 7)}\`), comment \`@snoutbot review\` again.`;
}

/** Blank string literals so a keyword inside one is not mistaken for a statement. */
function stripStrings(sql: string): string {
	return sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
}

export class ReviewRunner {
	constructor(private readonly deps: RunnerDeps) {}

	/**
	 * Review one pull request end to end.
	 *
	 * `command` carries what was asked for (`--deep`, a different destination). A review that
	 * nobody asked for passes the default command.
	 *
	 * `method` overrides the repository's own for THIS run only and is never written back. It is
	 * what "review this again with something else" is made of: the findings are deterministic, so
	 * re-running with a different rung changes who writes the explanation and nothing else, and a
	 * user trying our AI once on a repository set to the rules alone must not find they have
	 * changed that repository's setting by looking.
	 */
	async run(repo: WatchedRepo, pr: PullRequestRef, command: ReviewCommand, triggerCommentId?: number, method?: ReviewMethod): Promise<ReviewOutcome> {
		const github = await this.deps.forge(repo);
		this.deps.onStatus?.(`Reviewing ${repo.owner}/${repo.name} #${pr.number}`);
		this.deps.onStarted?.(repo, pr);
		// Up before any work, so the pull request says it is being looked at for the whole time
		// it is being looked at. Swallowed like every other status call: see `status`.
		await this.status(github, repo, pr.headSha, { state: 'pending', description: 'Reviewing this change against the database', targetUrl: pr.htmlUrl });
		try {
			if (triggerCommentId !== undefined) {
				// Acknowledge before any work: the gap between asking and seeing something is
				// when a person asks again, and two queued reviews is how a thread gets ugly.
				await github.react(repo.owner, repo.name, pr.number, triggerCommentId, 'seen').catch(() => undefined);
			}

			const diff = await github.pullRequestDiff(repo.owner, repo.name, pr.number);
			const paths = pathFilter(repo);

			// Full file content, so a statement that begins in unchanged context is reviewed
			// whole rather than clipped to the lines the diff happens to add.
			const files: Record<string, string> = {};
			for (const file of filesToFetch(diff, paths)) {
				const content = await github.fileContent(repo.owner, repo.name, file, pr.headSha).catch(() => undefined);
				if (content !== undefined) {
					files[file] = content;
				}
			}

			// Bound to the commit it was started for: if the change moved while the diff and files were
			// fetched, they may be the new commit's, which nobody asked about. Nothing has touched the
			// database yet, so stop here.
			const current = await github.pullRequest(repo.owner, repo.name, pr.number);
			if (current.headSha !== pr.headSha) {
				throw new Error(`the ${forgeVocabulary(repo.forge).pullRequest} changed while it was being reviewed, so nothing was run`);
			}

			const { destination, gap, localError, prod } = await this.resolveDestination(repo, command);
			// Anything run against PRODUCTION waits for the user, whatever the repository says.
			// The comment goes out under their name and quotes their production database, so
			// "post as soon as it finishes" is a choice for every other destination only.
			const holdForApproval = repo.approveBeforePosting || prod === true;
			const base = {
				diff,
				files,
				paths,
				deep: command.deep,
				driverId: destination?.driverId,
				schema: destination?.schema,
				destinationName: destination?.name,
			};

			const probeResults = destination ? await this.runProbes(destination.connectionId, destination.driverId, base) : undefined;
			const report = review({ ...base, probeResults });
			// The destination was asked for and could not be had. It goes in the report as a gap so
			// the comment prints it, rather than the review reading as though text-only were the
			// plan. Same rule as a failed probe: never a silent pass.
			if (gap) {
				report.gaps.push(gap);
			}
			if (localError) {
				report.localErrors = [localError, ...(report.localErrors ?? [])];
			}
			// Every finding above is already decided and measured. This only adds prose under them,
			// and a failure here is a printed gap — never a reason to withhold the review.
			const commentary = await this.writeCommentary(repo, report, method);
			const body = renderComment(report, { branding: { handle: 'snoutbot' }, commentary });

			const outcome: ReviewOutcome = {
				repoId: repo.id,
				prNumber: pr.number,
				prTitle: pr.title,
				prUrl: pr.htmlUrl,
				headSha: pr.headSha,
				report,
				body,
				awaitingApproval: holdForApproval,
				method: method ?? repo.method,
				conclusion: checkConclusion(report),
				at: Date.now(),
			};

			if (!holdForApproval) {
				outcome.postedCommentId = await this.post(github, repo, pr.number, body);
				await this.finish(github, repo, pr.number, triggerCommentId, report);
			}
			await this.status(github, repo, pr.headSha, resultStatus(outcome, pr.htmlUrl));
			this.deps.onOutcome?.(outcome);
			return outcome;
		} catch (err) {
			// A review that broke must not leave `pending` on the commit forever: a check that
			// never resolves is worse than no check, because it reads as still running.
			await this.status(github, repo, pr.headSha, {
				state: 'neutral',
				description: `Could not review: ${err instanceof Error ? err.message : String(err)}`,
				targetUrl: pr.htmlUrl,
			});
			throw err;
		} finally {
			this.deps.onStatus?.(undefined);
		}
	}

	/**
	 * Ask a model to explain the findings, when the repository asked for one.
	 *
	 * Three things this deliberately does NOT do. It does not run before the report exists, so no
	 * model can influence a finding. It does not throw: a review whose prose failed is still a
	 * review, and the failure is printed as a gap so the silence is never mistaken for "there was
	 * nothing to say". And it does not run on a clean review — `commentaryPrompt` returns null
	 * there, and an essay about finding nothing is not worth anyone's AI allowance.
	 */
	private async writeCommentary(
		repo: WatchedRepo,
		report: ReviewReport,
		override?: ReviewMethod,
	): Promise<{ text: string; model: string } | undefined> {
		const method = override ?? repo.method;
		if (method.kind === 'deterministic' || !this.deps.commentary) {
			return undefined;
		}
		const prompt = commentaryPrompt(report, {
			branding: { handle: 'snoutbot' },
			destinationName: report.destinationName,
		});
		if (!prompt) {
			return undefined;
		}
		try {
			const written = await this.deps.commentary(prompt, method);
			// The prompt asks for no dashes; this is what makes it true. A model that ignores the
			// instruction would otherwise put em dashes into somebody's pull request under our name.
			const text = tidyPunctuation(written.text).trim();
			return text === '' ? undefined : { ...written, text };
		} catch (err) {
			// The provider's words (a URL, a status, a key's prefix) stay in the review tab.
			report.gaps.push('the written explanation could not be produced; every finding above is unaffected');
			report.localErrors = [
				...(report.localErrors ?? []),
				{ about: 'the written explanation', error: err instanceof Error ? err.message : String(err) },
			];
			return undefined;
		}
	}

	/**
	 * Post a review the user approved after the fact.
	 *
	 * The status is settled HERE and not when the review ran: with approval on, the review is
	 * done but nothing has been said, so the commit correctly reads `pending` until the user
	 * decides. `sha` and `status` come from the run the view is showing.
	 */
	async postApproved(repo: WatchedRepo, prNumber: number, body: string, sha?: string, result?: CommitStatus): Promise<number> {
		const forge = await this.deps.forge(repo);
		const id = await this.post(forge, repo, prNumber, body);
		if (sha && result) {
			await this.status(forge, repo, sha, result);
		}
		return id;
	}

	/** Answer a review command that was written before the change's latest push, which is not run:
	 *  it was asked about another commit. A comment of its own, never the review's. */
	async postMoved(repo: WatchedRepo, prNumber: number, headSha: string): Promise<number> {
		const forge = await this.deps.forge(repo);
		const body = movedNote(forgeVocabulary(repo.forge).pullRequest, headSha);
		return (await forge.createComment(repo.owner, repo.name, prNumber, body)).id;
	}

	/** Answer `@snoutbot help` without running anything. */
	async postHelp(repo: WatchedRepo, prNumber: number): Promise<number> {
		return this.post(await this.deps.forge(repo), repo, prNumber, renderHelp({ branding: { handle: 'snoutbot' } }));
	}

	/**
	 * Put a status on the commit, and never let it matter.
	 *
	 * The token may simply not carry the permission (it is one more box on GitHub's fine-grained
	 * form, and an older token predates our asking for it), the host may be having a bad day, and
	 * a self-hosted GitLab may have statuses turned off entirely. None of that is a reason to
	 * withhold a review that has already been done, so this is the one call in the runner whose
	 * failure is not even a gap.
	 */
	private async status(forge: Forge, repo: WatchedRepo, sha: string, status: CommitStatus): Promise<void> {
		await forge.setStatus(repo.owner, repo.name, sha, status).catch(() => undefined);
	}

	/** One comment per pull request, edited in place — never a new comment per push. */
	private async post(github: Forge, repo: WatchedRepo, prNumber: number, body: string): Promise<number> {
		const existing = await this.findOurComment(github, repo, prNumber);
		if (existing) {
			await github.updateComment(repo.owner, repo.name, prNumber, existing.id, body);
			return existing.id;
		}
		const created = await github.createComment(repo.owner, repo.name, prNumber, body);
		return created.id;
	}

	private async findOurComment(github: Forge, repo: WatchedRepo, prNumber: number): Promise<IssueComment | undefined> {
		const login = this.deps.store.loginFor(repo.forge)?.toLowerCase();
		const comments = await github.comments(repo.owner, repo.name, prNumber);
		return comments.find(
			(c) => c.body.includes(COMMENT_MARKER) && (!login || c.authorLogin.toLowerCase() === login),
		);
	}

	private async finish(github: Forge, repo: WatchedRepo, prNumber: number, commentId: number | undefined, report: ReviewReport): Promise<void> {
		if (commentId === undefined) {
			return;
		}
		const blockers = report.findings.filter((f) => f.severity === 'blocker').length;
		const warnings = report.findings.filter((f) => f.severity === 'warn').length;
		// The core's `doneReaction` answers in GitHub's vocabulary ('+1'); each host names its own
		// emoji, so what crosses this boundary is the INTENT and the client picks the name.
		if (doneReaction(blockers, warnings)) {
			await github.react(repo.owner, repo.name, prNumber, commentId, 'good').catch(() => undefined);
		}
	}

	/**
	 * The connection a repository is reviewed against, and its schema.
	 *
	 * IT CONNECTS. That is not an implementation detail, it is the fix for the defect that made a
	 * correctly configured repository review itself text-only: the schema is served from the
	 * language server's cache, the cache is populated by CONNECTING, and this used to do no more
	 * than ask for whatever happened to be there. A user who had bound "MySQL - dev" and chosen
	 * "read the schema and measure the data" got the static tier unless they had also, by hand, in
	 * this session, opened that connection in the editor. A background chore that only works when
	 * the user has already done something unrelated does not work.
	 *
	 * AND IT SAYS WHEN IT CANNOT. Every failure below returns a `gap`, which the caller puts in the
	 * report so the comment prints it. A silent fall back to the static tier is the whole bug: the
	 * footer then reads "no database was connected", which is TRUE about the run and flatly
	 * contradicts the setting the user just made, with nothing anywhere to reconcile the two. The
	 * one case that is not a gap is a repository deliberately set to `static`, and an unbound one,
	 * where text-only IS the configuration and the footer already says so correctly.
	 */
	private async resolveDestination(
		repo: WatchedRepo,
		command: ReviewCommand,
	): Promise<{
		destination?: { connectionId: string; driverId: string; name: string; schema?: ReviewSchema };
		gap?: string;
		/** The driver's error behind `gap`, for the review tab only; never posted. */
		localError?: LocalProbeError;
		/** The connection this run chose is flagged production, reached or not. */
		prod?: boolean;
	}> {
		if (repo.depth === 'static') {
			return {};
		}
		const configured = (this.deps.readConnections ?? readConnections)();
		const pick = pickDestination(repo, command, configured);
		if (pick.kind === 'refused') {
			// They named one explicitly and it is not this repository's. Guessing at another is
			// the worst possible answer ("review this against production" landing on dev would be
			// measured, plausible and wrong), and the reply names NO connection: whoever wrote the
			// comment learns nothing about what else this machine can reach.
			return { gap: NOT_BOUND_GAP };
		}
		if (pick.kind === 'none') {
			return {};
		}
		const connectionId = pick.connectionId;
		const config = configured.find((c) => c.id === connectionId);
		if (!config) {
			// The binding outlived the connection it pointed at.
			return { gap: 'the connection this repository was bound to no longer exists, so nothing here was measured' };
		}
		const prod = config.environment === 'prod';
		const label = repo.destinationName ?? config.label;
		let schema: ReviewSchema | undefined;
		try {
			// Cheapest first: if it is already connected the schema is in hand and nothing is
			// disturbed. Connecting is the fallback, not the opening move, so a live session is
			// never torn down and re-made for a background chore.
			schema = ((await this.deps.connections.getSchema(connectionId)) ?? undefined) as ReviewSchema | undefined;
			if (!schema) {
				await this.deps.connections.connect(connectionId);
				schema = ((await this.deps.connections.getSchema(connectionId)) ?? undefined) as ReviewSchema | undefined;
			}
		} catch (err) {
			// Unreachable, wrong password, tunnel down. Named, because "the database was not
			// consulted" with no reason is indistinguishable from "you did not ask me to".
			// The driver's words stay on this computer: they carry hosts, ports and user names.
			return {
				gap: `${label} could not be reached, so nothing here was measured`,
				localError: { about: `connecting to ${label}`, error: err instanceof Error ? err.message : String(err) },
				prod,
			};
		}
		if (!schema) {
			// Connected, and still nothing. Rare, and worth its own sentence rather than being
			// folded into the error above: nothing failed, so there is no message to print.
			return { gap: `${label} was reached but returned no schema, so nothing here was measured`, prod };
		}
		return {
			destination: {
				connectionId,
				driverId: config.driver,
				name: label,
				// The app's DatabaseSchema is structurally what review-core asks for, by design —
				// see `packages/review-core/src/schema.ts`. No adapter, nothing to drift.
				schema,
			},
			prod,
		};
	}

	/** Plan the probes, refuse the ones that are not safe or not cheap, run the rest. */
	private async runProbes(
		connectionId: string,
		driverId: string,
		input: Parameters<typeof planReview>[0],
	): Promise<ProbeResult[]> {
		const plan = planReview(input);
		const results: ProbeResult[] = [];
		for (const probe of plan.probes) {
			const rows = tableRows(input.schema, probe.table);
			const refusal = probeRefusal(probe, rows, driverId);
			if (refusal) {
				// The refusal names the table and quotes the read guard: it is for the review tab.
				// The comment says only which kind of refusal it was.
				results.push({ id: probe.id, ok: false, error: `not run because ${refusal}`, failure: tooCostly(probe, rows) ? 'too-costly' : 'refused' });
				continue;
			}
			const outcome = await this.execute(connectionId, probe);
			results.push(outcome);
		}
		return results;
	}

	private execute(connectionId: string, probe: Probe): Promise<ProbeResult> {
		return runProbe(this.deps.connections, connectionId, probe);
	}
}

/** What a refused `--on` prints. Deliberately names nothing: not the label asked for, not the
 *  labels that exist. */
export const NOT_BOUND_GAP =
	'the destination named in the command is not one this repository is bound to, so nothing here was measured';

/**
 * Which connection a review runs against.
 *
 * `review --on <name>` may only choose among the connections BOUND to this repository, by the
 * connection's label or the destination name the comment quotes. It is a comment anyone allowed
 * to command the reviewer can write, and before this it could name any saved connection on the
 * machine, production and unbound ones included. A name that is unknown and a name that exists
 * but is not bound here are the same answer, so the reply cannot be used to list connections.
 */
export function pickDestination(
	repo: Pick<WatchedRepo, 'connectionId' | 'destinationName'>,
	command: Pick<ReviewCommand, 'destination'>,
	configured: readonly { id: string; label: string }[],
): { kind: 'connection'; connectionId: string } | { kind: 'none' } | { kind: 'refused' } {
	const bound = repo.connectionId ? [repo.connectionId] : [];
	if (command.destination !== undefined) {
		const asked = command.destination.trim().toLowerCase();
		const match = bound.find((id) => {
			const label = configured.find((c) => c.id === id)?.label;
			return label?.toLowerCase() === asked || (id === repo.connectionId && repo.destinationName?.toLowerCase() === asked);
		});
		return match ? { kind: 'connection', connectionId: match } : { kind: 'refused' };
	}
	return repo.connectionId ? { kind: 'connection', connectionId: repo.connectionId } : { kind: 'none' };
}

/**
 * Run one probe that `probeRefusal` passed.
 *
 * Through `executeRead`: the database is asked to refuse a write too (a read-only transaction,
 * or a rollback where the engine has none), so a probe, and above all deep mode's EXPLAIN of the
 * pull request's own SQL, cannot change anything even if the lexical check missed something. A
 * read never goes through AI transcription. `recordHistory` is false because a review's probes are
 * not the user's query history, and the priority is 'background' so a review never starves the
 * query the person is waiting on.
 */
export async function runProbe(
	connections: Pick<ConnectionManager, 'executeRead'>,
	connectionId: string,
	probe: Probe,
	timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<ProbeResult>((resolve) => {
		timer = setTimeout(() => resolve({ id: probe.id, ok: false, error: `it took longer than ${timeoutMs / 1000}s`, failure: 'timeout' }), timeoutMs);
	});
	const run = (async (): Promise<ProbeResult> => {
		try {
			const result = await connections.executeRead(connectionId, probe.sql, false, 'background');
			if (!result.ok) {
				return { id: probe.id, ok: false, error: result.error, failure: failureOf(result.error) };
			}
			return { id: probe.id, ok: true, rows: toRows(result.result) };
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			return { id: probe.id, ok: false, error, failure: failureOf(error) };
		}
	})();
	try {
		return await Promise.race([run, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The kind of a probe's failure, by the engine's own classifier where it has a class for it.
 * The rest (an object that does not exist, a permission) review-core classifies itself. Either
 * way the comment gets a fixed sentence and never the database's words.
 */
function failureOf(error: string | undefined): ProbeFailure | undefined {
	const kind = classifyError(error ?? '', 'execution');
	return kind === 'timeout' ? 'timeout' : kind === 'resource-limit' ? 'resource' : undefined;
}

/** Approximate size of the table a probe reads, from the schema we already have. */
function tableRows(schema: ReviewSchema | undefined, table: string | undefined): number | undefined {
	if (!schema || !table) {
		return undefined;
	}
	const bare = table.toLowerCase().split('.').pop();
	return schema.tables.find((t) => t.name.toLowerCase() === bare)?.stats?.rowCount;
}

/**
 * The app's QueryResult (fields + row arrays) as the plain records review-core reads.
 *
 * The field list is `fields`, not `columns` (`shared/query.ts`). Reading the wrong name made this
 * return `[]` for EVERY probe, and an empty result is not an error: `countFrom` saw no rows, no
 * finding was raised, and the probe was counted as a check that ran and came back clean. So a
 * review of a migration that WOULD fail said "2 checks ran against real data and came back clean"
 * and printed no numbers, which is the one thing this reviewer must never do.
 *
 * Typed against QueryResult now rather than a structural guess, so the next rename is a compile
 * error instead of a silent all-clear.
 */
export function toRows(result: QueryResult | undefined): Record<string, unknown>[] {
	if (!result?.fields || !result.rows) {
		return [];
	}
	return result.rows.map((row) => {
		const record: Record<string, unknown> = {};
		result.fields.forEach((field, i) => {
			record[field.name] = row[i];
		});
		return record;
	});
}

function pathFilter(repo: WatchedRepo): { include?: string[]; exclude?: string[] } | undefined {
	if (!repo.includePaths?.length && !repo.excludePaths?.length) {
		return undefined;
	}
	return { include: repo.includePaths, exclude: repo.excludePaths };
}

/** Paths in the diff worth fetching whole. Read straight off the diff headers so the fetch
 *  list is decided before any content is pulled. */
function filesToFetch(diff: string, paths: { include?: string[]; exclude?: string[] } | undefined): string[] {
	return reviewableFiles(diff, paths).map((f) => f.path);
}

/**
 * What the commit's check line says once a review is done.
 *
 * Deliberately the FINDINGS and not a verdict on the change: red means the migration will not
 * run or will lose data, which is a fact the reviewer measured, and nothing else turns it red.
 * A review nobody has approved yet stays amber (`neutral`) rather than green, because the number
 * beside it has not been said out loud on the pull request yet.
 */
export function resultStatus(outcome: ReviewOutcome, targetUrl?: string): CommitStatus {
	const { blockers, warnings, notes } = countFindings(outcome.report);
	if (outcome.awaitingApproval) {
		return { state: 'neutral', description: `${summary(blockers, warnings, notes)}, waiting for you to approve posting`, targetUrl };
	}
	if (blockers > 0) {
		return { state: 'failure', description: summary(blockers, warnings, notes), targetUrl };
	}
	return { state: 'success', description: summary(blockers, warnings, notes), targetUrl };
}

function countFindings(report: ReviewReport): { blockers: number; warnings: number; notes: number } {
	let blockers = 0;
	let warnings = 0;
	let notes = 0;
	for (const finding of report.findings) {
		if (finding.severity === 'blocker') {
			blockers++;
		} else if (finding.severity === 'warn') {
			warnings++;
		} else {
			notes++;
		}
	}
	return { blockers, warnings, notes };
}

/** The one line a host has room for. Zero counts are left out rather than said. */
function summary(blockers: number, warnings: number, notes: number): string {
	const parts: string[] = [];
	if (blockers > 0) {
		parts.push(`${blockers} ${blockers === 1 ? 'blocker' : 'blockers'}`);
	}
	if (warnings > 0) {
		parts.push(`${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`);
	}
	if (notes > 0) {
		parts.push(`${notes} ${notes === 1 ? 'note' : 'notes'}`);
	}
	return parts.length === 0 ? 'Nothing to flag' : parts.join(', ');
}
