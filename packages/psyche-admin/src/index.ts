/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The admin API of a Psyche, the AI gateway (snout-psyche, its README), as one typed client for
// every screen that manages one: the admin console (the central SnoutData AI Psyche), the
// dashboard and Studio (a project owner's own), and the CLI. It holds no logic of its own: every
// rule is Psyche's, and this only names the calls and their shapes.
//
// No dependencies and no I/O of its own: the TRANSPORT is handed in, because each surface reaches
// the API differently (the admin console through its gated `admin-ai` function, the dashboard and
// Studio through the control plane for a Cloud project or straight to a local stack's Psyche, the
// CLI with a project's service key). A transport sends one call to `/ai/v1/<path>` and returns the
// parsed JSON, or throws a `PsycheError` carrying Psyche's own sentence.

/** Sends one admin call. `path` is relative to `/ai/v1/` (`admin/models`, `admin/usage?by=day`). */
export type Transport = (method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown) => Promise<unknown>

/** A refusal, in Psyche's words (`error.message` of its OpenAI-shaped error body). */
export class PsycheError extends Error {
	readonly status: number
	readonly code?: string

	constructor(message: string, status: number, code?: string) {
		super(message)
		this.name = 'PsycheError'
		this.status = status
		this.code = code
	}
}

/** Psyche's error body, or a sentence for a reply that is not one. Shared by every transport. */
export function errorFrom(status: number, body: unknown): PsycheError {
	const error = (body as { error?: { message?: unknown; code?: unknown } } | null)?.error
	if (error && typeof error.message === 'string') {
		return new PsycheError(error.message, status, typeof error.code === 'string' ? error.code : undefined)
	}
	const plain = (body as { error?: unknown } | null)?.error
	return new PsycheError(typeof plain === 'string' ? plain : `The gateway answered ${status}.`, status)
}

export type ProviderKind = 'openai' | 'anthropic' | 'bedrock'

export interface Provider {
	name: string
	kind: ProviderKind
	base_url: string
	region: string | null
	/** The stored credential it takes, by name. */
	credential: string | null
	/** Whether that credential is stored; null when it names none. */
	credential_stored: boolean | null
	/** Where its key comes from. */
	key: 'credential' | 'environment' | 'none'
	/** `file`: written by the providers file at each start, so the API cannot change it. */
	origin: 'file' | 'api'
	models: string[]
	/** The header its key is sent in, instead of a Bearer token. */
	auth_header: string | null
	/** Why it is not served, when it is not. */
	problem: string | null
}

export interface ProviderInput {
	kind: ProviderKind
	base_url?: string
	region?: string
	credential?: string
	auth_header?: string
}

/** One model as its provider lists it (`upstreamModels`), for a picker. */
export interface UpstreamModel {
	/** The provider's own id: what a model's `upstream` is set to. */
	id: string
	/** Its display name, when the provider gives one that differs from the id. */
	name?: string
	owned_by?: string
	/** Seconds since the epoch, when the provider says. */
	created?: number
	/** The provider's word, or a guess from the id; absent when Psyche cannot tell. */
	kind?: 'chat' | 'embedding' | 'completion'
	context_window?: number
}

/** Dollars per million tokens, as providers publish them. */
export interface Price {
	input: number
	output: number
	cache_read?: number
	cache_write?: number
	/** Dollars per call. */
	request?: number
	/** Dollars per web search a provider runs. */
	web_search?: number
	long_context?: { above: number; input: number; output: number; cache_read?: number; cache_write?: number }
}

/** How far a model may reach: nothing on the public internet (only a model server on a private
 *  network), its provider, or its provider and that provider's web search and fetch tools. */
export type ModelInternet = 'none' | 'provider' | 'web'

