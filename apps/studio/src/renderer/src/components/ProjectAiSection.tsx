/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon';
import { useConfirm } from './ConfirmDialog';
import { Status, useLoad, type Said } from './projectUi';
import { formatLocale, useT } from '../i18n';
import type { ProjectTarget } from '../../../shared/projects';
import {
	PsycheAdmin, dollars, modelInput, notServing, psycheAnswer, routeInput,
	type Budget, type Fits, type Grant, type Group, type Limit, type MaxPrice, type Model, type ModelInput, type ModelInternet, type NewPsycheKey, type Period, type Price, type Provider, type ProviderKind, type PsycheKey, type Quota, type Route, type RouteConstraints, type RouteSort, type UpstreamModel, type UsageBy, type Whom,
} from '../../../shared/psycheAdmin';

// The project's AI gateway, the dashboard's AI section in the project tab: the same calls, through
// the control plane for a Cloud project and straight to the local stack for a Local one
// (`ProjectAccess.psyche`). This screen holds no rule: a refusal is the gateway's own sentence.

interface Held {
	models: Model[];
	routes: Route[];
	providers: Provider[];
	budgets: Budget[];
	limits: Limit[];
	keys: PsycheKey[];
}

type Tab = 'models' | 'routes' | 'providers' | 'keys' | 'budgets' | 'usage';

const TABS: Tab[] = ['models', 'routes', 'providers', 'keys', 'budgets', 'usage'];

const INTERNET_LEVELS: ModelInternet[] = ['none', 'provider', 'web'];
/** What the gateway assumes of a model that names no level. */
const DEFAULT_INTERNET: ModelInternet = 'provider';

const ROUTE_SORTS: RouteSort[] = ['order', 'price', 'latency', 'throughput', 'weighted', 'balanced'];
/** The value of a reasoning or embeddings select that sets neither. */
const NOT_SET = 'none';
const REASONING_KINDS = [NOT_SET, 'budget', 'adaptive', 'effort'];
const EMBEDDINGS_KINDS = [NOT_SET, 'titan', 'cohere'];
const SECONDS_A_DAY = 86400;

/** How often the section asks whether a gateway just switched on answers yet. */
const STARTING_POLL_MS = 5000;

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A number field's value, left out when blank. */
function numberOf(text: string): number | undefined {
	return text.trim() === '' ? undefined : Number(text);
}

function allNumbers(values: (number | undefined)[]): boolean {
	return values.every((value) => value === undefined || Number.isFinite(value));
}

/** A number as a field's text; none is a blank field. */
function textOf(value: number | null | undefined): string {
	return value === null || value === undefined ? '' : String(value);
}

/** Only the fields that say something, so a blank form is `{}`. */
function filled<T extends object>(fields: T): T {
	return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== false)) as T;
}

/** One action's progress and its outcome, shared by every form here. */
function useAct(): { busy: boolean; said: Said; setSaid(said: Said): void; act(work: () => Promise<void>): Promise<boolean> } {
	const [busy, setBusy] = useState(false);
	const [said, setSaid] = useState<Said>(null);
	const act = useCallback(async (work: () => Promise<void>): Promise<boolean> => {
		setBusy(true);
		setSaid(null);
		try {
			await work();
			return true;
		} catch (error) {
			setSaid({ ok: false, message: errorText(error) });
			return false;
		} finally {
			setBusy(false);
		}
	}, []);
	return { busy, said, setSaid, act };
}

export function ProjectAiSection({ target }: { target: ProjectTarget }): JSX.Element {
	const t = useT();
	const admin = useMemo(() => new PsycheAdmin(async (method, path, body) => psycheAnswer(await window.sqlApi.project.ai(target, method, path, body))), [target]);
	const state = useLoad(() => window.sqlApi.project.aiState(target), [target]);
	const [held, setHeld] = useState<Held | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [tab, setTab] = useState<Tab>('models');
	const { busy, said, setSaid, act } = useAct();
	const [confirm, confirmDialog] = useConfirm();

	const reload = useCallback(async () => {
		try {
			const [models, routes, providers, budgets, limits, keys] = await Promise.all([admin.models(), admin.routes(), admin.providers(), admin.budgets(), admin.limits(), admin.keys()]);
			setHeld({ models, routes, providers, budgets, limits, keys });
			setError(null);
		} catch (e) {
			setHeld(null);
			// Off, or still starting, is the ordinary answer here.
			setError(notServing(e) ? null : errorText(e));
		}
	}, [admin]);

	const enabled = state.data?.enabled === true;
	useEffect(() => {
		if (enabled) {
			void reload();
		}
	}, [enabled, reload]);

	// Switched on, the gateway takes a minute to answer.
	useEffect(() => {
		if (!enabled || held) {
			return;
		}
		const timer = window.setInterval(() => void reload(), STARTING_POLL_MS);
		return () => window.clearInterval(timer);
	}, [enabled, held, reload]);

	async function flip(on: boolean): Promise<void> {
		const ok = await confirm(on
			? { title: t('projects.ai.switchOnTitle'), body: target.kind === 'cloud' ? t('projects.ai.switchOnCloud') : t('projects.ai.switchOnLocal'), confirmLabel: t('projects.ai.switchOn') }
			: { title: t('projects.ai.switchOffTitle'), body: t('projects.ai.switchOffBody'), confirmLabel: t('projects.ai.switchOff'), danger: true });
		if (!ok) {
			return;
		}
		await act(async () => {
			const outcome = await window.sqlApi.project.setAi(target, on);
			setSaid({ ok: outcome.ok, message: outcome.message });
			setHeld(null);
			await state.reload();
		});
	}

	if (state.loading && !state.data) {
		return <div className="field-hint">{t('projects.common.loading')}</div>;
	}
	if (state.error) {
		return <div className="form-status error">{state.error}</div>;
	}
	if (state.data && !state.data.offered) {
		return <fieldset><legend>{t('projects.ai.gateway')}</legend><p className="field-hint">{t('projects.ai.notInStack')}</p></fieldset>;
	}

	return (
		<>
			{confirmDialog}
			<fieldset>
				<legend>{t('projects.ai.gateway')}</legend>
				<p className="field-hint">{t('projects.ai.gatewayHint')}</p>
				<label className="check">
					<input type="checkbox" checked={enabled} disabled={busy} onChange={(e) => void flip(e.target.checked)} />
					{t('projects.ai.switchLabel')}
				</label>
				{enabled && state.data && <p className="field-hint">{t('projects.ai.address')} <span className="mono">{state.data.endpoint}</span></p>}
				{enabled && !held && !error && <p className="field-hint">{t('projects.ai.starting')}</p>}
				<Status said={said} />
				{error && <div className="form-status error">{error}</div>}
			</fieldset>
			{enabled && held && (
				<>
					<div className="tabs">
						{TABS.map((id) => <button key={id} type="button" className={tab === id ? 'tab active' : 'tab'} onClick={() => setTab(id)}>{t(`projects.ai.tab.${id}`)}</button>)}
					</div>
					{tab === 'models' && <ModelsTab admin={admin} held={held} onChanged={reload} />}
					{tab === 'routes' && <RoutesTab admin={admin} held={held} onChanged={reload} />}
					{tab === 'providers' && <ProvidersTab admin={admin} held={held} onChanged={reload} />}
					{tab === 'keys' && <KeysTab admin={admin} held={held} onChanged={reload} />}
					{tab === 'budgets' && <BudgetsTab admin={admin} held={held} onChanged={reload} />}
					{tab === 'usage' && <UsageTab admin={admin} />}
				</>
			)}
		</>
	);
}

