/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Adding a model, as a guide rather than a form: where the model runs, then that place's own steps
// (connect it, find the model's id, price it), in its own words and with links to its own screens.
// DATA ONLY, like the dashboard's SSO guide: every surface that adds a model draws these steps its
// own way (the admin console, the dashboard, Studio, the CLI printing them), so the instructions
// are written once.
//
// A source is not a provider kind. Psyche speaks three wire formats (`ProviderKind`); OpenAI,
// OpenRouter, Ollama and any other OpenAI-compatible server all speak the first, and differ only
// in where their key and their model ids are found, which is what a person adding one needs told.

import type { CredentialInput, ModelInput, ProviderInput, ProviderKind } from './index.ts'

export interface GuideLink {
	label: string
	href: string
}

/** How a source authenticates: an API key, AWS credentials or a Bedrock API key, or a header secret. */
export type GuideAuth = 'api_key' | 'bedrock' | 'optional'

export interface ModelSource {
	id: 'bedrock' | 'anthropic' | 'openai' | 'openrouter' | 'ollama' | 'compatible'
	name: string
	/** Two letters for its tile: no brand art. */
	mark: string
	/** One line on the picker. */
	blurb: string
	kind: ProviderKind
	/** What a new connection is called by default. */
	suggestedName: string
	/** The fixed address, or a starting point the person edits (`editableUrl`). */
	baseUrl?: string
	editableUrl?: boolean
	/** The placeholder for an address the person types. */
	urlExample?: string
	region?: boolean
	auth: GuideAuth
	/** Step 1: where the key comes from. */
	connect: { console?: GuideLink; steps: string[] }
	/** Step 2: where the model's id is found, and one example of it. */
	model: { link?: GuideLink; steps: string[]; example: string }
	/** Step 3: where its price is published, or what to charge for a machine of your own. */
	price: { link?: GuideLink; steps: string[] }
	/** Whether Psyche's prompt-caching switch means anything here. */
	caching: boolean
}