export interface Model {
	name: string
	provider: string
	upstream: string
	prompt_caching: boolean
	max_output_tokens: number | null
	reasoning: string | null
	embeddings: string | null
	/** The price set on the model itself; null when it takes the shipped catalogue's or none. */
	own_price: Price | null
	/** The price it is charged at. */
	price: Price | null
	price_from: 'model' | 'catalogue' | null
	enabled: boolean
	/** Whether it is served now; a model that is not says why in `problem`. */
	served: boolean
	origin: 'file' | 'api'
	edited: boolean
	access: 'everyone' | 'granted'
	/** How many users and groups it is granted to. */
	grants: number
	problem: string | null
	/** What it can take, as written; null when it says nothing, which keeps it out of `auto`. */
	fits: Fits | null
	/** How far it may reach; absent means `provider`. */
	internet?: ModelInternet
	/** What it may be sent in a minute; null when no limit is written. */
	quota?: Quota | null
}

/** What a model may be sent in a minute, for a provider's limit Psyche cannot read from its answers. */
export interface Quota {
	/** Requests a minute. */
	requests?: number
	/** Tokens a minute, prompt and reply together. */
	tokens?: number
}

/** What a model can take: its whole window in tokens, and whether it takes tools, images and a
 *  reply held to a JSON schema. `auto` chooses only among models that write these, and every route
 *  leaves out a model whose facts rule a request out. */
export interface Fits {
	context?: number | null
	tools?: boolean
	images?: boolean
	json_schema?: boolean
	/** The account behind this model keeps nothing from its calls, as its owner says. */
	no_data_collection?: boolean
}

/** A model as `PUT` takes it. The PUT REPLACES the model, so a field left out is reset (access to
 *  `everyone`, enabled to true): an edit starts from `modelInput(model)`, never from a blank. */
export interface ModelInput {
	provider: string
	upstream?: string
	prompt_caching?: boolean
	max_output_tokens?: number
	/** How a Bedrock or Anthropic model is asked to reason: `budget`, `adaptive` or `effort`. */
	reasoning?: string
	/** The body a Bedrock embedding model takes: `titan` or `cohere`. */
	embeddings?: string
	/** Its own price; left out, the shipped catalogue's, or none. */
	price?: Price
	/** What it can take. Unlike the rest, left out it is KEPT as it was; `{}` clears it. */
	fits?: Fits
	/** How far it may reach. Like `fits`, left out it is KEPT as it was. */
	internet?: ModelInternet
	/** What it may be sent in a minute. Like `fits`, left out it is KEPT as it was; `{}` clears it. */
	quota?: Quota
	enabled?: boolean
	access?: 'everyone' | 'granted'
}

/** `order`: as written; `price`: the cheapest first; `latency` and `throughput`: the fastest first,
 *  as measured (see {@link TargetHealth}), a model not yet measured ahead of them; `weighted`: drawn
 *  in proportion to the route's weights, health and remaining quota; `balanced`: drawn in proportion
 *  to price, health, speed, remaining quota and the weights together. */
export type RouteSort = 'order' | 'price' | 'latency' | 'throughput' | 'weighted' | 'balanced'

/** The most a target of a route may cost, in dollars per million tokens or per request or image. */
export interface MaxPrice {
	prompt?: number
	completion?: number
	request?: number
	image?: number
}

/** What a route requires of every target. A target that does not say it meets one is left out. */
export interface RouteConstraints {
	/** The smallest window, in tokens. */
	context?: number
	tools?: boolean
	images?: boolean
	json_schema?: boolean
	/** The regions a target may be in; a provider that names no region is in none of them. */
	regions?: string[]
	no_data_collection?: boolean
	max_price?: MaxPrice
}

/** A name a caller asks for that stands for several models, tried in turn when one fails for a
 *  reason that is not the caller's. */
export interface Route {
	name: string
	/** The models, as written. */
	targets: string[]
	sort: RouteSort
	/** A target's share of a `weighted` or `balanced` route, by model name. */
	weights?: Record<string, number> | null
	/** What every target must meet. */
	constraints?: RouteConstraints | null
	origin: 'file' | 'api'
	created_at: string
	updated_at: string
	/** What it tries now, in that order: the targets that are served, sorted. */
	tried: string[]
	/** Targets it skips, because they are not served (disabled, removed, or left out). */
	skipped: string[]
	served: boolean
}