interface TabProps {
	admin: PsycheAdmin;
	held: Held;
	onChanged(): Promise<void>;
}

// ------------------------------------------------------------------------------- models

function priceText(model: Model, t: ReturnType<typeof useT>): string {
	return model.price ? t('projects.ai.models.price', { input: model.price.input, output: model.price.output }) : t('projects.ai.models.noPrice');
}

function ModelsTab({ admin, held, onChanged }: TabProps): JSX.Element {
	const t = useT();
	const { busy, said, act } = useAct();
	const [confirm, confirmDialog] = useConfirm();
	const [editing, setEditing] = useState<Model | 'new' | null>(null);

	async function setInternet(model: Model, level: ModelInternet): Promise<void> {
		await act(async () => {
			await admin.setInternet(model, level);
			await onChanged();
		});
	}

	async function remove(model: Model): Promise<void> {
		if (await confirm({ title: t('projects.ai.models.removeTitle', { name: model.name }), body: t('projects.ai.models.removeBody'), confirmLabel: t('projects.ai.models.remove'), danger: true })) {
			await act(async () => {
				await admin.deleteModel(model.name);
				await onChanged();
			});
		}
	}

	return (
		<fieldset>
			<legend>{t('projects.ai.tab.models')}</legend>
			{confirmDialog}
			{held.models.length === 0
				? <p className="field-hint">{t('projects.ai.models.empty')}</p>
				: (
					<table className="cloud-table">
						<thead>
							<tr>
								<th>{t('projects.ai.models.name')}</th>
								<th>{t('projects.ai.models.runsOn')}</th>
								<th>{t('projects.ai.models.priceColumn')}</th>
								<th>{t('projects.ai.models.state')}</th>
								<th>{t('projects.ai.models.internet')}</th>
								<th />
							</tr>
						</thead>
						<tbody>
							{held.models.map((model) => (
								<tr key={model.name}>
									<td className="mono">{model.name}</td>
									<td><span className="mono">{model.upstream}</span> {t('projects.ai.models.on', { provider: model.provider })}</td>
									<td>{priceText(model, t)}</td>
									<td className="cloud-nowrap" title={model.problem ?? undefined}>{model.served ? t('projects.ai.models.served') : model.enabled ? t('projects.ai.models.notServed') : t('projects.ai.models.off')}</td>
									<td>
										<InternetSelect label={t('projects.ai.models.internetFor', { name: model.name })} value={model.internet ?? DEFAULT_INTERNET} disabled={busy} onChange={(level) => void setInternet(model, level)} />
									</td>
									<td className="cloud-table-action">
										<button type="button" className="table-action" title={t('projects.ai.models.edit')} aria-label={t('projects.ai.models.edit')} disabled={busy} onClick={() => setEditing(model)}><Icon name="edit" /></button>
										{model.origin === 'api' && <button type="button" className="table-action" title={t('projects.ai.models.remove')} aria-label={t('projects.ai.models.remove')} disabled={busy} onClick={() => void remove(model)}><Icon name="trash" /></button>}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			{held.models.some((m) => !m.served && m.problem) && <p className="field-hint">{held.models.filter((m) => !m.served && m.problem).map((m) => `${m.name}: ${m.problem}`).join(' ')}</p>}
			<Status said={said} />
			{editing === null
				? <div className="cloud-actions"><button type="button" disabled={held.providers.length === 0} onClick={() => setEditing('new')}><Icon name="add" /> {t('projects.ai.models.add')}</button></div>
				: <ModelForm key={editing === 'new' ? '' : editing.name} admin={admin} providers={held.providers} model={editing === 'new' ? null : editing} onDone={() => setEditing(null)} onChanged={onChanged} />}
			{held.providers.length === 0 && <p className="field-hint">{t('projects.ai.models.needProvider')}</p>}
		</fieldset>
	);
}

/** How far a model may reach. A native select: SelectPopover.tsx opens our list. */
function InternetSelect({ label, value, disabled, onChange }: { label: string; value: ModelInternet; disabled?: boolean; onChange(level: ModelInternet): void }): JSX.Element {
	const t = useT();
	return (
		<select aria-label={label} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as ModelInternet)}>
			{INTERNET_LEVELS.map((level) => <option key={level} value={level}>{t(`projects.ai.models.internetLevel.${level}`)}</option>)}
		</select>
	);
}

function ModelForm({ admin, providers, model, onDone, onChanged }: { admin: PsycheAdmin; providers: Provider[]; model: Model | null; onDone(): void; onChanged(): Promise<void> }): JSX.Element {
	const t = useT();
	const { busy, said, setSaid, act } = useAct();
	const [provider, setProvider] = useState(model?.provider ?? providers[0]?.name ?? '');
	const [upstream, setUpstream] = useState(model?.upstream ?? '');
	const [name, setName] = useState(model?.name ?? '');
	const [enabled, setEnabled] = useState(model?.enabled ?? true);
	const [access, setAccess] = useState<Model['access']>(model?.access ?? 'everyone');
	const [input, setInput] = useState(textOf(model?.own_price?.input));
	const [output, setOutput] = useState(textOf(model?.own_price?.output));
	const [cacheRead, setCacheRead] = useState(textOf(model?.own_price?.cache_read));
	const [cacheWrite, setCacheWrite] = useState(textOf(model?.own_price?.cache_write));
	const [maxOutput, setMaxOutput] = useState(textOf(model?.max_output_tokens));
	const [caching, setCaching] = useState(model?.prompt_caching ?? false);
	const [reasoning, setReasoning] = useState(model?.reasoning ?? NOT_SET);
	const [embeddings, setEmbeddings] = useState(model?.embeddings ?? NOT_SET);
	const [internet, setInternet] = useState<ModelInternet>(model?.internet ?? DEFAULT_INTERNET);
	const [quotaRequests, setQuotaRequests] = useState(textOf(model?.quota?.requests));
	const [quotaTokens, setQuotaTokens] = useState(textOf(model?.quota?.tokens));
	const [context, setContext] = useState(textOf(model?.fits?.context));
	const [tools, setTools] = useState(model?.fits?.tools ?? false);
	const [images, setImages] = useState(model?.fits?.images ?? false);
	const [jsonSchema, setJsonSchema] = useState(model?.fits?.json_schema ?? false);
	const [noData, setNoData] = useState(model?.fits?.no_data_collection ?? false);
	const [offered, setOffered] = useState<UpstreamModel[]>([]);
	const kind = providers.find((p) => p.name === provider)?.kind;
	const takesReasoning = kind === 'anthropic' || kind === 'bedrock';
	const takesEmbeddings = kind === 'bedrock';

	useEffect(() => {
		let live = true;
		setOffered([]);
		if (provider) {
			// A provider with no list simply offers none: the id is still typed by hand.
			void admin.upstreamModels(provider).then((list) => {
				if (live) {
					setOffered(list);
				}
			}).catch(() => undefined);
		}
		return () => {
			live = false;
		};
	}, [admin, provider]);

	async function save(): Promise<void> {
		const rates = { input: numberOf(input), output: numberOf(output), cache_read: numberOf(cacheRead), cache_write: numberOf(cacheWrite) };
		const longest = numberOf(maxOutput);
		const quota = filled<Quota>({ requests: numberOf(quotaRequests), tokens: numberOf(quotaTokens) });
		const contextTokens = numberOf(context);
		if (!allNumbers([...Object.values(rates), longest, quota.requests, quota.tokens, contextTokens])) {
			setSaid({ ok: false, message: t('projects.ai.numberInvalid') });
			return;
		}
		const finalName = (model?.name ?? name.trim()) || upstream.trim();
		const base: ModelInput = model ? modelInput(model) : { provider };
		delete base.price;
		delete base.max_output_tokens;
		delete base.reasoning;
		delete base.embeddings;
		const priced = Object.values(rates).some((rate) => rate !== undefined);
		const done = await act(async () => {
			await admin.putModel(finalName, {
				...base,
				provider,
				upstream: upstream.trim(),
				enabled,
				access,
				prompt_caching: caching,
				internet,
				quota,
				fits: filled<Fits>({ context: contextTokens, tools, images, json_schema: jsonSchema, no_data_collection: noData }),
				// The rates this form does not show stay as they were.
				...(priced ? { price: filled({ ...model?.own_price, ...rates } as Price) } : {}),
				...(longest !== undefined ? { max_output_tokens: longest } : {}),
				...(takesReasoning && reasoning !== NOT_SET ? { reasoning } : {}),
				...(takesEmbeddings && embeddings !== NOT_SET ? { embeddings } : {}),
			});
			await onChanged();
		});
		if (done) {
			onDone();
		}
	}

	return (
		<>
			<fieldset>
				<legend>{model ? model.name : t('projects.ai.models.add')}</legend>
				<label>{t('projects.ai.models.provider')}
					<select value={provider} onChange={(e) => setProvider(e.target.value)}>
						{providers.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
					</select>
				</label>
				<label>{t('projects.ai.models.upstream')}
					<input list="project-ai-upstream" value={upstream} onChange={(e) => setUpstream(e.target.value)} />
					<datalist id="project-ai-upstream">{offered.map((m) => <option key={m.id} value={m.id}>{m.name ?? m.id}</option>)}</datalist>
				</label>
				<p className="field-hint">{t('projects.ai.models.upstreamHint')}</p>
				{!model && (
					<>
						<label>{t('projects.ai.models.callName')}<input value={name} placeholder={upstream} onChange={(e) => setName(e.target.value)} /></label>
						<p className="field-hint">{t('projects.ai.models.callNameHint')}</p>
					</>
				)}
				<label className="check"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />{t('projects.ai.models.enabled')}</label>
				<label>{t('projects.ai.models.access')}
					<select value={access} onChange={(e) => setAccess(e.target.value as Model['access'])}>
						<option value="everyone">{t('projects.ai.models.accessLevel.everyone')}</option>
						<option value="granted">{t('projects.ai.models.accessLevel.granted')}</option>
					</select>
				</label>
				{model && access !== 'granted' && model.grants > 0 && <p className="field-hint">{t('projects.ai.models.grants', { count: model.grants })}</p>}
			</fieldset>
			{model && access === 'granted' && <ModelGrants admin={admin} model={model.name} />}
			<fieldset>
				<legend>{t('projects.ai.models.priceColumn')}</legend>
				<label>{t('projects.ai.models.inputRate')}<input type="number" min={0} step="0.01" value={input} onChange={(e) => setInput(e.target.value)} /></label>
				<label>{t('projects.ai.models.outputRate')}<input type="number" min={0} step="0.01" value={output} onChange={(e) => setOutput(e.target.value)} /></label>
				<label>{t('projects.ai.models.cacheReadRate')}<input type="number" min={0} step="0.01" value={cacheRead} onChange={(e) => setCacheRead(e.target.value)} /></label>
				<label>{t('projects.ai.models.cacheWriteRate')}<input type="number" min={0} step="0.01" value={cacheWrite} onChange={(e) => setCacheWrite(e.target.value)} /></label>
				<p className="field-hint">{t('projects.ai.models.rateHint')}</p>
			</fieldset>
			<fieldset>
				<legend>{t('projects.ai.models.calling')}</legend>
				<label>{t('projects.ai.models.maxOutput')}<input type="number" min={1} step="1" value={maxOutput} onChange={(e) => setMaxOutput(e.target.value)} /></label>
				<p className="field-hint">{t('projects.ai.models.maxOutputHint')}</p>
				<label className="check"><input type="checkbox" checked={caching} onChange={(e) => setCaching(e.target.checked)} />{t('projects.ai.models.caching')}</label>
				<p className="field-hint">{t('projects.ai.models.cachingHint')}</p>
				{takesReasoning && (
					<>
						<label>{t('projects.ai.models.reasoning')}
							<select value={reasoning} onChange={(e) => setReasoning(e.target.value)}>
								{REASONING_KINDS.map((id) => <option key={id} value={id}>{t(`projects.ai.models.reasoningKind.${id}`)}</option>)}
							</select>
						</label>
						<p className="field-hint">{t('projects.ai.models.reasoningHint')}</p>
					</>
				)}
				{takesEmbeddings && (
					<>
						<label>{t('projects.ai.models.embeddings')}
							<select value={embeddings} onChange={(e) => setEmbeddings(e.target.value)}>
								{EMBEDDINGS_KINDS.map((id) => <option key={id} value={id}>{t(`projects.ai.models.embeddingsKind.${id}`)}</option>)}
							</select>
						</label>
						<p className="field-hint">{t('projects.ai.models.embeddingsHint')}</p>
					</>
				)}
				<label>{t('projects.ai.models.internet')}<InternetSelect label={t('projects.ai.models.internet')} value={internet} onChange={setInternet} /></label>
				<p className="field-hint">{t('projects.ai.models.internetHint')}</p>
			</fieldset>
			<fieldset>
				<legend>{t('projects.ai.models.quota')}</legend>
				<label>{t('projects.ai.limits.rpm')}<input type="number" min={1} step="1" value={quotaRequests} onChange={(e) => setQuotaRequests(e.target.value)} /></label>
				<label>{t('projects.ai.limits.tpm')}<input type="number" min={1} step="1" value={quotaTokens} onChange={(e) => setQuotaTokens(e.target.value)} /></label>
				<p className="field-hint">{t('projects.ai.models.quotaHint')}</p>
			</fieldset>
			<fieldset>
				<legend>{t('projects.ai.models.fits.legend')}</legend>
				<p className="field-hint">{t('projects.ai.models.fits.hint')}</p>
				<label>{t('projects.ai.models.fits.context')}<input type="number" min={1} step="1" value={context} onChange={(e) => setContext(e.target.value)} /></label>
				<label className="check"><input type="checkbox" checked={tools} onChange={(e) => setTools(e.target.checked)} />{t('projects.ai.models.fits.tools')}</label>
				<label className="check"><input type="checkbox" checked={images} onChange={(e) => setImages(e.target.checked)} />{t('projects.ai.models.fits.images')}</label>
				<label className="check"><input type="checkbox" checked={jsonSchema} onChange={(e) => setJsonSchema(e.target.checked)} />{t('projects.ai.models.fits.jsonSchema')}</label>
				<label className="check"><input type="checkbox" checked={noData} onChange={(e) => setNoData(e.target.checked)} />{t('projects.ai.models.fits.noData')}</label>
			</fieldset>
			<Status said={said} />
			<div className="cloud-actions">
				<button type="button" className="secondary" disabled={busy} onClick={onDone}>{t('projects.common.cancel')}</button>
				<button type="button" disabled={busy || !provider || !upstream.trim()} onClick={() => void save()}><Icon name="check" /> {t('projects.ai.models.save')}</button>
			</div>
		</>
	);
}

/** Who a model that is granted only is open to. Each grant applies at once, without the form's save. */
function ModelGrants({ admin, model }: { admin: PsycheAdmin; model: string }): JSX.Element {
	const t = useT();
	const { busy, said, act } = useAct();
	const [grants, setGrants] = useState<Grant[] | null>(null);
	const [groups, setGroups] = useState<Group[]>([]);
	const [kind, setKind] = useState<'user' | 'group'>('user');
	const [id, setId] = useState('');

	const load = useCallback(async () => {
		setGrants(await admin.grants(model));
		// Only the picker and the names in the list read these.
		setGroups(await admin.groups().catch(() => []));
	}, [admin, model]);

	useEffect(() => {
		void act(load);
	}, [act, load]);

	async function add(): Promise<void> {
		await act(async () => {
			await admin.grant(kind === 'user' ? { model, user_id: id.trim() } : { model, group_id: id });
			setId('');
			await load();
		});
	}

	async function revoke(grant: Grant): Promise<void> {
		await act(async () => {
			await admin.revokeGrant(grant.id);
			await load();
		});
	}

	return (
		<fieldset>
			<legend>{t('projects.ai.grants.title')}</legend>
			{grants !== null && grants.length === 0 && <p className="field-hint">{t('projects.ai.grants.empty')}</p>}
			{grants !== null && grants.length > 0 && (
				<table className="cloud-table">
					<tbody>
						{grants.map((grant) => (
							<tr key={grant.id}>
								<td>{grant.group_id ? t('projects.ai.grants.group', { name: grant.group_name ?? grant.group_id }) : <>{t('projects.ai.grants.user')} <span className="mono">{grant.user_id}</span></>}</td>
								<td className="cloud-table-action">
									<button type="button" className="table-action" title={t('projects.ai.grants.revoke')} aria-label={t('projects.ai.grants.revoke')} disabled={busy} onClick={() => void revoke(grant)}><Icon name="trash" /></button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			<label>{t('projects.ai.grants.to')}
				<select
					value={kind}
					onChange={(e) => {
						setKind(e.target.value as 'user' | 'group');
						setId('');
					}}
				>
					<option value="user">{t('projects.ai.grants.kind.user')}</option>
					<option value="group">{t('projects.ai.grants.kind.group')}</option>
				</select>
			</label>
			{kind === 'user'
				? <label>{t('projects.ai.grants.userId')}<input value={id} spellCheck={false} onChange={(e) => setId(e.target.value)} /></label>
				: (
					<label>{t('projects.ai.grants.groupPick')}
						<select value={id} onChange={(e) => setId(e.target.value)}>
							<option value="">{t('projects.ai.grants.choose')}</option>
							{groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
						</select>
					</label>
				)}
			<p className="field-hint">{t('projects.ai.grants.hint')}</p>
			<Status said={said} />
			<div className="cloud-actions">
				<button type="button" disabled={busy || id.trim() === ''} onClick={() => void add()}><Icon name="add" /> {t('projects.ai.grants.add')}</button>
			</div>
		</fieldset>
	);
}

/** Adds a name to a list: a native select that goes back to its prompt after each choice. */
function NamePicker({ label, names, onPick }: { label: string; names: string[]; onPick(name: string): void }): JSX.Element {
	const t = useT();
	return (
		<label>{label}
			<select
				value=""
				onChange={(e) => {
					if (e.target.value) {
						onPick(e.target.value);
					}
				}}
			>
				<option value="">{t('projects.ai.choose')}</option>
				{names.map((name) => <option key={name} value={name}>{name}</option>)}
			</select>
		</label>
	);
}

// ------------------------------------------------------------------------------- routes

function RoutesTab({ admin, held, onChanged }: TabProps): JSX.Element {
	const t = useT();
	const { busy, said, act } = useAct();
	const [confirm, confirmDialog] = useConfirm();
	const [editing, setEditing] = useState<Route | 'new' | null>(null);

	async function remove(route: Route): Promise<void> {
		if (await confirm({ title: t('projects.ai.routes.removeTitle', { name: route.name }), body: t('projects.ai.routes.removeBody'), confirmLabel: t('projects.ai.routes.remove'), danger: true })) {
			await act(async () => {
				await admin.deleteRoute(route.name);
				await onChanged();
			});
		}
	}

	return (
		<fieldset>
			<legend>{t('projects.ai.tab.routes')}</legend>
			{confirmDialog}
			<p className="field-hint">{t('projects.ai.routes.hint')}</p>
			{held.routes.length === 0
				? <p className="field-hint">{t('projects.ai.routes.empty')}</p>
				: (
					<table className="cloud-table">
						<thead><tr><th>{t('projects.ai.routes.name')}</th><th>{t('projects.ai.routes.targets')}</th><th>{t('projects.ai.routes.sort')}</th><th>{t('projects.ai.models.state')}</th><th /></tr></thead>
						<tbody>
							{held.routes.map((route) => (
								<tr key={route.name}>
									<td className="mono">{route.name}</td>
									<td>
										<span className="mono">{route.targets.join(', ')}</span>
										{route.tried.length > 0 && route.tried.join() !== route.targets.join() && <div className="field-hint">{t('projects.ai.routes.triesNow', { models: route.tried.join(', ') })}</div>}
										{route.skipped.length > 0 && <div className="field-hint">{t('projects.ai.routes.skips', { models: route.skipped.join(', ') })}</div>}
									</td>
									<td>{t(`projects.ai.routes.sortName.${route.sort}`)}</td>
									<td className="cloud-nowrap">{route.served ? t('projects.ai.models.served') : t('projects.ai.models.notServed')}</td>
									<td className="cloud-table-action">
										{route.origin === 'file'
											? <span title={t('projects.ai.routes.fromFile')} aria-label={t('projects.ai.routes.fromFile')}><Icon name="lock" /></span>
											: (
												<>
													<button type="button" className="table-action" title={t('projects.ai.models.edit')} aria-label={t('projects.ai.models.edit')} disabled={busy} onClick={() => setEditing(route)}><Icon name="edit" /></button>
													<button type="button" className="table-action" title={t('projects.ai.routes.remove')} aria-label={t('projects.ai.routes.remove')} disabled={busy} onClick={() => void remove(route)}><Icon name="trash" /></button>
												</>
											)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
			<Status said={said} />
			{editing === null
				? <div className="cloud-actions"><button type="button" disabled={held.models.length === 0} onClick={() => setEditing('new')}><Icon name="add" /> {t('projects.ai.routes.add')}</button></div>
				: <RouteForm key={editing === 'new' ? '' : editing.name} admin={admin} models={held.models} route={editing === 'new' ? null : editing} onDone={() => setEditing(null)} onChanged={onChanged} />}
			{held.models.length === 0 && <p className="field-hint">{t('projects.ai.routes.needModel')}</p>}
		</fieldset>
	);
}

function RouteForm({ admin, models, route, onDone, onChanged }: { admin: PsycheAdmin; models: Model[]; route: Route | null; onDone(): void; onChanged(): Promise<void> }): JSX.Element {
	const t = useT();
	const { busy, said, setSaid, act } = useAct();
	const written = route ? routeInput(route) : null;
	const required = written?.constraints ?? {};
	const [name, setName] = useState(route?.name ?? '');
	const [targets, setTargets] = useState<string[]>(written?.targets ?? []);
	const [sort, setSort] = useState<RouteSort>(written?.sort ?? 'order');
	const [weights, setWeights] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(written?.weights ?? {}).map(([target, weight]) => [target, String(weight)])));
	const [context, setContext] = useState(textOf(required.context));
	const [tools, setTools] = useState(required.tools ?? false);
	const [images, setImages] = useState(required.images ?? false);
	const [jsonSchema, setJsonSchema] = useState(required.json_schema ?? false);
	const [noData, setNoData] = useState(required.no_data_collection ?? false);
	const [regions, setRegions] = useState((required.regions ?? []).join(', '));
	const [maxPrompt, setMaxPrompt] = useState(textOf(required.max_price?.prompt));
	const [maxCompletion, setMaxCompletion] = useState(textOf(required.max_price?.completion));
	const [maxRequest, setMaxRequest] = useState(textOf(required.max_price?.request));
	const [maxImage, setMaxImage] = useState(textOf(required.max_price?.image));
	const weighted = sort === 'weighted' || sort === 'balanced';

	function move(index: number, by: number): void {
		const next = [...targets];
		[next[index], next[index + by]] = [next[index + by], next[index]];
		setTargets(next);
	}

	async function save(): Promise<void> {
		const shares: Record<string, number> = {};
		if (weighted) {
			for (const target of targets) {
				const share = numberOf(weights[target] ?? '');
				if (share !== undefined) {
					shares[target] = share;
				}
			}
		}
		const contextTokens = numberOf(context);
		const maxPrice = filled<MaxPrice>({ prompt: numberOf(maxPrompt), completion: numberOf(maxCompletion), request: numberOf(maxRequest), image: numberOf(maxImage) });
		if (!allNumbers([contextTokens, ...Object.values(shares), ...Object.values(maxPrice)])) {
			setSaid({ ok: false, message: t('projects.ai.numberInvalid') });
			return;
		}
		const regionList = regions.split(',').map((region) => region.trim()).filter(Boolean);
		const constraints = filled<RouteConstraints>({
			context: contextTokens,
			tools,
			images,
			json_schema: jsonSchema,
			no_data_collection: noData,
			regions: regionList.length > 0 ? regionList : undefined,
			max_price: Object.keys(maxPrice).length > 0 ? maxPrice : undefined,
		});
		const done = await act(async () => {
			await admin.putRoute(route?.name ?? name.trim(), { targets, sort, weights: shares, constraints });
			await onChanged();
		});
		if (done) {
			onDone();
		}
	}

	return (
		<>
			<fieldset>
				<legend>{route ? route.name : t('projects.ai.routes.add')}</legend>
				{!route && (
					<>
						<label>{t('projects.ai.routes.name')}<input value={name} onChange={(e) => setName(e.target.value)} /></label>
						<p className="field-hint">{t('projects.ai.routes.nameHint')}</p>
					</>
				)}
				<NamePicker label={t('projects.ai.routes.targets')} names={models.map((m) => m.name).filter((n) => !targets.includes(n))} onPick={(picked) => setTargets([...targets, picked])} />
				{targets.length > 0 && (
					<table className="cloud-table">
						<thead><tr><th>{t('projects.ai.routes.model')}</th>{weighted && <th>{t('projects.ai.routes.weight')}</th>}<th /></tr></thead>
						<tbody>
							{targets.map((target, index) => (
								<tr key={target}>
									<td className="mono">{target}</td>
									{weighted && <td><input type="number" min={1} max={1000} step="1" aria-label={t('projects.ai.routes.weightFor', { name: target })} value={weights[target] ?? ''} onChange={(e) => setWeights({ ...weights, [target]: e.target.value })} /></td>}
									<td className="cloud-table-action">
										<button type="button" className="table-action" title={t('projects.ai.routes.moveUp')} aria-label={t('projects.ai.routes.moveUp')} disabled={index === 0} onClick={() => move(index, -1)}><Icon name="arrow-up" /></button>
										<button type="button" className="table-action" title={t('projects.ai.routes.moveDown')} aria-label={t('projects.ai.routes.moveDown')} disabled={index === targets.length - 1} onClick={() => move(index, 1)}><Icon name="arrow-down" /></button>
										<button type="button" className="table-action" title={t('projects.ai.routes.remove')} aria-label={t('projects.ai.routes.remove')} onClick={() => setTargets(targets.filter((other) => other !== target))}><Icon name="close" /></button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				{weighted && <p className="field-hint">{t('projects.ai.routes.weightHint')}</p>}
				<label>{t('projects.ai.routes.sort')}
					<select value={sort} onChange={(e) => setSort(e.target.value as RouteSort)}>
						{ROUTE_SORTS.map((id) => <option key={id} value={id}>{t(`projects.ai.routes.sortName.${id}`)}</option>)}
					</select>
				</label>
				<p className="field-hint">{t(`projects.ai.routes.sortHint.${sort}`)}</p>
			</fieldset>
			<fieldset>
				<legend>{t('projects.ai.routes.constraints')}</legend>
				<p className="field-hint">{t('projects.ai.routes.constraintsHint')}</p>
				<label>{t('projects.ai.routes.context')}<input type="number" min={1} step="1" value={context} onChange={(e) => setContext(e.target.value)} /></label>
				<label className="check"><input type="checkbox" checked={tools} onChange={(e) => setTools(e.target.checked)} />{t('projects.ai.models.fits.tools')}</label>
				<label className="check"><input type="checkbox" checked={images} onChange={(e) => setImages(e.target.checked)} />{t('projects.ai.models.fits.images')}</label>
				<label className="check"><input type="checkbox" checked={jsonSchema} onChange={(e) => setJsonSchema(e.target.checked)} />{t('projects.ai.models.fits.jsonSchema')}</label>
				<label className="check"><input type="checkbox" checked={noData} onChange={(e) => setNoData(e.target.checked)} />{t('projects.ai.models.fits.noData')}</label>
				<label>{t('projects.ai.routes.regions')}<input value={regions} placeholder="us-east-1, eu-west-1" onChange={(e) => setRegions(e.target.value)} /></label>
				<p className="field-hint">{t('projects.ai.routes.regionsHint')}</p>
				<label>{t('projects.ai.routes.maxPrompt')}<input type="number" min={0} step="0.01" value={maxPrompt} onChange={(e) => setMaxPrompt(e.target.value)} /></label>
				<label>{t('projects.ai.routes.maxCompletion')}<input type="number" min={0} step="0.01" value={maxCompletion} onChange={(e) => setMaxCompletion(e.target.value)} /></label>
				<label>{t('projects.ai.routes.maxRequest')}<input type="number" min={0} step="0.01" value={maxRequest} onChange={(e) => setMaxRequest(e.target.value)} /></label>
				<label>{t('projects.ai.routes.maxImage')}<input type="number" min={0} step="0.01" value={maxImage} onChange={(e) => setMaxImage(e.target.value)} /></label>
			</fieldset>
			<Status said={said} />
			<div className="cloud-actions">
				<button type="button" className="secondary" disabled={busy} onClick={onDone}>{t('projects.common.cancel')}</button>
				<button type="button" disabled={busy || !name.trim()} onClick={() => void save()}><Icon name="check" /> {t('projects.ai.routes.save')}</button>
			</div>
		</>
	);
}

// ---------------------------------------------------------------------------- providers

const SOURCES: { id: string; label: string; kind: ProviderKind; baseUrl?: string }[] = [
	{ id: 'openai', label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1' },
	{ id: 'anthropic', label: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1' },
	{ id: 'openrouter', label: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1' },
	{ id: 'bedrock', label: 'Amazon Bedrock', kind: 'bedrock' },
	{ id: 'compatible', label: 'OpenAI-compatible', kind: 'openai' },
];

function ProvidersTab({ admin, held, onChanged }: TabProps): JSX.Element {
	const t = useT();
	const { busy, said, act } = useAct();
	const [confirm, confirmDialog] = useConfirm();
	const [adding, setAdding] = useState(false);
	const [replacing, setReplacing] = useState<Provider | null>(null);

	async function remove(provider: Provider): Promise<void> {
		if (await confirm({ title: t('projects.ai.providers.removeTitle', { name: provider.name }), body: t('projects.ai.providers.removeBody'), confirmLabel: t('projects.ai.providers.remove'), danger: true })) {
			await act(async () => {
				await admin.deleteProvider(provider.name);
				await onChanged();
			});
		}
	}

	return (
		<fieldset>
			<legend>{t('projects.ai.tab.providers')}</legend>
			{confirmDialog}
			<p className="field-hint">{t('projects.ai.providers.hint')}</p>
			{held.providers.length > 0 && (
				<table className="cloud-table">
					<thead><tr><th>{t('projects.ai.providers.name')}</th><th>{t('projects.ai.providers.kind')}</th><th>{t('projects.ai.providers.address')}</th><th>{t('projects.ai.providers.credential')}</th><th /></tr></thead>
					<tbody>
						{held.providers.map((p) => (
							<tr key={p.name}>
								<td className="mono">{p.name}</td>
								<td>{p.kind}</td>
								<td className="mono">{p.region ?? p.base_url}</td>
								<td title={p.problem ?? undefined}>{p.credential_stored ? t('projects.ai.providers.stored') : p.key === 'environment' ? t('projects.ai.providers.environment') : t('projects.ai.providers.missing')}</td>
								<td className="cloud-table-action">
									{p.origin === 'api' && p.credential && <button type="button" className="table-action" title={t('projects.ai.providers.replace')} aria-label={t('projects.ai.providers.replace')} disabled={busy} onClick={() => setReplacing(p)}><Icon name="key" /></button>}
									{p.origin === 'api' && <button type="button" className="table-action" title={t('projects.ai.providers.remove')} aria-label={t('projects.ai.providers.remove')} disabled={busy} onClick={() => void remove(p)}><Icon name="trash" /></button>}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			<Status said={said} />
			{replacing && <ReplaceKeyForm admin={admin} provider={replacing} onDone={() => setReplacing(null)} onChanged={onChanged} />}
			{adding
				? <ProviderForm admin={admin} held={held} onDone={() => setAdding(false)} onChanged={onChanged} />
				: <div className="cloud-actions"><button type="button" onClick={() => setAdding(true)}><Icon name="add" /> {t('projects.ai.providers.add')}</button></div>}
		</fieldset>
	);
}

function ReplaceKeyForm({ admin, provider, onDone, onChanged }: { admin: PsycheAdmin; provider: Provider; onDone(): void; onChanged(): Promise<void> }): JSX.Element {
	const t = useT();
	const { busy, said, act } = useAct();
	const [key, setKey] = useState('');
	const [secret, setSecret] = useState('');
	const bedrock = provider.kind === 'bedrock';

	async function save(): Promise<void> {
		const done = await act(async () => {
			await admin.putCredential(provider.credential ?? provider.name, bedrock ? { access_key_id: key.trim(), secret_access_key: secret.trim() } : { api_key: key.trim() });
			await onChanged();
		});
		if (done) {
			onDone();
		}
	}

	return (
		<div className="local-inline-form">
			<label>{bedrock ? t('projects.ai.providers.accessKey') : t('projects.ai.providers.key')}<input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} /></label>
			{bedrock && <label>{t('projects.ai.providers.secretKey')}<input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} /></label>}
			<p className="field-hint">{t('projects.ai.providers.keyHint')}</p>
			<Status said={said} />
			<div className="cloud-actions">
				<button type="button" className="secondary" disabled={busy} onClick={onDone}>{t('projects.common.cancel')}</button>
				<button type="button" disabled={busy || !key.trim() || (bedrock && !secret.trim())} onClick={() => void save()}><Icon name="check" /> {t('projects.ai.providers.saveKey')}</button>
			</div>
		</div>
	);
}

function ProviderForm({ admin, held, onDone, onChanged }: { admin: PsycheAdmin; held: Held; onDone(): void; onChanged(): Promise<void> }): JSX.Element {
	const t = useT();
	const { busy, said, setSaid, act } = useAct();
	const [sourceId, setSourceId] = useState(SOURCES[0].id);
	const source = SOURCES.find((s) => s.id === sourceId) ?? SOURCES[0];
	const [name, setName] = useState(SOURCES[0].id);
	const [baseUrl, setBaseUrl] = useState(SOURCES[0].baseUrl ?? '');
	const [region, setRegion] = useState('');
	const [key, setKey] = useState('');
	const [secret, setSecret] = useState('');
	const [authHeader, setAuthHeader] = useState('');
	const [model, setModel] = useState('');
	const bedrock = source.kind === 'bedrock';

	function choose(id: string): void {
		const next = SOURCES.find((s) => s.id === id) ?? SOURCES[0];
		setSourceId(next.id);
		setName(next.id);
		setBaseUrl(next.baseUrl ?? '');
	}

	async function save(): Promise<void> {
		const providerName = name.trim();
		const upstream = model.trim();
		if (held.providers.some((p) => p.name === providerName)) {
			setSaid({ ok: false, message: t('projects.ai.providers.nameTaken') });
			return;
		}
		const done = await act(async () => {
			// The gateway proves a key against a provider with a model, so the three go together.
			await admin.putProvider(providerName, { kind: source.kind, credential: providerName, ...(bedrock ? { region: region.trim() } : { base_url: baseUrl.trim(), ...(authHeader.trim() ? { auth_header: authHeader.trim() } : {}) }) });
			try {
				await admin.putModel(upstream, { provider: providerName, upstream });
				await admin.putCredential(providerName, bedrock ? { access_key_id: key.trim(), secret_access_key: secret.trim() } : { api_key: key.trim() });
			} catch (error) {
				await admin.deleteModel(upstream).catch(() => undefined);
				await admin.deleteProvider(providerName).catch(() => undefined);
				throw error;
			}
			await onChanged();
		});
		if (done) {
			onDone();
		}
	}

	const ready = name.trim() && model.trim() && key.trim() && (bedrock ? region.trim() && secret.trim() : baseUrl.trim());
	return (
		<div className="local-inline-form">
			<label>{t('projects.ai.providers.source')}
				<select value={sourceId} onChange={(e) => choose(e.target.value)}>
					{SOURCES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
				</select>
			</label>
			<label>{t('projects.ai.providers.name')}<input value={name} onChange={(e) => setName(e.target.value)} /></label>
			{bedrock
				? <label>{t('projects.ai.providers.region')}<input value={region} placeholder="us-east-1" onChange={(e) => setRegion(e.target.value)} /></label>
				: <label>{t('projects.ai.providers.address')}<input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} /></label>}
			<label>{bedrock ? t('projects.ai.providers.accessKey') : t('projects.ai.providers.key')}<input type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} /></label>
			{bedrock && <label>{t('projects.ai.providers.secretKey')}<input type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} /></label>}
			<p className="field-hint">{t('projects.ai.providers.keyHint')}</p>
			{!bedrock && (
				<>
					<label>{t('projects.ai.providers.authHeader')}<input value={authHeader} placeholder="x-api-key" onChange={(e) => setAuthHeader(e.target.value)} /></label>
					<p className="field-hint">{t('projects.ai.providers.authHeaderHint')}</p>
				</>
			)}
			<label>{t('projects.ai.providers.firstModel')}<input value={model} onChange={(e) => setModel(e.target.value)} /></label>
			<p className="field-hint">{t('projects.ai.providers.firstModelHint')}</p>
			<Status said={said} />
			<div className="cloud-actions">
				<button type="button" className="secondary" disabled={busy} onClick={onDone}>{t('projects.common.cancel')}</button>
				<button type="button" disabled={busy || !ready} onClick={() => void save()}><Icon name="check" /> {t('projects.ai.providers.connect')}</button>
			</div>
		</div>
	);
}

// --------------------------------------------------------------------------------- keys

function when(seconds: number | null): string | null {
	return seconds ? new Date(seconds * 1000).toLocaleDateString(formatLocale()) : null;
}

function KeysTab({ admin, held, onChanged }: TabProps): JSX.Element {
	const t = useT();
	const { busy, said, setSaid, act } = useAct();
	const [confirm, confirmDialog] = useConfirm();
	const [name, setName] = useState('');
	const [models, setModels] = useState<string[]>([]);
	const [days, setDays] = useState('');
	const [made, setMade] = useState<NewPsycheKey | null>(null);
	const live = held.keys.filter((k) => !k.revoked_at);
	const callable = [...held.models.map((m) => m.name), ...held.routes.map((r) => r.name)].filter((n) => !models.includes(n));

	async function make(): Promise<void> {
		const expires = numberOf(days);
		if (!allNumbers([expires])) {
			setSaid({ ok: false, message: t('projects.ai.numberInvalid') });
			return;
		}
		await act(async () => {
			setMade(await admin.createKey({
				name: name.trim(),
				...(models.length > 0 ? { models } : {}),
				...(expires !== undefined ? { expires_in: Math.round(expires * SECONDS_A_DAY) } : {}),
			}));
			setName('');
			setModels([]);
			setDays('');
			await onChanged();
		});
	}

	async function revoke(key: PsycheKey): Promise<void> {
		if (await confirm({ title: t('projects.ai.keys.revokeTitle', { name: key.name }), body: t('projects.ai.keys.revokeBody'), confirmLabel: t('projects.ai.keys.revoke'), danger: true })) {
			await act(async () => {
				await admin.revokeKey(key.id);
				await onChanged();
			});
		}
	}

	return (
		<fieldset>
			<legend>{t('projects.ai.tab.keys')}</legend>
			{confirmDialog}
			<p className="field-hint">{t('projects.ai.keys.hint')}</p>
			{made && (
				<div className="form-status warn">
					<div>{t('projects.ai.keys.onlyTime', { name: made.name })}</div>
					<div className="cloud-actions">
						<span className="mono">{made.key}</span>
						<button type="button" className="secondary" onClick={() => void navigator.clipboard.writeText(made.key)}><Icon name="copy" /> {t('projects.common.copy')}</button>
						<button type="button" className="secondary" onClick={() => setMade(null)}>{t('projects.ai.keys.done')}</button>
					</div>
				</div>
			)}
			{live.length > 0 && (
				<table className="cloud-table">
					<thead><tr><th>{t('projects.ai.keys.name')}</th><th>{t('projects.ai.keys.key')}</th><th>{t('projects.ai.keys.created')}</th><th>{t('projects.ai.keys.lastUsed')}</th><th /></tr></thead>
					<tbody>
						{live.map((key) => (
							<tr key={key.id}>
								<td>{key.name}</td>
								<td className="mono">{key.hint}</td>
								<td>{when(key.created_at)}</td>
								<td>{when(key.last_used_at) ?? key.last_used_on ?? t('projects.ai.keys.never')}</td>
								<td className="cloud-table-action">
									<button type="button" className="table-action" title={t('projects.ai.keys.revoke')} aria-label={t('projects.ai.keys.revoke')} disabled={busy} onClick={() => void revoke(key)}><Icon name="trash" /></button>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			<label>{t('projects.ai.keys.purpose')}<input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} /></label>
			<NamePicker label={t('projects.ai.keys.models')} names={callable} onPick={(picked) => setModels([...models, picked])} />
			{models.length > 0 && (
				<div className="local-chips">
					{models.map((picked) => (
						<button key={picked} type="button" className="local-chip" title={t('projects.ai.keys.removeModel', { name: picked })} aria-label={t('projects.ai.keys.removeModel', { name: picked })} onClick={() => setModels(models.filter((m) => m !== picked))}><span className="mono">{picked}</span> <Icon name="close" /></button>
					))}
				</div>
			)}
			<p className="field-hint">{t('projects.ai.keys.modelsHint')}</p>
			<label>{t('projects.ai.keys.expires')}<input type="number" min={1} step="1" value={days} onChange={(e) => setDays(e.target.value)} /></label>
			<p className="field-hint">{t('projects.ai.keys.expiresHint')}</p>
			<Status said={said} />
			<div className="cloud-actions"><button type="button" disabled={busy || !name.trim()} onClick={() => void make()}><Icon name="key" /> {t('projects.ai.keys.make')}</button></div>
		</fieldset>
	);
}

// ---------------------------------------------------------------------- budgets and limits

/** Whom a budget or limit is for, as a select's value: `project`, `every`, or a key's id. */
function whomOf(value: string): Whom {
	if (value === 'project') {
		return {};
	}
	return value === 'every' ? { every_user: true } : { key_id: value };
}

function whomText(item: Required<Whom>, keys: PsycheKey[], t: ReturnType<typeof useT>): string {
	if (item.every_user) {
		return t('projects.ai.budgets.everyUser');
	}
	if (item.key_id) {
		return t('projects.ai.budgets.forKey', { name: keys.find((k) => k.id === item.key_id)?.name ?? item.key_id });
	}
	if (item.user_id || item.group_id) {
		return item.user_id ?? item.group_id ?? '';
	}
	return t('projects.ai.budgets.project');
}

function WhomSelect({ value, keys, onChange }: { value: string; keys: PsycheKey[]; onChange(value: string): void }): JSX.Element {
	const t = useT();
	return (
		<label>{t('projects.ai.budgets.whom')}
			<select value={value} onChange={(e) => onChange(e.target.value)}>
				<option value="project">{t('projects.ai.budgets.project')}</option>
				<option value="every">{t('projects.ai.budgets.everyUser')}</option>
				{keys.filter((k) => !k.revoked_at).map((k) => <option key={k.id} value={k.id}>{t('projects.ai.budgets.forKey', { name: k.name })}</option>)}
			</select>
		</label>
	);
}

function BudgetsTab({ admin, held, onChanged }: TabProps): JSX.Element {
	const t = useT();
	const { busy, said, setSaid, act } = useAct();
	const [confirm, confirmDialog] = useConfirm();
	const [name, setName] = useState('');
	const [amount, setAmount] = useState('');
	const [period, setPeriod] = useState<Period>('month');
	const [hard, setHard] = useState(true);
	const [whom, setWhom] = useState('project');
	const [limitName, setLimitName] = useState('');
	const [rpm, setRpm] = useState('');
	const [tpm, setTpm] = useState('');
	const [limitWhom, setLimitWhom] = useState('project');

	async function addBudget(): Promise<void> {
		const value = Number(amount);
		if (amount.trim() === '' || !Number.isFinite(value) || value < 0) {
			setSaid({ ok: false, message: t('projects.ai.budgets.invalid') });
			return;
		}
		await act(async () => {
			await admin.createBudget({ name: name.trim(), amount: value, period, hard, ...whomOf(whom) });
			setName('');
			setAmount('');
			await onChanged();
		});
	}

	async function addLimit(): Promise<void> {
		await act(async () => {
			await admin.createLimit({
				name: limitName.trim(),
				...(rpm.trim() ? { requests_per_minute: Number(rpm) } : {}),
				...(tpm.trim() ? { tokens_per_minute: Number(tpm) } : {}),
				...whomOf(limitWhom),
			});
			setLimitName('');
			setRpm('');
			setTpm('');
			await onChanged();
		});
	}

	async function removeBudget(budget: Budget): Promise<void> {
		if (await confirm({ title: t('projects.ai.budgets.removeTitle', { name: budget.name }), body: t('projects.ai.budgets.removeBody'), confirmLabel: t('projects.common.delete'), danger: true })) {
			await act(async () => {
				await admin.deleteBudget(budget.id);
				await onChanged();
			});
		}
	}

	async function removeLimit(limit: Limit): Promise<void> {
		if (await confirm({ title: t('projects.ai.budgets.removeTitle', { name: limit.name }), body: t('projects.ai.budgets.removeLimitBody'), confirmLabel: t('projects.common.delete'), danger: true })) {
			await act(async () => {
				await admin.deleteLimit(limit.id);
				await onChanged();
			});
		}
	}

	return (
		<>
			{confirmDialog}
			<fieldset>
				<legend>{t('projects.ai.budgets.legend')}</legend>
				<p className="field-hint">{t('projects.ai.budgets.hint')}</p>
				{held.budgets.length > 0 && (
					<table className="cloud-table">
						<thead><tr><th>{t('projects.ai.budgets.name')}</th><th>{t('projects.ai.budgets.whom')}</th><th>{t('projects.ai.budgets.amount')}</th><th>{t('projects.ai.budgets.period')}</th><th>{t('projects.ai.budgets.hard')}</th><th /></tr></thead>
						<tbody>
							{held.budgets.map((b) => (
								<tr key={b.id}>
									<td>{b.name}</td>
									<td>{whomText(b, held.keys, t)}</td>
									<td>{`$${dollars(b.amount) ?? b.amount}`}</td>
									<td>{t(`projects.ai.budgets.per.${b.period}`)}</td>
									<td>{b.hard ? t('projects.ai.budgets.stops') : t('projects.ai.budgets.warns')}</td>
									<td className="cloud-table-action"><button type="button" className="table-action" title={t('projects.common.delete')} aria-label={t('projects.common.delete')} disabled={busy} onClick={() => void removeBudget(b)}><Icon name="trash" /></button></td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				<label>{t('projects.ai.budgets.name')}<input value={name} onChange={(e) => setName(e.target.value)} /></label>
				<WhomSelect value={whom} keys={held.keys} onChange={setWhom} />
				<label>{t('projects.ai.budgets.amountDollars')}<input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
				<label>{t('projects.ai.budgets.period')}
					<select value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
						<option value="day">{t('projects.ai.budgets.per.day')}</option>
						<option value="month">{t('projects.ai.budgets.per.month')}</option>
					</select>
				</label>
				<label className="check"><input type="checkbox" checked={hard} onChange={(e) => setHard(e.target.checked)} />{t('projects.ai.budgets.hardLabel')}</label>
				<div className="cloud-actions"><button type="button" disabled={busy || !name.trim() || !amount.trim()} onClick={() => void addBudget()}><Icon name="add" /> {t('projects.ai.budgets.add')}</button></div>
			</fieldset>
			<fieldset>
				<legend>{t('projects.ai.limits.legend')}</legend>
				<p className="field-hint">{t('projects.ai.limits.hint')}</p>
				{held.limits.length > 0 && (
					<table className="cloud-table">
						<thead><tr><th>{t('projects.ai.budgets.name')}</th><th>{t('projects.ai.budgets.whom')}</th><th>{t('projects.ai.limits.rpm')}</th><th>{t('projects.ai.limits.tpm')}</th><th /></tr></thead>
						<tbody>
							{held.limits.map((l) => (
								<tr key={l.id}>
									<td>{l.name}</td>
									<td>{whomText(l, held.keys, t)}</td>
									<td>{l.requests_per_minute ?? t('projects.ai.limits.none')}</td>
									<td>{l.tokens_per_minute ?? t('projects.ai.limits.none')}</td>
									<td className="cloud-table-action"><button type="button" className="table-action" title={t('projects.common.delete')} aria-label={t('projects.common.delete')} disabled={busy} onClick={() => void removeLimit(l)}><Icon name="trash" /></button></td>
								</tr>
							))}
						</tbody>
					</table>
				)}
				<label>{t('projects.ai.budgets.name')}<input value={limitName} onChange={(e) => setLimitName(e.target.value)} /></label>
				<WhomSelect value={limitWhom} keys={held.keys} onChange={setLimitWhom} />
				<label>{t('projects.ai.limits.rpm')}<input type="number" min={1} step="1" value={rpm} onChange={(e) => setRpm(e.target.value)} /></label>
				<label>{t('projects.ai.limits.tpm')}<input type="number" min={1} step="1" value={tpm} onChange={(e) => setTpm(e.target.value)} /></label>
				<div className="cloud-actions"><button type="button" disabled={busy || !limitName.trim() || (!rpm.trim() && !tpm.trim())} onClick={() => void addLimit()}><Icon name="add" /> {t('projects.ai.limits.add')}</button></div>
				<Status said={said} />
			</fieldset>
		</>
	);
}

// -------------------------------------------------------------------------------- usage

function UsageTab({ admin }: { admin: PsycheAdmin }): JSX.Element {
	const t = useT();
	const [by, setBy] = useState<UsageBy>('model');
	const usage = useLoad(() => admin.usage({ by }), [admin, by]);
	const n = (value: number): string => value.toLocaleString(formatLocale());
	const rows = usage.data?.data ?? [];
	return (
		<fieldset>
			<legend>{t('projects.ai.usage.legend')}</legend>
			<label>{t('projects.ai.usage.by')}
				<select value={by} onChange={(e) => setBy(e.target.value as UsageBy)}>
					<option value="model">{t('projects.ai.usage.byModel')}</option>
					<option value="day">{t('projects.ai.usage.byDay')}</option>
					<option value="key">{t('projects.ai.usage.byKey')}</option>
					<option value="provider">{t('projects.ai.usage.byProvider')}</option>
				</select>
			</label>
			{usage.error && <div className="form-status error">{usage.error}</div>}
			{usage.loading && <div className="field-hint">{t('projects.common.loading')}</div>}
			{!usage.loading && !usage.error && rows.length === 0 && <p className="field-hint">{t('projects.ai.usage.empty')}</p>}
			{rows.length > 0 && (
				<table className="cloud-table">
					<thead><tr><th>{t(`projects.ai.usage.column.${by}`)}</th><th>{t('projects.ai.usage.calls')}</th><th>{t('projects.ai.usage.failed')}</th><th>{t('projects.ai.usage.tokensIn')}</th><th>{t('projects.ai.usage.tokensOut')}</th><th>{t('projects.ai.usage.cost')}</th></tr></thead>
					<tbody>
						{rows.map((row) => (
							<tr key={String(row[by])}>
								<td className="mono">{row[by] === null ? t('projects.ai.usage.none') : String(row[by])}</td>
								<td>{n(row.requests)}</td>
								<td>{n(row.failed)}</td>
								<td>{n(row.prompt_tokens)}</td>
								<td>{n(row.completion_tokens)}</td>
								<td>{row.cost === null ? t('projects.ai.usage.notPriced') : `$${(dollars(row.cost) ?? 0).toFixed(4)}`}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</fieldset>
	);
}