export const MODEL_SOURCES: ModelSource[] = [
	{
		id: 'bedrock',
		name: 'Amazon Bedrock',
		mark: 'AB',
		blurb: 'Claude, Llama, Mistral, Qwen and more, in your own AWS account.',
		kind: 'bedrock',
		suggestedName: 'bedrock',
		region: true,
		auth: 'bedrock',
		connect: {
			console: { label: 'AWS IAM console', href: 'https://console.aws.amazon.com/iam/home#/users' },
			steps: [
				'In IAM, make a user for the AI gateway (or reuse one) with a policy allowing bedrock:InvokeModel, bedrock:InvokeModelWithResponseStream and bedrock:Converse on the models you will serve.',
				'Under the user\'s Security credentials, choose Create access key, for an application running outside AWS, and copy the access key ID and the secret. The secret is shown once.',
				'Or use a Bedrock API key instead: Bedrock console, API keys, Generate.',
				'Pick the region the models are in. Inference profiles starting with us. or global. route across regions from there.'
			]
		},
		model: {
			link: { label: 'Bedrock model catalog', href: 'https://console.aws.amazon.com/bedrock/home#/model-catalog' },
			steps: [
				'Open the Bedrock model catalog in the region you picked and choose the model.',
				'If it asks for access, request it under Model access first; Anthropic models ask for a short use-case form once.',
				'Copy its inference profile ID (it starts with us., eu., apac. or global.). A model with no inference profile is called by its model ID.'
			],
			example: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0'
		},
		price: {
			link: { label: 'Bedrock pricing', href: 'https://aws.amazon.com/bedrock/pricing/' },
			steps: [
				'Find the model on Bedrock\'s pricing page under on-demand. AWS quotes per 1,000 tokens for some models: multiply by 1,000 for the per-million rate asked here.',
				'Leave the prices blank if the shipped catalogue already knows the model; the model list shows "from the catalogue" when it does.'
			]
		},
		caching: true
	},
	{
		id: 'anthropic',
		name: 'Anthropic',
		mark: 'An',
		blurb: 'Claude, straight from Anthropic\'s API.',
		kind: 'anthropic',
		suggestedName: 'anthropic',
		baseUrl: 'https://api.anthropic.com/v1',
		auth: 'api_key',
		connect: {
			console: { label: 'Anthropic Console, API keys', href: 'https://console.anthropic.com/settings/keys' },
			steps: [
				'In the Anthropic Console, open Settings, API keys, and choose Create key.',
				'Name it after this gateway and copy it. It starts with sk-ant- and is shown once.',
				'Make sure the organisation has credit or a billing plan, or every call is refused.'
			]
		},
		model: {
			link: { label: 'Claude models', href: 'https://docs.anthropic.com/en/docs/about-claude/models/overview' },
			steps: ['Open Anthropic\'s models overview and copy the model\'s API name, not its display name.'],
			example: 'claude-sonnet-4-5'
		},
		price: {
			link: { label: 'Anthropic API pricing', href: 'https://www.anthropic.com/pricing#api' },
			steps: [
				'Copy the input and output rates per million tokens. Cache reads and cache writes have their own rates on the same page.',
				'Leave the prices blank if the shipped catalogue already knows the model.'
			]
		},
		caching: true
	},
	{
		id: 'openai',
		name: 'OpenAI',
		mark: 'OA',
		blurb: 'GPT models, straight from OpenAI\'s API.',
		kind: 'openai',
		suggestedName: 'openai',
		baseUrl: 'https://api.openai.com/v1',
		auth: 'api_key',
		connect: {
			console: { label: 'OpenAI API keys', href: 'https://platform.openai.com/api-keys' },
			steps: [
				'On the OpenAI platform, open API keys and choose Create new secret key.',
				'Give it a project and the permission to call models, and copy it. It starts with sk- and is shown once.',
				'Check the project has billing set up; a key without it is refused on the first call.'
			]
		},
		model: {
			link: { label: 'OpenAI models', href: 'https://platform.openai.com/docs/models' },
			steps: ['Open OpenAI\'s models page, choose the model and copy its id from the top of its page.'],
			example: 'gpt-5-mini'
		},
		price: {
			link: { label: 'OpenAI API pricing', href: 'https://openai.com/api/pricing/' },
			steps: [
				'Copy the input and output rates per million tokens; "cached input" is the cache read rate. OpenAI caches by itself, so there is no cache write rate.',
				'Leave the prices blank if the shipped catalogue already knows the model.'
			]
		},
		caching: false
	},
	{
		id: 'openrouter',
		name: 'OpenRouter',
		mark: 'OR',
		blurb: 'Hundreds of models from many providers behind one key.',
		kind: 'openai',
		suggestedName: 'openrouter',
		baseUrl: 'https://openrouter.ai/api/v1',
		auth: 'api_key',
		connect: {
			console: { label: 'OpenRouter keys', href: 'https://openrouter.ai/settings/keys' },
			steps: [
				'On OpenRouter, open Settings, Keys, and choose Create Key. A credit limit on the key is a good second fence.',
				'Copy it. It starts with sk-or- and is shown once.',
				'Add credits to the account, or every paid model is refused.'
			]
		},
		model: {
			link: { label: 'OpenRouter models', href: 'https://openrouter.ai/models' },
			steps: ['Find the model on OpenRouter and copy its id from under its name: the provider, a slash and the model.'],
			example: 'anthropic/claude-sonnet-4.5'
		},
		price: {
			link: { label: 'OpenRouter models', href: 'https://openrouter.ai/models' },
			steps: ['Each model\'s page shows its input and output price per million tokens. Copy those; OpenRouter adds no fee on top of them for a key you pay for with credits.']
		},
		caching: true
	},
	{
		id: 'ollama',
		name: 'Ollama',
		mark: 'Ol',
		blurb: 'A model on a machine of your own, such as the home server.',
		kind: 'openai',
		suggestedName: 'home-ollama',
		editableUrl: true,
		urlExample: 'https://home-ai.snoutdata.com/v1',
		auth: 'optional',
		connect: {
			console: { label: 'Ollama documentation', href: 'https://github.com/ollama/ollama/blob/main/docs/openai.md' },
			steps: [
				'The address must reach Ollama from this gateway, so not localhost: a public HTTPS name, such as one through a Cloudflare tunnel, ending in /v1.',
				'Never leave it open: put a check in front of it (a Cloudflare rule that blocks any request without a secret header) and give that header\'s name and secret here.',
				'Check it from your own machine first: a request to the address plus /models with the header should list the models, and one without it should be refused.'
			]
		},
		model: {
			steps: [
				'On the Ollama machine, run ollama pull with the model first, if it is not there yet.',
				'Run ollama list and copy the NAME column exactly, tag included.'
			],
			example: 'snout-fim:1.0'
		},
		price: {
			steps: [
				'Your machine charges nothing per token, so the price is what you choose to count against a person\'s budget: a small rate, such as $0.05 in and $0.10 out, keeps a runaway caller inside it.',
				'Do not leave the price blank: the catalogue does not know your models, and a model nothing prices is refused to every signed-in user.'
			]
		},
		caching: false
	},
	{
		id: 'compatible',
		name: 'Any OpenAI-compatible server',
		mark: '{}',
		blurb: 'vLLM, LM Studio, Together, Groq, DeepSeek and the rest.',
		kind: 'openai',
		suggestedName: 'my-provider',
		editableUrl: true,
		urlExample: 'https://api.example.com/v1',
		auth: 'optional',
		connect: {
			steps: [
				'Find the server\'s OpenAI-compatible address in its documentation; it usually ends in /v1.',
				'Make an API key in its console and copy it. A server that checks a header of its own instead of a Bearer token takes the header\'s name too.'
			]
		},
		model: {
			steps: ['Copy the model id from the provider\'s model list, or from what the address plus /models returns.'],
			example: 'deepseek-chat'
		},
		price: {
			steps: [
				'Copy the input and output rates per million tokens from the provider\'s pricing page.',
				'For a server of your own, choose a small rate so budgets still count it; a model nothing prices is refused to every signed-in user.'
			]
		},
		caching: false
	}
]

