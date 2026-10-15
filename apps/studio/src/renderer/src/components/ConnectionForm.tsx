/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { ConnectionConfig, SshTunnelProfile } from '../../../shared/connection';
import { telemetryServiceFor } from '../../../shared/cloud';
import type { CloudAccountView } from '../../../shared/cloud';
import { DEFAULT_POOL_MAX, MAX_POOL_MAX, MIN_POOL_MAX } from '../../../shared/connection';
import { destinationChanges, sslSettingOf, tunnelEndpoint, type ConnectionDestination } from '../../../shared/connectionDestination';
import { backendKindForDriver, DATA_ACCESS_INFO, DATA_ACCESS_LEVELS, dialectFor, flavorFor, listDialects, listFlavors, readOnlyEnforcementFor, type DataAccessLevel } from '../../../shared/engine';
import type { ConnectionFormValues, ImportItem, ImportSourceId, SslMode } from '../../../shared/forms';
import { Icon } from './Icon';
import { IconSelect, type IconSelectOption } from './IconSelect';
import { driverKind, DRIVER_KINDS } from '../driverKind';
import { useConfirm } from './ConfirmDialog';
import { TunnelProfilesModal } from './TunnelProfilesModal';
import { errorMessage } from '../errors';
import { libyCall, registerLibyHelper } from '@snout/liby';
import { asLibyHelp, formHelp, foundAdvice, formAdvice, returnAdvice, testAdvice } from '@snout/liby/studio';
import type { FormFacts, FoundDb } from '../libyFacts';
import { lastErrorFor } from '../notifications';
import { maskUriPasswords } from '../../../shared/connectionUri';

const DEFAULT_PORT: Record<string, number> = Object.fromEntries(listDialects().map((d) => [d.driverId, d.defaultPort]));

/** A flavored engine is one picker row whose value carries both halves, `postgres:cockroachdb`. */
const FLAVOR_SEPARATOR = ':';

function pickerValue(driver: string, flavor: string): string {
	return flavor ? `${driver}${FLAVOR_SEPARATOR}${flavor}` : driver;
}

/** The port a new connection defaults to: the flavor's own, else the driver's. */
function defaultPortFor(driver: string, flavor: string): number | undefined {
	return flavorFor(driver, flavor)?.defaultPort ?? DEFAULT_PORT[driver];
}

type FormTab = 'general' | 'aws' | 'ssh';
/** How the connection reaches its tunnel: none, a shared saved profile, or inline. */
type TunnelMode = 'none' | 'profile' | 'inline';

/** Derive the tunnel mode + selected profile id from a saved connection (or a draft). */
function initialTunnel(existing: ConnectionConfig | undefined, draft: Partial<ConnectionFormValues> | undefined): { mode: TunnelMode; ref: string } {
	const refId = existing?.sshTunnelRef ?? draft?.sshTunnelRef;
	if (refId) {
		return { mode: 'profile', ref: refId };
	}
	if (existing?.sshTunnel || draft?.ssh) {
		return { mode: 'inline', ref: '' };
	}
	return { mode: 'none', ref: '' };
}

interface ConnectionFormProps {
	/** Present in edit mode (non-secret fields only; secrets are never sent back). */
	existing?: ConnectionConfig;
	/** Create mode: prefill the (non-secret) fields, e.g. from the AI assistant's
	 *  open_connection_form capability. The user still reviews and saves. */
	initialDraft?: Partial<ConnectionFormValues>;
	onClose(): void;
	onSaved(): void;
	/** Close this and open the import picker instead. Offered in CREATE mode only, and
	 *  only for a signed-in account: the moment somebody is about to type a host by hand
	 *  is the moment to mention that their own hosted databases need none of it. */
	onImport?(): void;
}

/**
 * Visual connection editor (replaces hand-editing connections.json). Non-secret
 * fields go to the JSON config; secrets go to the keychain via the main process. On
 * edit, a blank password/passphrase leaves the stored secret untouched. AWS Secrets
 * Manager and the SSH tunnel each live on their own tab to keep the form compact.
 */