/** What one target (a model, by its provider) did lately, as Psyche measures it from its own calls.
 *  A target that failed three times in a row cools down: a route tries it last until a probe call
 *  answers. */
export interface TargetHealth {
	provider: string
	model: string
	state: 'ok' | 'cooling' | 'probing'
	/** In the last five minutes. */
	requests: number
	failed: number
	rate_limited: number
	/** `failed / requests`; null with no requests. */
	error_rate: number | null
	/** Moving averages; null until measured. */
	first_byte_ms: number | null
	tokens_per_second: number | null
	failures_in_a_row: number
	/** Unix seconds, while it is cooling. */
	cooling_until: number | null
	/** The class of the last failure, as an error's `code`. */
	last_failure: string | null
	/** What the provider says is left on Psyche's credential, from its rate-limit headers. */
	remaining_requests: number | null
	remaining_tokens: number | null
	/** Unix seconds. */
	updated_at: number | null
}

export interface RouteInput {
	targets: string[]
	sort?: RouteSort
	/** Left out, a route keeps what it had; `{}` clears them. */
	weights?: Record<string, number>
	/** Left out, a route keeps what it had; `{}` clears them. */
	constraints?: RouteConstraints
}

/** Everything `model` is, as a `PUT` would write it again unchanged. */
export function modelInput(model: Model): ModelInput {
	const input: ModelInput = {
		provider: model.provider,
		upstream: model.upstream,
		prompt_caching: model.prompt_caching,
		enabled: model.enabled,
		access: model.access
	}
	if (model.max_output_tokens !== null) {
		input.max_output_tokens = model.max_output_tokens
	}
	if (model.reasoning !== null) {
		input.reasoning = model.reasoning
	}
	if (model.embeddings !== null) {
		input.embeddings = model.embeddings
	}
	if (model.own_price !== null) {
		input.price = model.own_price
	}
	if (model.fits) {
		input.fits = model.fits
	}
	if (model.internet !== undefined) {
		input.internet = model.internet
	}
	if (model.quota) {
		input.quota = model.quota
	}
	return input
}

/** Everything `route` is, as a `PUT` would write it again unchanged. */
export function routeInput(route: Route): RouteInput {
	return { targets: route.targets, sort: route.sort, weights: route.weights ?? {}, constraints: route.constraints ?? {} }
}

export type Credential =
	| { name: string; kind: 'api_key' | 'aws'; fingerprint: string; last_four: string; updated_at: number; used_by: string[]; stored: true }
	/** A name a provider asks for that is not stored yet. */
	| { name: string; used_by: string[]; stored: false }

/** A credential to store: an API key, or AWS credentials for Bedrock. Written once, never read back. */
export type CredentialInput = { api_key: string } | { access_key_id: string; secret_access_key: string; session_token?: string }

export interface Key {
	id: string
	name: string
	/** The key's first and last characters, which is all that is kept of it besides its hash. */
	hint: string
	owner: string | null
	/** The models it may call; null for every one. */
	models: string[] | null
	created_at: number
	expires_at: number | null
	revoked_at: number | null
	/** Its newest call in the request log, seconds since the epoch; null once that call is past the
	 *  log's retention, and for a key never used. */
	last_used_at: number | null
	/** The newest UTC day it made a call (`2026-10-19`), from the daily totals, kept for good. */
	last_used_on: string | null
}

/** A key just made: `key` is shown this once and never again. */
export interface NewKey extends Omit<Key, 'revoked_at' | 'last_used_at' | 'last_used_on'> {
	key: string
}

export interface KeyInput {
	name: string
	models?: string[]
	/** Seconds. */
	expires_in?: number
	/** A user's id, for a key that belongs to someone. */
	owner?: string
}

/** Whom a budget or limit is for: at most one of these, none for the whole project. */
export interface Whom {
	key_id?: string | null
	every_user?: boolean
	user_id?: string | null
	group_id?: string | null
}