/** Whether a connection already made is one of this source's: same wire format, same address. */
export function sourceMatches(source: ModelSource, provider: { kind: ProviderKind; base_url: string }): boolean {
	if (provider.kind !== source.kind) {
		return false
	}
	if (source.kind !== 'openai') {
		return true
	}
	const url = provider.base_url.replace(/\/+$/, '')
	if (source.baseUrl) {
		return url === source.baseUrl
	}
	// The editable ones are whatever is not one of the fixed addresses.
	return !MODEL_SOURCES.some((s) => s.baseUrl && s.kind === 'openai' && s.baseUrl === url)
}

/** A caller's name for an upstream id: its last part, lower case, `:` and `.` kept readable. */
export function suggestModelName(upstream: string): string {
	const last = upstream.trim().split('/').pop() ?? ''
	return last
		.replace(/^(us|eu|apac|global)\.(anthropic|meta|mistral|amazon|cohere|qwen|deepseek|openai)\./, '')
		.replace(/-v\d+:\d+$/, '')
		.replace(/:/g, '-')
		.toLowerCase()
}

/** What a person typed to connect a source, as the guide's first step collects it. */
export interface ConnectAnswers {
	/** The provider's address; unused for Bedrock. */
	baseUrl?: string
	/** Bedrock's region. */
	region?: string
	/** A key (`api_key`), or, for Bedrock with `aws`, an access key pair. */
	apiKey?: string
	aws?: boolean
	accessKeyId?: string
	secretAccessKey?: string
	/** An OpenAI-compatible server that wants its key in another header. */
	authHeader?: string
}