export function ConnectionForm({ existing, initialDraft, onClose, onSaved, onImport }: ConnectionFormProps): JSX.Element {
	const isEdit = existing !== undefined;
	const ssh0 = existing?.sshTunnel;
	// In create mode, an AI-proposed (or otherwise prefilled) draft seeds the non-secret fields.
	const d = isEdit ? undefined : initialDraft;
	const ssl0 = sslSettingOf(existing?.ssl ?? (d?.ssl ? true : undefined));

	const [tab, setTab] = useState<FormTab>('general');
	const [label, setLabel] = useState(existing?.label ?? d?.label ?? '');
	const [driver, setDriver] = useState(existing?.driver ?? d?.driver ?? 'mysql-aurora');
	const [flavor, setFlavor] = useState(existing?.flavor ?? d?.flavor ?? '');
	const [environment, setEnvironment] = useState(existing?.environment ?? d?.environment ?? '');
	const [host, setHost] = useState(existing?.host ?? d?.host ?? '');
	const [port, setPort] = useState(existing?.port ? String(existing.port) : d?.port ? String(d.port) : '');
	// MongoDB can be addressed by discrete host/port fields or a single mongodb:// connection string.
	// Derive the initial mode from whether the saved host already looks like a URI.
	const [mongoUriMode, setMongoUriMode] = useState(() => /^mongodb(\+srv)?:\/\//i.test(existing?.host ?? d?.host ?? ''));
	const [database, setDatabase] = useState(existing?.database ?? d?.database ?? '');
	const [username, setUsername] = useState(existing?.username ?? d?.username ?? '');
	const [password, setPassword] = useState('');
	const [ssl, setSsl] = useState(ssl0.on);
	const [sslMode, setSslMode] = useState<SslMode>(ssl0.mode);
	const [sslCaPath, setSslCaPath] = useState(ssl0.caPath);
	const [readOnly, setReadOnly] = useState(Boolean(existing?.readOnly ?? d?.readOnly));
	// '' = use the Settings → AI default for this database.
	const [aiDataAccess, setAiDataAccess] = useState<DataAccessLevel | ''>(existing?.aiDataAccess ?? d?.aiDataAccess ?? '');
	const [poolMax, setPoolMax] = useState(existing?.poolMax ? String(existing.poolMax) : '');
	const [warehouse, setWarehouse] = useState(existing?.warehouse ?? d?.warehouse ?? '');
	const [cloudAccountId, setCloudAccountId] = useState(existing?.cloudAccountId ?? d?.cloudAccountId ?? '');
	// Named scopes, one per line, for a credential that cannot enumerate them. Empty means "all".
	const [cloudScopes, setCloudScopes] = useState((existing?.cloudScopes ?? d?.cloudScopes ?? []).join('\n'));
	const [cloudScope, setCloudScope] = useState(existing?.cloudScope ?? d?.cloudScope ?? '');
	const [cloudAccounts, setCloudAccounts] = useState<CloudAccountView[]>([]);
	const [role, setRole] = useState(existing?.role ?? d?.role ?? '');
	const aws0 = existing?.awsSecret;
	const [awsEnabled, setAwsEnabled] = useState(Boolean(aws0));
	const [awsRegion, setAwsRegion] = useState(aws0?.region ?? '');
	const [awsSecretId, setAwsSecretId] = useState(aws0?.secretId ?? '');
	const [awsProfile, setAwsProfile] = useState(aws0?.profile ?? '');
	const [awsAccessKeyId, setAwsAccessKeyId] = useState(aws0?.accessKeyId ?? '');
	const [awsSecretAccessKey, setAwsSecretAccessKey] = useState('');
	const tunnel0 = initialTunnel(existing, d);
	const [tunnelMode, setTunnelMode] = useState<TunnelMode>(tunnel0.mode);
	const [tunnelRef, setTunnelRef] = useState(tunnel0.ref);
	const [profiles, setProfiles] = useState<SshTunnelProfile[]>([]);
	const [manageTunnels, setManageTunnels] = useState(false);
	const [sshHost, setSshHost] = useState(ssh0?.host ?? '');
	const [sshPort, setSshPort] = useState(ssh0?.port ? String(ssh0.port) : '');
	const [sshUsername, setSshUsername] = useState(ssh0?.username ?? '');
	const [sshKey, setSshKey] = useState(ssh0?.privateKeyPath ?? '');
	const [sshPassphrase, setSshPassphrase] = useState('');
	const [sshPassword, setSshPassword] = useState('');
	const [sshLocalPort, setSshLocalPort] = useState(ssh0?.localPort ? String(ssh0.localPort) : '');
	// Default on (older saved tunnels have no flag → treat as enabled).
	const [sshKeepAlive, setSshKeepAlive] = useState(ssh0?.keepAlive ?? true);
	// Forget the remembered SSH host key on the next Test or Save (the server was rebuilt).
	const [forgetHostKey, setForgetHostKey] = useState(false);
	const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
	const [busy, setBusy] = useState(false);
	// SQLite and DuckDB are embedded, file-based engines: no host/port/credentials, no SSH/AWS —
	// just a path to the database file (carried in `database`). The form collapses to a file picker.
	const isFileBased = driver === 'sqlite' || driver === 'duckdb';
	// Pinecone is a vector backend reached over its REST API: no host/port/SSH/AWS — just an API key
	// (carried in `password`). Index hosts are discovered from the control plane, not configured.
	const isVector = driver === 'pinecone';
	// Snowflake is a cloud warehouse reached over HTTPS by account identifier (carried in `host`):
	// no port, no SSH tunnel, no AWS — but it needs username/password + warehouse/role fields.
	const isAccountBased = driver === 'snowflake';
	// A cloud LOG service (CloudWatch / Azure Monitor / Cloud Logging): no host, port, credentials,
	// SSH or TLS of its own. It authenticates as a saved CLOUD ACCOUNT — the same vendor credential
	// a Data Flow uses, referenced by id, never copied — and is scoped to one container of it: a
	// region, a workspace, a project.
	const telemetry = telemetryServiceFor(driver);
	// Drivers with no DB host/credentials hide the AWS Secrets Manager + SSH Tunnel tabs.
	const isSimple = isFileBased || isVector || isAccountBased || !!telemetry;
	// Set once any field changes, so closing the form can guard against losing edits.
	const [dirty, setDirty] = useState(false);
	const [confirm, confirmDialog] = useConfirm();

	// Once a field settles, the form's facts are passed to the companion (`formAdvice`), which picks
	// the one thing worth raising (a port that belongs to another engine, a URL pasted into Host, a
	// name that says prod on a connection not tagged prod, or, on a fresh form, what this driver
	// needs). Each topic is passed once per form; a Test passes its real error (`testAdvice`).
	const driverPicked = useRef(Boolean(existing?.driver ?? d?.driver));
	const coachSaid = useRef(new Set<string>());
	const testFailed = useRef(false);
	function coachFacts(): FormFacts {
		const shape: FormFacts['shape'] = isFileBased ? 'file' : isVector ? 'vector' : isAccountBased ? 'account' : telemetry ? 'logs' : driver === 'mongodb' && mongoUriMode ? 'uri' : 'server';
		return {
			edit: isEdit,
			label,
			driver,
			driverName: flavorFor(driver, flavor)?.displayName ?? dialectFor(driver).displayName,
			defaultPort: defaultPortFor(driver, flavor),
			// What the companion is told goes to a model: never a connection string's password.
			host: maskUriPasswords(host),
			port,
			database,
			username,
			environment,
			ssl,
			shape,
			driverPicked: driverPicked.current,
		};
	}
	useEffect(() => {
		const timer = window.setTimeout(() => {
			const move = formAdvice(coachFacts(), coachSaid.current);
			if (move) {
				coachSaid.current.add(move.topic);
				libyCall(move);
			}
		}, 900);
		return () => window.clearTimeout(timer);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [driver, flavor, host, port, environment, ssl, label, mongoUriMode]);

	// Summoned onto this form (the companion's help): the form's own reading, said whether or not the coach
	// already said it, else the last Test's error, else what this driver needs.
	const lastTest = useRef<{ ok: boolean; error?: string } | undefined>(undefined);
	const helpFactsRef = useRef(coachFacts);
	helpFactsRef.current = coachFacts;
	useEffect(() => registerLibyHelper({
		selector: '[data-liby="connection-form"]',
		place: () => (isEdit ? `the Edit connection dialog (${helpFactsRef.current().label || 'unnamed'})` : 'the New connection dialog'),
		help: () => asLibyHelp(formHelp(helpFactsRef.current(), lastTest.current)),
	}), [isEdit]);

	// Why is this form open? Editing a connection that failed the last time it was used: that
	// failure is passed to the companion (`returnAdvice`). A fresh form: a database on this computer
	// (a container, a local port) that is not saved yet is passed to it (`foundAdvice`) with a way to
	// fill the form in. Nothing found: nothing is passed. Only this computer's containers and ports
	// are looked at, never another tool's saved files (that is "Find databases").
	useEffect(() => {
		if (existing) {
			const failed = lastErrorFor(existing.id, 'connection', 24 * 60 * 60_000);
			const move = failed?.detail ? returnAdvice(coachFacts(), failed.detail) : null;
			if (move) {
				const timer = window.setTimeout(() => libyCall(move), 600);
				return () => window.clearTimeout(timer);
			}
			return undefined;
		}
		if (d) {
			return undefined; // a draft (from the assistant, say) already says what is wanted
		}
		let gone = false;
		const sources: ImportSourceId[] = ['docker', 'local'];
		void Promise.all(sources.map((source) => window.sqlApi.importScan(source).then((r) => r.items.map((item) => ({ source, item })), () => [])))
			.then((lists) => {
				// Only while the form is still fresh: once they are typing their own, it is not wanted.
				if (gone || driverPicked.current || host.trim()) {
					return;
				}
				const usable = lists.flat().filter(({ item }) => item.supported && !item.duplicate);
				const found: FoundDb[] = usable.map(({ source, item }) => ({
					where: source === 'docker' ? 'docker' : 'local',
					name: item.sourceName,
					driverName: flavorFor(item.values.driver, item.values.flavor)?.displayName ?? dialectFor(item.values.driver).displayName,
					port: item.values.port,
					tentative: item.tentative === true,
				}));
				const move = foundAdvice(found);
				if (!move) {
					return;
				}
				const pick = usable[found.findIndex((f) => !f.tentative && `tip:found:${f.where}:${f.port}` === move.topic)] ?? usable[0];
				libyCall({ ...move, action: pick.item.importsPassword
					? { label: "Add it", run: () => void addFound(pick.source, pick.item) }
					: { label: "Fill it in", run: () => fillFrom(pick.item) } });
			});
		return () => {
			gone = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	/** Her offer, taken: the found database's details into the form (its password is typed). */
	function fillFrom(item: ImportItem): void {
		const v = item.values;
		driverPicked.current = true;
		setDriver(v.driver);
		setFlavor(v.flavor ?? '');
		setLabel(label || v.label || item.sourceName);
		setHost(v.host);
		setPort(v.port ? String(v.port) : '');
		setDatabase(v.database ?? '');
		setUsername(v.username ?? '');
		setDirty(true);
	}

	/** Her offer, taken, when discovery holds the password too (a container's environment): saved
	 *  the way "Find databases" saves it, the password resolved in main and never seen here. */
	async function addFound(source: ImportSourceId, item: ImportItem): Promise<void> {
		try {
			const added = await window.sqlApi.importApply(source, [item.ref]);
			if (added > 0) {
				onSaved();
				onClose();
				return;
			}
		} catch {
			// fall back to filling the form, below
		}
		fillFrom(item);
	}

	// The saved cloud accounts, for the telemetry picker. Loaded only when a telemetry driver is
	// selected: on every other driver this list is not shown and fetching it would be a round-trip
	// nobody asked for.
	useEffect(() => {
		if (!telemetry) {
			return;
		}
		let active = true;
		void window.sqlApi.cloud.list().then((accounts) => {
			if (active) {
				setCloudAccounts(accounts);
			}
		}).catch(() => {
			// A settings store that will not read is not this form's problem to report: the picker
			// shows "no accounts" and the link to Settings, which is the actionable thing anyway.
		});
		return () => { active = false; };
	}, [telemetry?.service]);

	// Load the saved tunnel profiles for the picker, and keep them fresh while the tunnel
	// manager is open (creating/deleting a profile pushes a tunnels:changed event).
	useEffect(() => {
		let active = true;
		async function load(): Promise<void> {
			const state = await window.sqlApi.tunnelsState();
			if (active) {
				setProfiles(state.profiles);
			}
		}
		void load();
		const off = window.sqlApi.onTunnelsChanged(() => void load());
		return () => { active = false; off(); };
	}, []);

	// The AWS / SSH tabs don't apply to a file-based or vector driver; snap back to General.
	useEffect(() => {
		if (isSimple && tab !== 'general') {
			setTab('general');
		}
	}, [isSimple, tab]);

	// Close, but confirm first if there are unsaved edits — a stray backdrop click (or
	// Cancel) shouldn't silently discard a half-filled connection.
	async function attemptClose(): Promise<void> {
		if (dirty && !(await confirm({ title: "Discard unsaved changes?", body: "Unsaved changes to this connection will be lost.", confirmLabel: "Discard", danger: true }))) {
			return;
		}
		onClose();
	}

/** Scopes typed one per line (commas tolerated), trimmed and de-duplicated. Undefined when none
 *  were typed, which is what "every scope in the container" is stored as. */
function splitScopes(text: string): string[] | undefined {
	const names = text
		.split(/[\n,]/)
		.map((name) => name.trim())
		.filter(Boolean);
	return names.length > 0 ? [...new Set(names)] : undefined;
}

	function num(value: string): number | undefined {
		return value.trim() === '' ? undefined : Number(value);
	}

	// Pick the SSH private key from a file dialog (keeps the path; the server reads the key
	// from disk at connect time). The field stays editable so a path can still be typed/pasted.
	async function pickKey(): Promise<void> {
		const path = await window.sqlApi.pickFilePath();
		if (path) {
			setSshKey(path);
			setDirty(true);
		}
	}

	// Choose the cloud account this telemetry connection authenticates as, and seed the container
	// from it where the account already answers the question: an AWS account carries a default
	// region, and a CloudWatch connection's container IS a region, so picking "Production · us-east-1"
	// should not then ask for the region it just named. Only when the account's value is one of
	// this service's own options (so an Azure workspace ID or a GCP project is never guessed at),
	// and only when nothing is chosen yet, so it never overwrites a deliberate choice. The flow
	// wizard seeds its log region the same way.
	function chooseCloudAccount(id: string): void {
		setCloudAccountId(id);
		const account = cloudAccounts.find((entry) => entry.id === id);
		const region = account?.region;
		if (region && telemetry?.containerOptions?.includes(region)) {
			setCloudScope((current) => current || region);
		}
	}

	// Pick the SQLite database file. The path is stored in `database`; the server opens it at
	// connect time. The field stays editable so a path can still be typed/pasted.
	async function pickDb(): Promise<void> {
		const path = await window.sqlApi.pickFilePath();
		if (path) {
			setDatabase(path);
			setDirty(true);
		}
	}

	// Pick a custom CA certificate (.pem) for SSL verification. Same idea as the SSH key:
	// the path is stored and the cert is read in main at connect time.
	async function pickCa(): Promise<void> {
		const path = await window.sqlApi.pickFilePath();
		if (path) {
			setSslCaPath(path);
			setDirty(true);
		}
	}

	function pickDriver(value: string): void {
		const [nextDriver, nextFlavor = ''] = value.split(FLAVOR_SEPARATOR);
		driverPicked.current = true;
		setDriver(nextDriver);
		setFlavor(nextFlavor);
	}

	function collect(): ConnectionFormValues {
		const values: ConnectionFormValues = {
			id: existing?.id,
			label: label.trim(),
			driver,
			flavor: flavorFor(driver, flavor)?.id,
			environment: environment || undefined,
			host: host.trim(),
			port: num(port) ?? defaultPortFor(driver, flavor) ?? 0,
			database: database.trim() || undefined,
			username: username.trim(),
			password: password || undefined,
			ssl,
			sslMode: ssl ? sslMode : undefined,
			sslCaPath: ssl && sslMode === 'custom' ? sslCaPath.trim() || undefined : undefined,
			readOnly,
			aiDataAccess: aiDataAccess || undefined,
			poolMax: num(poolMax),
			warehouse: isAccountBased ? warehouse.trim() || undefined : undefined,
			role: isAccountBased ? role.trim() || undefined : undefined,
			cloudAccountId: telemetry ? cloudAccountId || undefined : undefined,
			cloudScope: telemetry ? cloudScope.trim() || undefined : undefined,
			cloudScopes: telemetry ? splitScopes(cloudScopes) : undefined,
		};
		if (awsEnabled) {
			values.aws = {
				region: awsRegion.trim(),
				secretId: awsSecretId.trim(),
				profile: awsProfile.trim() || undefined,
				accessKeyId: awsAccessKeyId.trim() || undefined,
				secretAccessKey: awsSecretAccessKey || undefined,
			};
		}
		if (tunnelMode === 'profile' && tunnelRef) {
			values.sshTunnelRef = tunnelRef;
		} else if (tunnelMode === 'inline') {
			values.ssh = {
				host: sshHost.trim(),
				port: num(sshPort),
				username: sshUsername.trim(),
				privateKeyPath: sshKey.trim() || undefined,
				passphrase: sshPassphrase || undefined,
				password: sshPassword || undefined,
				localPort: num(sshLocalPort),
				keepAlive: sshKeepAlive,
			};
			// A tunnel typed here is saved as a reusable profile so it can be shared.
			values.saveTunnelAsProfile = true;
		}
		if (tunnelMode !== 'none' && forgetHostKey) {
			values.forgetSshHostKey = true;
		}
		return values;
	}

	/**
	 * Whether this edit moves the connection: a new driver, host, port, TLS setting, tunnel
	 * endpoint or user name, or a new database where that field says where it goes (a file, a Db2 or
	 * Oracle connect string, a HANA tenant). Main then drops the saved password unless one is typed here (a stored secret never
	 * follows a connection somewhere new), so the form says so before Save rather than after a failed
	 * connect. The same rule main applies, read off the fields as they stand.
	 */
	function movesDestination(values: ConnectionFormValues): boolean {
		if (!existing) {
			return false;
		}
		const profileEndpoint = (ref: string): ConnectionDestination['tunnel'] =>
			tunnelEndpoint(profiles.find((p) => p.id === ref)) ?? { host: `profile ${ref}`, port: 0, username: '' };
		const before: ConnectionDestination = {
			driver: existing.driver,
			flavor: existing.flavor,
			host: existing.host,
			port: existing.port,
			ssl: existing.ssl,
			tunnel: existing.sshTunnel ? tunnelEndpoint(existing.sshTunnel) : existing.sshTunnelRef ? profileEndpoint(existing.sshTunnelRef) : undefined,
			username: existing.username,
			database: existing.database,
		};
		const ssl: ConnectionDestination['ssl'] = !values.ssl ? undefined
			: values.sslMode === 'insecure' ? { rejectUnauthorized: false }
			: values.sslMode === 'rds' ? { rejectUnauthorized: true, caBundle: 'rds' }
			: values.sslMode === 'custom' ? { rejectUnauthorized: true, caPath: values.sslCaPath }
			: { rejectUnauthorized: true };
		const after: ConnectionDestination = {
			driver: values.driver,
			flavor: values.flavor,
			host: values.host,
			port: values.port,
			ssl,
			tunnel: values.sshTunnelRef ? profileEndpoint(values.sshTunnelRef) : values.ssh ? tunnelEndpoint(values.ssh) : undefined,
			username: values.username,
			database: values.database,
		};
		return destinationChanges(before, after).length > 0;
	}

	/** Shared field validation for Test and Save; returns an error message or null. */
	function validate(values: ConnectionFormValues): string | null {
		// File-based driver (SQLite): only the database file path is required.
		if (isFileBased) {
			return values.database ? null : "Choose a database file.";
		}
		// Vector driver (Pinecone): only the API key is required (kept on edit if left blank).
		if (isVector) {
			return isEdit || values.password ? null : "An API key is required.";
		}
		// Telemetry driver: a cloud account of the right vendor, and the container within it. There
		// is no secret to check here — the credential lives on the account, not on the connection.
		if (telemetry) {
			if (!values.cloudAccountId) {
				return `Pick the ${telemetry.vendor.toUpperCase()} cloud account this connection should use.`;
			}
			return values.cloudScope ? null : `A ${telemetry.containerNoun} is required (for example ${telemetry.containerExample}).`;
		}
		// Account-based driver (Snowflake): account identifier (in `host`) + username are required;
		// the password is kept on edit if left blank.
		if (isAccountBased) {
			if (!values.host || !values.username) {
				return "Account identifier and username are required.";
			}
			return null;
		}
		if (awsEnabled && (!values.aws?.region || !values.aws?.secretId)) {
			return "AWS region and secret name are required.";
		}
		// MongoDB may authenticate via credentials embedded in the URI (or not at all), so only the
		// host/connection string is mandatory; every other driver still needs a username.
		if (!awsEnabled && driver === 'mongodb' && !values.host) {
			return mongoUriMode ? "A connection string is required." : "Host is required.";
		}
		if (!awsEnabled && driver !== 'mongodb' && (!values.host || !values.username)) {
			return "Host and username are required.";
		}
		if (ssl && sslMode === 'custom' && !values.sslCaPath) {
			return "Choose a CA certificate file, or pick a different SSL mode.";
		}
		if (tunnelMode === 'profile' && !values.sshTunnelRef) {
			return "Choose a saved tunnel, or create one.";
		}
		return null;
	}

	async function test(): Promise<void> {
		const values = collect();
		const error = validate(values);
		if (error) {
			setStatus({ ok: false, message: error });
			return;
		}
		setBusy(true);
		setStatus({ ok: true, message: "Testing…" });
		try {
			const result = await window.sqlApi.testConnection(values);
			// The Test already forgot the key and trusted the one it saw; forgetting again on Save
			// would leave the next connect open to a different key.
			if (values.forgetSshHostKey) {
				setForgetHostKey(false);
			}
			setStatus({ ok: result.ok, message: result.ok ? "Connection OK." : (result.error ?? "Connection failed.") });
			lastTest.current = { ok: result.ok, error: result.error };
			const move = testAdvice(coachFacts(), result.ok, result.error, testFailed.current);
			testFailed.current = testFailed.current || !result.ok;
			if (move) {
				libyCall(move);
			}
		} catch (err) {
			setStatus({ ok: false, message: errorMessage(err) });
		} finally {
			setBusy(false);
		}
	}

	async function save(event: FormEvent): Promise<void> {
		event.preventDefault();
		const values = collect();
		if (!values.label) {
			setStatus({ ok: false, message: "Label is required." });
			return;
		}
		const error = validate(values);
		if (error) {
			setStatus({ ok: false, message: error });
			return;
		}
		setBusy(true);
		try {
			await window.sqlApi.saveConnectionFromForm(values);
			onSaved();
			onClose();
		} catch (err) {
			setStatus({ ok: false, message: errorMessage(err) });
			setBusy(false);
		}
	}

	const keep = isEdit ? "leave blank to keep current" : undefined;
	const passwordMoved = isEdit && !password && !awsEnabled && movesDestination(collect());

	return (
		<>
		<div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) { void attemptClose(); } }}>
			<form className="modal" data-liby="connection-form" onChange={() => setDirty(true)} onSubmit={save}>
				<h2>{isEdit ? `Edit Connection: ${existing.label}` : "New Connection"}</h2>
				<div className="tabs">
					<button type="button" className={tab === 'general' ? 'tab active' : 'tab'} onClick={() => setTab('general')}>General</button>
					{!isSimple && (
						<>
							<button type="button" className={tab === 'aws' ? 'tab active' : 'tab'} onClick={() => setTab('aws')}>
								AWS Secrets Manager{awsEnabled && <span className="tab-dot" title="Enabled" />}
							</button>
							<button type="button" data-liby="connection-ssh-tab" className={tab === 'ssh' ? 'tab active' : 'tab'} onClick={() => setTab('ssh')}>
								SSH Tunnel{tunnelMode !== 'none' && <span className="tab-dot" title="Enabled" />}
							</button>
						</>
					)}
				</div>

				<div className="tab-panel">
					{tab === 'general' && (
						<>
							{/* Only when creating: on an edit this connection already exists, and
							    offering to import over it is a different action wearing the same
							    words. It names the other TOOLS, not SnoutData Cloud: a cloud database
							    turns up in Connections on its own (cloudSync.ts), so pointing at an
							    import for it sends the user to do work the app already did. */}
							{!isEdit && onImport && (
								<div className="import-note">
									<Icon name="desktop-download" />
									<span>
										Already saved this database in DBeaver, DataGrip, pgAdmin or another tool?{' '}
										<button type="button" className="link-btn" onClick={onImport}>Import it instead</button>
										{' '}and skip typing it again.
									</span>
								</div>
							)}
							<label>Label<input value={label} autoFocus onChange={(e) => setLabel(e.target.value)} /></label>
							<div className="row">
								<label className="grow">Driver
									<IconSelect value={pickerValue(driver, flavor)} options={driverOptions()} onChange={pickDriver} ariaLabel="Driver" />
								</label>
								<label className="env-field">Environment
									<select value={environment} data-liby="connection-env" onChange={(e) => setEnvironment(e.target.value)}>
										<option value="">(none)</option>
										<option value="dev">dev</option>
										<option value="stage">stage</option>
										<option value="prod">prod</option>
									</select>
								</label>
							</div>
							{isFileBased ? (
								<label>Database file
									<div className="key-picker">
										<input placeholder="path to a .db / .sqlite / .duckdb file" value={database} onChange={(e) => setDatabase(e.target.value)} />
										<button type="button" className="secondary" onClick={() => void pickDb()} title="Choose a database file"><Icon name="folder-opened" /> Browse</button>
									</div>
								</label>
							) : isVector ? (
								<>
									<label>API key<input type="password" value={password} placeholder={keep ?? "Pinecone API key"} onChange={(e) => setPassword(e.target.value)} /></label>
									<p className="field-hint">The connection is a Pinecone project, authenticated by its API key. Indexes are discovered automatically and shown as tables; query them with SQL (a WHERE metadata filter, transcribed) or a native Pinecone query.</p>
								</>
							) : telemetry ? (
								<>
									<label>Cloud account
										<select value={cloudAccountId} onChange={(e) => chooseCloudAccount(e.target.value)}>
											<option value="">(pick an account)</option>
											{cloudAccounts.filter((a) => a.vendor === telemetry.vendor).map((account) => (
												<option key={account.id} value={account.id}>{account.name}</option>
											))}
										</select>
									</label>
									{cloudAccounts.every((a) => a.vendor !== telemetry.vendor) && (
										<p className="field-hint">There is no {telemetry.vendor.toUpperCase()} account saved yet. Add one under Settings, Cloud accounts, and it will serve this connection and your data flows alike.</p>
									)}
									<label>{telemetry.containerNoun.charAt(0).toUpperCase() + telemetry.containerNoun.slice(1)}
										{telemetry.containerOptions ? (
											<select value={cloudScope} onChange={(e) => setCloudScope(e.target.value)}>
												<option value="">(pick a {telemetry.containerNoun})</option>
												{telemetry.containerOptions.map((option) => (
													<option key={option} value={option}>{option}</option>
												))}
											</select>
										) : (
											<input value={cloudScope} placeholder={telemetry.containerExample} onChange={(e) => setCloudScope(e.target.value)} />
										)}
									</label>
									<label>{telemetry.scopeNoun.charAt(0).toUpperCase() + telemetry.scopeNoun.slice(1)}s
										<textarea
											rows={3}
											value={cloudScopes}
											placeholder={`optional, one per line. Leave empty to show every ${telemetry.scopeNoun} in the ${telemetry.containerNoun}.`}
											onChange={(e) => setCloudScopes(e.target.value)}
										/>
									</label>
									<p className="field-hint">
										Listing {telemetry.scopeNoun}s is its own permission, and a credential scoped to particular
										ones is refused it. Name them here and the app stops asking for the list: it reads only what
										you named, with only the permission you already have.
									</p>
									<p className="field-hint">
										Each {telemetry.scopeNoun} in this {telemetry.containerNoun} is shown as a table you can query with SQL: {" "}
										<code>SELECT ts, message FROM "…" WHERE message LIKE '%ERROR%' AND ts &gt;= ago('1h')</code>.
										{" "}Every query is bounded by a time range, and one that names none covers the last hour.
										{telemetry.aggregatesAtSource
											? ` A GROUP BY is run by ${telemetry.label} itself; the results footer says what it scanned.`
											: ` ${telemetry.label} cannot group at the source, so a GROUP BY is computed here over the events in the range.`}
									</p>
								</>
							) : isAccountBased ? (
								<>
									<label>Account<input value={host} data-liby="connection-host" placeholder="e.g. xy12345.us-east-1 or org-account" onChange={(e) => setHost(e.target.value)} /></label>
									<label>Database<input value={database} onChange={(e) => setDatabase(e.target.value)} /></label>
									<label>Username<input value={username} onChange={(e) => setUsername(e.target.value)} /></label>
									<label>Password<input type="password" value={password} data-liby="connection-password" placeholder={keep} onChange={(e) => setPassword(e.target.value)} /></label>
									<div className="row">
										<label className="grow">Warehouse<input value={warehouse} placeholder="e.g. COMPUTE_WH" onChange={(e) => setWarehouse(e.target.value)} /></label>
										<label className="grow">Role<input value={role} placeholder="optional" onChange={(e) => setRole(e.target.value)} /></label>
									</div>
									<p className="field-hint">Snowflake is reached over HTTPS by account identifier (no host/port or SSH tunnel). A running warehouse is needed to run queries. Password auth only for now (key-pair / SSO are not yet supported).</p>
								</>
							) : (
							<>
							{driver === 'mongodb' ? (
								<>
								<label>Connection
									<select value={mongoUriMode ? 'uri' : 'fields'} onChange={(e) => setMongoUriMode(e.target.value === 'uri')}>
										<option value="fields">Host and port</option>
										<option value="uri">Connection string (URI)</option>
									</select>
								</label>
								{mongoUriMode ? (
									<>
									<label>Connection string<input value={host} data-liby="connection-host" placeholder="mongodb://host:27017/?authMechanism=SCRAM-SHA-1" onChange={(e) => setHost(e.target.value)} /></label>
									<p className="field-hint">A full "mongodb://" URI (may include credentials, database, and options). A password in it is kept in the keychain when you save, and the connection string is saved without it. Over an SSH tunnel use an explicit host:port (not "mongodb+srv://"); the tunnel forces a direct single-host connection, so "replicaSet" is ignored. For Amazon DocumentDB add "?authMechanism=SCRAM-SHA-1". The Username below is used only when the URI carries no user name; the Password is used either way.</p>
									</>
								) : (
								<div className="row">
									<label className="grow">Host<input value={host} data-liby="connection-host" onChange={(e) => setHost(e.target.value)} /></label>
									<label className="port">Port<input type="number" value={port} data-liby="connection-port" placeholder={String(defaultPortFor(driver, flavor) ?? "")} onChange={(e) => setPort(e.target.value)} /></label>
								</div>
								)}
								</>
							) : (
								<div className="row">
									<label className="grow">Host<input value={host} data-liby="connection-host" onChange={(e) => setHost(e.target.value)} /></label>
									<label className="port">Port<input type="number" value={port} data-liby="connection-port" placeholder={String(defaultPortFor(driver, flavor) ?? "")} onChange={(e) => setPort(e.target.value)} /></label>
								</div>
							)}
								<label>{driver === 'oracle' ? "Service name" : "Database"}<input value={database} data-liby="connection-database" placeholder={driver === 'oracle' ? "e.g. ORCLPDB1 or XEPDB1" : undefined} onChange={(e) => setDatabase(e.target.value)} /></label>
							<label>Username<input value={username} placeholder={awsEnabled ? "from AWS secret" : undefined} onChange={(e) => setUsername(e.target.value)} /></label>
							<label>Password<input type="password" value={password} data-liby="connection-password" placeholder={awsEnabled ? "from AWS secret" : passwordMoved ? undefined : keep} disabled={awsEnabled} onChange={(e) => setPassword(e.target.value)} /></label>
							{passwordMoved && <p className="field-hint connection-password-moved">This edit changes where the connection goes or who it signs in as, so the saved password will not be sent there. Type it again to keep one.</p>}
							<label className="check" data-liby="connection-ssl"><input type="checkbox" checked={ssl} onChange={(e) => setSsl(e.target.checked)} /> Use SSL</label>
							{ssl && (
								<div className="ssl-options">
									<label>Certificate verification
										<select value={sslMode} onChange={(e) => setSslMode(e.target.value as SslMode)}>
											<option value="rds">Verify with Amazon RDS CA (bundled)</option>
											<option value="system">Verify with system trust store</option>
											<option value="custom">Verify with custom CA file…</option>
											<option value="insecure">Encrypt, don't verify certificate</option>
										</select>
									</label>
									{sslMode === 'custom' && (
										<label>CA certificate file
											<div className="key-picker">
												<input placeholder="path to a .pem file" value={sslCaPath} onChange={(e) => setSslCaPath(e.target.value)} />
												<button type="button" className="secondary" onClick={() => void pickCa()} title="Choose a CA certificate file"><Icon name="folder-opened" /> Browse</button>
											</div>
										</label>
									)}
									<p className="field-hint">
										{sslMode === 'rds' && "For AWS RDS / Aurora endpoints: verifies the server against Amazon's RDS root CA, which isn't in the system trust store."}
										{sslMode === 'system' && "For servers whose certificate is signed by a publicly trusted CA already in the OS/Node trust store."}
										{sslMode === 'custom' && "Verifies the server against a CA certificate you supply (PEM)."}
										{sslMode === 'insecure' && "Encrypts the connection but does not verify the server certificate. Use only when you can't supply the right CA."}
									</p>
								</div>
							)}
							</>
							)}
							<label className="check" title="Block writes / DDL and disable in-grid editing for this connection."><input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} /> Read-only (no writes, no DDL)</label>
							{readOnly && backendKindForDriver(driver) === 'relational' && <p className="field-hint">Each statement is checked before it runs. {readOnlyEnforcementFor(driver, flavor || undefined).summary}</p>}
							<label>What the AI may see of this database
								<select value={aiDataAccess} onChange={(e) => setAiDataAccess(e.target.value as DataAccessLevel | '')}>
									<option value="">Use the default from AI settings</option>
									{DATA_ACCESS_LEVELS.map((level) => <option key={level} value={level}>{DATA_ACCESS_INFO[level].label}</option>)}
								</select>
							</label>
							<p className="field-hint">
								{aiDataAccess
									? `${DATA_ACCESS_INFO[aiDataAccess].detail} Overrides the default for this database, for the assistant and coding agents.`
									: "Set one here to give this database its own level, for example schema only on production."}
							</p>
							<label className="grow">Connection pool size<input type="number" min={MIN_POOL_MAX} max={MAX_POOL_MAX} value={poolMax} placeholder={String(DEFAULT_POOL_MAX)} onChange={(e) => setPoolMax(e.target.value)} /></label>
							<p className="field-hint">Max simultaneous queries this connection runs against the database ({MIN_POOL_MAX} to {MAX_POOL_MAX}, default {DEFAULT_POOL_MAX}). Raise it for heavy dashboards or parallel workloads. The database server's own connection limit still applies.</p>
						</>
					)}

					{tab === 'aws' && (
						<>
							<label className="check" title="Fetch the database username and password from AWS Secrets Manager at connect time instead of storing a password locally."><input type="checkbox" checked={awsEnabled} onChange={(e) => setAwsEnabled(e.target.checked)} /> Fetch credentials from AWS Secrets Manager</label>
							{awsEnabled && (
								<fieldset>
									<legend>AWS Secrets Manager</legend>
									<div className="row">
										<label className="grow">Region<input placeholder="us-east-1" value={awsRegion} onChange={(e) => setAwsRegion(e.target.value)} /></label>
										<label className="grow">Profile<input placeholder="default credential chain" value={awsProfile} onChange={(e) => setAwsProfile(e.target.value)} /></label>
									</div>
									<label>Secret name or ARN<input placeholder="prod/db/credentials" value={awsSecretId} onChange={(e) => setAwsSecretId(e.target.value)} /></label>
									<div className="row">
										<label className="grow">Access key ID<input placeholder="optional" value={awsAccessKeyId} onChange={(e) => setAwsAccessKeyId(e.target.value)} /></label>
										<label className="grow">Secret access key<input type="password" placeholder={awsAccessKeyId ? keep ?? "required with access key ID" : "optional"} value={awsSecretAccessKey} onChange={(e) => setAwsSecretAccessKey(e.target.value)} /></label>
									</div>
									<p className="field-hint">Leave the access key blank to use the named profile or your machine's default AWS credentials (env vars, SSO, instance role). The secret must be JSON with at least "username" and "password". When it carries "host" and "port" (as RDS-managed secrets do), that is where the credentials go: leave the host blank on the General tab, or give the same one, since a different host is refused. "dbname" fills in a blank database.</p>
								</fieldset>
							)}
						</>
					)}

					{tab === 'ssh' && (
						<>
							<label>Tunnel
								<select value={tunnelMode} onChange={(e) => setTunnelMode(e.target.value as TunnelMode)}>
									<option value="none">No tunnel (connect directly)</option>
									<option value="profile">Use a saved tunnel</option>
									<option value="inline">Configure a tunnel for this connection</option>
								</select>
							</label>
							{tunnelMode === 'profile' && (
								<fieldset>
									<legend>Saved tunnel</legend>
									{profiles.length === 0 ? (
										<p className="field-hint">No saved tunnels yet. Create one to reuse it across connections.</p>
									) : (
										<label>Tunnel
											<select value={tunnelRef} onChange={(e) => setTunnelRef(e.target.value)}>
												<option value="">Select a tunnel…</option>
												{profiles.map((profile) => (
													<option key={profile.id} value={profile.id} title={`${profile.username}@${profile.host}${profile.port ? `:${profile.port}` : ''}`}>{profile.name}</option>
												))}
											</select>
										</label>
									)}
									<button type="button" className="secondary" onClick={() => setManageTunnels(true)}><Icon name="settings-gear" /> Manage tunnels</button>
									<p className="field-hint">Saved tunnels are shared: editing one updates every connection that uses it.</p>
								</fieldset>
							)}
							{tunnelMode === 'inline' && (
								<fieldset>
									<legend>SSH tunnel</legend>
									<div className="row">
										<label className="grow">SSH host<input value={sshHost} onChange={(e) => setSshHost(e.target.value)} /></label>
										<label className="port">Port<input type="number" placeholder="22" value={sshPort} onChange={(e) => setSshPort(e.target.value)} /></label>
									</div>
									<label>SSH username<input value={sshUsername} onChange={(e) => setSshUsername(e.target.value)} /></label>
									<label>Private key file
										<div className="key-picker">
											<input placeholder="~/.ssh/id_rsa" value={sshKey} onChange={(e) => setSshKey(e.target.value)} />
											<button type="button" className="secondary" onClick={() => void pickKey()} title="Choose a private key file"><Icon name="folder-opened" /> Browse</button>
										</div>
									</label>
									<label>Key passphrase<input type="password" placeholder={keep} value={sshPassphrase} onChange={(e) => setSshPassphrase(e.target.value)} /></label>
									<label>SSH password<input type="password" placeholder={keep} value={sshPassword} onChange={(e) => setSshPassword(e.target.value)} /></label>
									<label>Local bind port<input type="number" placeholder="auto" value={sshLocalPort} onChange={(e) => setSshLocalPort(e.target.value)} /></label>
									<label className="check" title="Send SSH keepalives so the bastion doesn't idle-out the tunnel. Leave on unless a bastion rejects keepalive traffic."><input type="checkbox" checked={sshKeepAlive} onChange={(e) => setSshKeepAlive(e.target.checked)} /> Keep tunnel alive (recommended)</label>
								</fieldset>
							)}
							{tunnelMode !== 'none' && (
								<>
									<label className="check"><input type="checkbox" checked={forgetHostKey} onChange={(e) => setForgetHostKey(e.target.checked)} /> Forget the saved host key</label>
									<p className="field-hint">The app remembers the SSH server's host key the first time it connects and refuses a different one. Turn this on only if the server was rebuilt and you have confirmed its new key. After a Test or Save with this on, the next connection trusts the key it sees.</p>
								</>
							)}
						</>
					)}
				</div>

				<div className="modal-actions">
					<button type="button" className="secondary" data-liby="connection-test" onClick={() => void test()} disabled={busy}><Icon name="plug" /> Test Connection</button>
					<span className="spacer" />
					<button type="button" className="secondary" onClick={() => void attemptClose()} disabled={busy}><Icon name="close" /> Cancel</button>
					<button type="submit" disabled={busy}><Icon name="save" /> Save</button>
				</div>
				{status && <div className={`form-status ${status.ok ? "ok" : "error"}`}>{status.message}</div>}
			</form>
		</div>
		{manageTunnels && <TunnelProfilesModal onClose={() => setManageTunnels(false)} />}
		{confirmDialog}
		</>
	);
}

/**
 * The driver list, grouped by what each driver actually IS.
 *
 * The grouping is what makes a per-row glyph worth having. Nine relational drivers all carry the
 * database glyph, and nine identical icons down a flat list is noise; under a heading that says
 * "Relational", the same nine read as one family, and the three cloud log services read as the
 * different kind of thing they are. That distinction is not decoration — it is exactly what changes
 * below this field (a path picker, or a cloud account and a region, instead of host and port).
 *
 * The mapping itself lives in `driverKind.ts` because the connections tree shows the same mark, and
 * two copies of it would drift the day a driver is added.
 */
function driverOptions(): IconSelectOption[] {
	const dialects = listDialects();
	const options: IconSelectOption[] = [];
	for (const { group, icon, match } of DRIVER_KINDS) {
		for (const dialect of dialects) {
			// First family whose test the driver passes owns it, so File-based wins over Relational
			// for SQLite and DuckDB without either test having to name the other.
			if (match(dialect.driverId) && !options.some((option) => option.value === dialect.driverId)) {
				options.push({ value: dialect.driverId, label: dialect.displayName, icon, group });
			}
		}
		// Engines that speak Postgres or MySQL on the wire sit with their family, as the relational
		// servers they are, rather than under a heading of their own.
		for (const flavor of listFlavors()) {
			if (match(flavor.baseDriver)) {
				options.push({ value: pickerValue(flavor.baseDriver, flavor.id), label: flavor.displayName, icon, group });
			}
		}
	}
	// A driver matching no family would otherwise vanish from the picker entirely, which is a far
	// worse failure than an unlabelled row.
	for (const dialect of dialects) {
		if (!options.some((option) => option.value === dialect.driverId)) {
			const { group, icon } = driverKind(dialect.driverId);
			options.push({ value: dialect.driverId, label: dialect.displayName, icon, group });
		}
	}
	return options;
}