export type Period = 'day' | 'month' | 'rolling' | 'since'

export interface Budget extends Required<Whom> {
	id: string
	name: string
	/** US dollars, as text so it is exact. */
	amount: string
	period: Period
	/** For `rolling`. */
	days: number | null
	/** For `since`: the first day, YYYY-MM-DD. */
	starts_on: string | null
	hard: boolean
	created_at: number
}

export interface BudgetInput extends Whom {
	name: string
	amount: number
	period: Period
	days?: number
	starts_on?: string
	hard?: boolean
}

export interface BudgetEdit {
	name?: string
	amount?: number
	period?: Period
	days?: number
	starts_on?: string
	hard?: boolean
}

export interface Limit extends Required<Whom> {
	id: string
	name: string
	requests_per_minute: number | null
	tokens_per_minute: number | null
}

export interface LimitInput extends Whom {
	name: string
	requests_per_minute?: number
	tokens_per_minute?: number
}

export interface Group {
	id: string
	name: string
	members: number
}

/** One user or one group a model that is `granted` is open to. */
export interface Grant {
	id: string
	model: string
	user_id: string | null
	group_id: string | null
	/** The group's name, for a group's grant. */
	group_name: string | null
	/** Milliseconds since the epoch. */
	created_at: number
}

export type GrantInput = { model: string; user_id: string } | { model: string; group_id: string }

export type UsageBy = 'day' | 'model' | 'provider' | 'operation' | 'key' | 'user' | 'group'

export interface UsageRow {
	requests: number
	failed: number
	cancelled: number
	prompt_tokens: number
	completion_tokens: number
	cached_tokens: number
	reasoning_tokens: number
	/** Dollars, exact, as text; null when nothing was priced. */
	cost: string | null
	/** The part credits paid. */
	credits_cost: string | null
	/** Calls whose model had no price, so they are missing from `cost`. */
	unpriced: number
	/** The group's value (a day, a model, a key's id, ...) under the `by` name; null for none. */
	[by: string]: string | number | null
}

export interface Usage {
	by: UsageBy
	from: string
	to: string
	data: UsageRow[]
}

export interface UsageQuery {
	by?: UsageBy
	/** YYYY-MM-DD, UTC; the last 30 days by default, at most 366. */
	from?: string
	to?: string
	model?: string
	key_id?: string
	user_id?: string
	group_id?: string
}

export interface RequestRow {
	/** Milliseconds since the epoch. */
	at: number
	operation: string
	model: string
	provider: string
	streamed: boolean
	/** `completed`, `cancelled`, or an error's code. */
	outcome: string
	prompt_tokens: number | null
	completion_tokens: number | null
	cached_tokens: number | null
	reasoning_tokens: number | null
	first_byte_ms: number
	total_ms: number
	cost: string | null
	key_id: string | null
	user_id: string | null
	group_id: string | null
	/** Paid by credits rather than the budgets. */
	credits: boolean
	/** The soft budgets it went over. */
	budget_warning: string | null
	/** The route the caller named (`models` for OpenRouter's list); null for a model. */
	route: string | null
	/** Which try of the call this row was, from 1; null on rows logged before routes. */
	attempt: number | null
	/** For `auto`, a route or a list: the order its models were tried in, and each left out with
	 *  its reason. Null for a model named alone, and on rows logged before Psyche 0.1.7. */
	routing: string | null
}

export interface RequestsQuery {
	limit?: number
	/** The previous page's `next_before`, an opaque cursor (microseconds, not `at`'s milliseconds). */
	before?: number
	model?: string
	outcome?: string
	key_id?: string
	user_id?: string
	group_id?: string
}

export interface Requests {
	data: RequestRow[]
	/** Pass as `before` for the next page; null on the last. */
	next_before: number | null
}

/** A Psyche's admin API, over a transport. */
export class PsycheAdmin {
	private readonly send: Transport