/**
 * The provider and credential bodies a guide's first step sends, or the sentence that says what is
 * missing. The credential is named after the provider, which is how Psyche finds it to prove it.
 */
export function connectBodies(
	source: ModelSource,
	name: string,
	answers: ConnectAnswers
): { provider: ProviderInput; credential: CredentialInput | null } | { problem: string } {
	const aws = source.auth === 'bedrock' && answers.aws === true
	const credential: CredentialInput | null = aws
		? answers.accessKeyId?.trim() && answers.secretAccessKey?.trim()
			? { access_key_id: answers.accessKeyId.trim(), secret_access_key: answers.secretAccessKey.trim() }
			: null
		: answers.apiKey?.trim()
			? { api_key: answers.apiKey.trim() }
			: null
	if (source.auth !== 'optional' && !credential) {
		return { problem: 'Paste the key from the first steps; Psyche checks it with the provider before keeping it.' }
	}
	if (source.kind !== 'bedrock' && !answers.baseUrl?.trim()) {
		return { problem: 'Give the address.' }
	}
	if (source.kind === 'bedrock' && !answers.region?.trim()) {
		return { problem: 'Give the region the model runs in.' }
	}
	const provider: ProviderInput = { kind: source.kind }
	if (source.kind === 'bedrock') {
		provider.region = answers.region!.trim()
	} else {
		provider.base_url = answers.baseUrl!.trim()
		if (answers.authHeader?.trim()) {
			provider.auth_header = answers.authHeader.trim()
		}
	}
	if (credential) {
		provider.credential = name
	}
	return { provider, credential }
}

/** What a person typed about the model and its price, as text from the form. */
export interface ModelAnswers {
	provider: string
	upstream: string
	input?: string
	output?: string
	cacheRead?: string
	cacheWrite?: string
	maxOutput?: string
	caching?: boolean
	enabled?: boolean
	access?: 'everyone' | 'granted'
}

function optionalNumber(text: string | undefined): number | undefined {
	return text === undefined || text.trim() === '' ? undefined : Number(text)
}

/**
 * The model body the guide's last step sends, or the sentence that says what is wrong. A price is
 * both rates or neither (neither takes the shipped catalogue's), each a number of dollars per
 * million tokens, zero or more.
 */
export function modelBody(answers: ModelAnswers): { model: ModelInput } | { problem: string } {
	if (!answers.upstream.trim()) {
		return { problem: "Give the model's id, as the provider names it." }
	}
	const [input, output, cacheRead, cacheWrite, cap] = [answers.input, answers.output, answers.cacheRead, answers.cacheWrite, answers.maxOutput].map(optionalNumber)
	if ([input, output, cacheRead, cacheWrite].some((v) => v !== undefined && (!Number.isFinite(v) || v < 0))) {
		return { problem: 'Prices are numbers, zero or more.' }
	}
	if ((input === undefined) !== (output === undefined)) {
		return { problem: "Give both the input and the output rate, or neither to take the catalogue's." }
	}
	const model: ModelInput = { provider: answers.provider, upstream: answers.upstream.trim() }
	if (answers.caching !== undefined) {
		model.prompt_caching = answers.caching
	}
	if (answers.enabled !== undefined) {
		model.enabled = answers.enabled
	}
	if (answers.access) {
		model.access = answers.access
	}
	if (input !== undefined && output !== undefined) {
		model.price = { input, output }
		if (cacheRead !== undefined) {
			model.price.cache_read = cacheRead
		}
		if (cacheWrite !== undefined) {
			model.price.cache_write = cacheWrite
		}
	}
	if (cap !== undefined && Number.isFinite(cap) && cap > 0) {
		model.max_output_tokens = Math.round(cap)
	}
	return { model }
}