	constructor(send: Transport) {
		this.send = send
	}

	providers(): Promise<Provider[]> {
		return this.list('admin/providers')
	}
	putProvider(name: string, input: ProviderInput): Promise<Provider> {
		return this.call('PUT', `admin/providers/${segment(name)}`, input)
	}
	deleteProvider(name: string): Promise<void> {
		return this.none('DELETE', `admin/providers/${segment(name)}`)
	}
	/**
	 * A provider's own list of models, asked of the provider with its credential. With a name, a
	 * saved provider; with `{provider, credential}`, one not saved yet, kept nowhere. Rejects with
	 * the provider's sentence when it cannot list (no list, a refused key, no answer in 10 s).
	 */
	upstreamModels(from: string | { provider: ProviderInput; credential: CredentialInput | null }): Promise<UpstreamModel[]> {
		if (typeof from === 'string') {
			return this.list(`admin/providers/${segment(from)}/upstream-models`)
		}
		return this.call<{ data?: UpstreamModel[] } | null>('POST', 'admin/upstream-models', from).then((answer) => answer?.data ?? [])
	}

	models(): Promise<Model[]> {
		return this.list('admin/models')
	}
	/** Makes or changes a model. A model's name may hold `/`, which stays a `/` in the path. */
	putModel(name: string, input: ModelInput): Promise<Model> {
		return this.call('PUT', `admin/models/${modelPath(name)}`, input)
	}
	/** Sets how far a model may reach, leaving the rest of it as it is. */
	setInternet(model: Model, internet: ModelInternet): Promise<Model> {
		return this.putModel(model.name, { ...modelInput(model), internet })
	}
	/** Removes a model; one from the providers file is disabled instead. */
	deleteModel(name: string): Promise<{ name: string; deleted: boolean; disabled: boolean }> {
		return this.call('DELETE', `admin/models/${modelPath(name)}`)
	}

	routes(): Promise<Route[]> {
		return this.list('admin/routes')
	}
	/** Makes or replaces a route. Its name may hold `/`, as a model's may. */
	putRoute(name: string, input: RouteInput): Promise<{ name: string; targets: string[]; sort: string; origin: string }> {
		return this.call('PUT', `admin/routes/${modelPath(name)}`, input)
	}
	deleteRoute(name: string): Promise<void> {
		return this.none('DELETE', `admin/routes/${modelPath(name)}`)
	}
	/** Each target's health, as Psyche holds it now. */
	health(): Promise<TargetHealth[]> {
		return this.list('admin/health')
	}

	credentials(): Promise<Credential[]> {
		return this.list('admin/credentials')
	}
	/** Stores a credential once it is proven against each provider that names it. */
	putCredential(name: string, input: CredentialInput): Promise<{ name: string; kind: string; fingerprint: string; last_four: string }> {
		return this.call('PUT', `admin/credentials/${segment(name)}`, input)
	}
	deleteCredential(name: string): Promise<void> {
		return this.none('DELETE', `admin/credentials/${segment(name)}`)
	}

	keys(): Promise<Key[]> {
		return this.list('admin/keys')
	}
	createKey(input: KeyInput): Promise<NewKey> {
		return this.call('POST', 'admin/keys', input)
	}
	revokeKey(id: string): Promise<void> {
		return this.none('DELETE', `admin/keys/${segment(id)}`)
	}

	budgets(): Promise<Budget[]> {
		return this.list('admin/budgets')
	}
	createBudget(input: BudgetInput): Promise<Budget> {
		return this.call('POST', 'admin/budgets', input)
	}
	editBudget(id: string, edit: BudgetEdit): Promise<Budget> {
		return this.call('PATCH', `admin/budgets/${segment(id)}`, edit)
	}
	deleteBudget(id: string): Promise<void> {
		return this.none('DELETE', `admin/budgets/${segment(id)}`)
	}

	limits(): Promise<Limit[]> {
		return this.list('admin/limits')
	}
	createLimit(input: LimitInput): Promise<Limit> {
		return this.call('POST', 'admin/limits', input)
	}
	deleteLimit(id: string): Promise<void> {
		return this.none('DELETE', `admin/limits/${segment(id)}`)
	}

	groups(): Promise<Group[]> {
		return this.list('admin/groups')
	}

	/** Who models are granted to; with a name, that model's only. */
	grants(model?: string): Promise<Grant[]> {
		return this.list(`admin/grants${queryString({ model })}`)
	}
	/** Grants a model to one user or one group; granting it again answers the grant there is. */
	grant(input: GrantInput): Promise<Grant> {
		return this.call('POST', 'admin/grants', input)
	}
	revokeGrant(id: string): Promise<void> {
		return this.none('DELETE', `admin/grants/${segment(id)}`)
	}

	usage(query: UsageQuery = {}): Promise<Usage> {
		return this.call('GET', `admin/usage${queryString(query)}`)
	}
	requests(query: RequestsQuery = {}): Promise<Requests> {
		return this.call('GET', `admin/requests${queryString(query)}`)
	}

	private async list<T>(path: string): Promise<T[]> {
		const answer = (await this.send('GET', path)) as { data?: T[] } | null
		return answer?.data ?? []
	}
	private async call<T>(method: Parameters<Transport>[0], path: string, body?: unknown): Promise<T> {
		return (await this.send(method, path, body)) as T
	}
	private async none(method: Parameters<Transport>[0], path: string): Promise<void> {
		await this.send(method, path)
	}
}

/**
 * The models a picker shows for what has been typed: every word of `query` in the id or the name,
 * in the provider's order (chat first, newest first), at most `limit`.
 */
export function matchUpstream(models: UpstreamModel[], query: string, limit = 50): UpstreamModel[] {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean)
	const out: UpstreamModel[] = []
	for (const model of models) {
		const text = `${model.id} ${model.name ?? ''}`.toLowerCase()
		if (words.every((w) => text.includes(w))) {
			out.push(model)
			if (out.length >= limit) {
				break
			}
		}
	}
	return out
}

/** One path segment, encoded. */
function segment(text: string): string {
	return encodeURIComponent(text)
}

/** A model's name in its path: each part encoded, the `/` between them kept. */
export function modelPath(name: string): string {
	return name.split('/').map(segment).join('/')
}

/** `?a=1&b=2` from the set fields of `query`; empty when none is set. */
export function queryString(query: object): string {
	const pairs = Object.entries(query)
		.filter(([, value]) => value !== undefined && value !== null && value !== '')
		.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`)
	return pairs.length ? `?${pairs.join('&')}` : ''
}

/** A transport straight to a Psyche at `base` (`https://…/ai/v1`) with a bearer token: for the CLI,
 *  and for a local stack's Psyche, which is on the user's own machine. A browser never holds a
 *  service key, so the web surfaces use their own transport through a function instead. */
export function directTransport(base: string, token: () => string | Promise<string>, fetchImpl: typeof fetch = fetch): Transport {
	const root = base.replace(/\/+$/, '')
	return async (method, path, body) => {
		const response = await fetchImpl(`${root}/${path}`, {
			method,
			headers: {
				authorization: `Bearer ${await token()}`,
				...(body === undefined ? {} : { 'content-type': 'application/json' })
			},
			body: body === undefined ? undefined : JSON.stringify(body)
		})
		const text = await response.text()
		let parsed: unknown = null
		try {
			parsed = text ? JSON.parse(text) : null
		} catch {
			parsed = { error: text.slice(0, 300) }
		}
		if (!response.ok) {
			throw errorFrom(response.status, parsed)
		}
		return parsed
	}
}

/** Dollars from Psyche's exact text, for display; null stays null. */
export function dollars(text: string | null | undefined): number | null {
	if (text === null || text === undefined || text === '') {
		return null
	}
	const value = Number(text)
	return Number.isFinite(value) ? value : null
}

// The add-a-model guide's steps, per place a model runs (data only).
export * from './guides.ts'
