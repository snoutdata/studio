/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from './Icon';
import { PageMark } from '../art/Illustrations';
import {
	AuthUsers, CronSection, DataApiSection, ExtensionsSection, PostgresStatements, RealtimeSection, StorageBrowser, TimeSeriesSection,
	WorkOnIt, type ProjectHandle,
} from './ProjectSections';
import {
	LocalAuthSettings, LocalOverview, LocalDataApiSwitch, LocalDatabase, LocalDomains, LocalFunctions, LocalLogs, LocalPush,
	LocalSettingsSection,
} from './LocalProjectSections';
import {
	CloudBackupsSection, CloudDatabase, CloudDelete, CloudDomainsSection, CloudFunctionsSection, CloudKeys, CloudService,
	CloudStatus, CloudUsageSection,
} from './CloudProjectSections';
import { PROJECT_SECTION_GROUPS, PROJECT_SECTIONS, projectKey, type ProjectSection, type ProjectTarget } from '../../../shared/projects';
import { shardsOffered, type ShardsStatus } from '../../../shared/cloudShards';
import { lazyView } from '../lazyView';
import { CLOUD_VOCABULARY } from '../../../shared/ownLayout';
import type { LocalProjectRow } from '../../../shared/localStack';
import type { CloudProjectRow } from '../../../shared/cloudProjects';

/**
 * A SnoutData project as a workbench tab, local or cloud: ONE menu, the cloud dashboard's
 * (shared/projects.ts), and one set of sections. A section that is the same everywhere (users,
 * buckets and files, Realtime, the data API's docs, extensions, Cron, time series, Postgres's
 * statements) is one component handed the project; only what really differs by where the project
 * runs is picked here: a local project's Docker, folder and .env, or a cloud project's control
 * plane (running, usage, keys, backups, the product switches, function sizing, custom domains).
 */
interface ProjectViewProps {
	target: ProjectTarget;
	section: ProjectSection;
	onSection(section: ProjectSection): void;
	/** Show the project's database in Connections. */
	onOpenDatabase(target: ProjectTarget): void;
	/** A new SQL editor on the project's database. */
	onRunSql(target: ProjectTarget): void;
	/** The project was removed or deleted from here: the tab has nothing left to show. */
	onClosed(): void;
	/** Copy the whole project to the other side: this computer to the cloud, or back. */
	onCopy(target: ProjectTarget, name: string): void;
}

type Row = { kind: 'local'; row: LocalProjectRow } | { kind: 'cloud'; row: CloudProjectRow };

// The cluster screen is a product most projects do not have: its own chunk, fetched on first open.
const ShardsSection = lazyView(() => import('./ShardsSection').then((m) => ({ default: m.ShardsSection })));
// Snout Containers: its own chunk too, fetched the first time the section is opened.
const ContainersSection = lazyView(() => import('./ContainersSection').then((m) => ({ default: m.ContainersSection })));

/** Sections that read the database or the gateway, so they wait until the project can answer. */
const NEEDS_RUNNING: ReadonlySet<ProjectSection> = new Set(['extensions', 'cron', 'timeSeries', 'realtime']);

export function ProjectView(props: ProjectViewProps): JSX.Element {
	const { target } = props;
	const key = projectKey(target);
	// One object per project for the life of the tab, so a section's loads do not re-run on every poll.
	// eslint-disable-next-line react-hooks/exhaustive-deps
	const stableTarget = useMemo(() => target, [key]);
	const [found, setFound] = useState<Row | null>(null);
	const [missing, setMissing] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		if (stableTarget.kind === 'local') {
			const view = await window.sqlApi.local.list();
			const row = view.projects.find((p) => p.id === stableTarget.id);
			setFound(row ? { kind: 'local', row } : null);
			setMissing(row ? null : "This project is no longer in the list.");
		} else {
			const view = await window.sqlApi.cloudProjects();
			const row = view.projects.find((p) => p.ref === stableTarget.ref);
			setFound(row ? { kind: 'cloud', row } : null);
			setMissing(row ? null : view.unavailable ?? "This project is not in your account any more.");
		}
	}, [stableTarget]);

	useEffect(() => {
		void refresh();
		// A local state is one `docker ps`; a cloud one is a control-plane call, so it is asked less often.
		const timer = setInterval(() => {
			if (document.visibilityState === 'visible') {
				void refresh();
			}
		}, stableTarget.kind === 'local' ? 5000 : 15000);
		return () => clearInterval(timer);
	}, [refresh, stableTarget.kind]);

	const project: ProjectHandle | null = useMemo(() => {
		if (!found) {
			return null;
		}
		return found.kind === 'local'
			? { target: stableTarget, name: found.row.name, apiUrl: found.row.apiUrl, running: found.row.state === 'running' || found.row.state === 'partial', vocabulary: found.row.vocabulary }
			: { target: stableTarget, name: found.row.name, apiUrl: `https://${found.row.ref}.api.snoutdata.com`, running: found.row.state === 'ready' && !found.row.busy, vocabulary: CLOUD_VOCABULARY };
	}, [found, stableTarget]);

	// Shards is listed only for a cloud project the control plane offers it to (sharded, or a plan with
	// room for a second node). Asked once per tab; a control plane without the function refuses and the
	// section stays unlisted.
	const [offered, setOffered] = useState<ReadonlySet<string>>(new Set());
	useEffect(() => {
		if (stableTarget.kind !== 'cloud') {
			return;
		}
		let live = true;
		void window.sqlApi.cloudProject('shards', { ref: stableTarget.ref, action: 'status' }).then((outcome) => {
			if (live && outcome.ok && shardsOffered(outcome.data as unknown as ShardsStatus)) {
				setOffered(new Set(['shards']));
			}
		});
		return () => {
			live = false;
		};
	}, [stableTarget]);
	const listed = PROJECT_SECTIONS.filter((s) => !s.gated || offered.has(s.gated) || s.id === props.section);

	const current = listed.find((s) => s.id === props.section) ?? PROJECT_SECTIONS[0];
	const openDatabase = (): void => props.onOpenDatabase(stableTarget);
	const runSql = (): void => props.onRunSql(stableTarget);
	const stopped = target.kind === 'local'
		? "The project is not running. Start it from Overview to use this section."
		: "The project is paused. Start it from Overview to use this section.";

	return (
		<div className="cloud-project-view">
			<div className="settings-main">
				<nav className="settings-nav">
					<div className="cloud-project-nav-head">
						<Icon name={target.kind === 'local' ? 'device-desktop' : 'cloud'} />
						<span className="cloud-project-nav-name" title={target.kind === 'local' ? undefined : target.ref}>{project?.name ?? (target.kind === 'cloud' ? target.ref : "Project")}</span>
					</div>
					{PROJECT_SECTION_GROUPS.map((group) => (
						<div key={group.id} className="settings-nav-group">
							<div className="settings-nav-group-label">{group.label}</div>
							{listed.filter((s) => s.group === group.id).map((s) => (
								<button
									key={s.id}
									type="button"
									className={`settings-nav-item${s.id === current.id ? ' active' : ''}`}
									title={s.label}
									onClick={() => props.onSection(s.id)}
								>
									<Icon name={s.icon} className="settings-nav-icon" />
									<span>{s.label}</span>
								</button>
							))}
						</div>
					))}
				</nav>
				<div className="settings-content">
					<h3 className="settings-section-title"><PageMark art={current.id} text={current.label} /></h3>
					{missing && <div className="form-status warn">{missing}</div>}
					{!missing && !found && <div className="field-hint">Loading…</div>}
					{found && project && NEEDS_RUNNING.has(current.id) && !project.running && <div className="form-status warn">{stopped}</div>}
					{found && project && (!NEEDS_RUNNING.has(current.id) || project.running) && (
						<Section
							key={`${key}:${current.id}`}
							section={current.id}
							found={found}
							project={project}
							stopped={stopped}
							onSection={props.onSection}
							onChanged={refresh}
							onOpenDatabase={openDatabase}
							onRunSql={runSql}
							onClosed={props.onClosed}
							onCopy={() => props.onCopy(stableTarget, found.row.name)}
						/>
					)}
				</div>
			</div>
		</div>
	);
}

interface SectionProps {
	section: ProjectSection;
	found: Row;
	project: ProjectHandle;
	stopped: string;
	onSection(section: ProjectSection): void;
	onChanged(): Promise<void>;
	onOpenDatabase(): void;
	onRunSql(): void;
	onClosed(): void;
	onCopy(): void;
}

/** One section: the shared component, or the local or cloud piece where the two really differ. */
function Section(props: SectionProps): JSX.Element | null {
	const { found, project } = props;
	const local = found.kind === 'local' ? found.row : null;
	const cloud = found.kind === 'cloud' ? found.row : null;
	// A cloud product's own screens (users, buckets) show only while its switch is on.
	const [productOn, setProductOn] = useState<boolean | null>(null);
	const whenRunning = (element: JSX.Element): JSX.Element => (project.running ? element : <div className="form-status warn">{props.stopped}</div>);

	const workOnIt = <WorkOnIt onRunSql={props.onRunSql} onBrowse={props.onOpenDatabase} onSettings={() => props.onSection('settings')} />;

	switch (props.section) {
		case 'overview':
			return local
				? <LocalOverview row={local} onChanged={props.onChanged} workOnIt={workOnIt} />
				: <><CloudStatus row={cloud} projectRef={cloud!.ref} onChanged={props.onChanged} /><CloudUsageSection projectRef={cloud!.ref} />{workOnIt}<CloudKeys projectRef={cloud!.ref} /></>;
		case 'database':
			return local ? <LocalDatabase row={local} onOpenDatabase={props.onOpenDatabase} /> : <CloudDatabase projectRef={cloud!.ref} onOpenDatabase={props.onOpenDatabase} />;
		case 'extensions':
			return <ExtensionsSection project={project} />;
		case 'cron':
			return <CronSection project={project} />;
		case 'timeSeries':
			return <TimeSeriesSection project={project} />;
		case 'auth':
			return local
				? <>{whenRunning(<AuthUsers project={project} />)}<LocalAuthSettings row={local} /></>
				: <><CloudService projectRef={cloud!.ref} service="auth" onState={setProductOn} />{productOn && whenRunning(<AuthUsers project={project} />)}</>;
		case 'storage':
			return local
				? whenRunning(<StorageBrowser project={project} />)
				: <><CloudService projectRef={cloud!.ref} service="storage" onState={setProductOn} />{productOn && whenRunning(<StorageBrowser project={project} />)}</>;
		case 'dataApi':
			return <DataApiSection project={project} settings={local ? <LocalDataApiSwitch row={local} /> : <CloudService projectRef={cloud!.ref} service="dataApi" />} />;
		case 'functions':
			return local ? <LocalFunctions row={local} /> : <CloudFunctionsSection projectRef={cloud!.ref} />;
		case 'containers':
			return cloud
				? <ContainersSection projectRef={cloud.ref} />
				: (
					<fieldset>
						<legend>Containers</legend>
						<p className="field-hint">A container is your own image, running beside the project for as long as it runs. Containers run on SnoutData Cloud only: a local project has no container runner. Run your image with your own Docker beside it, or copy this project to the cloud from Settings.</p>
					</fieldset>
				);
		case 'realtime':
			return <RealtimeSection project={project} />;
		case 'push':
			return local ? <LocalPush /> : <CloudService projectRef={cloud!.ref} service="push" />;
		case 'logs':
			return local
				? <LocalLogs row={local} />
				: (
					<>
						<p className="field-hint">The project's activity log (every change, by whom) is on the dashboard. Postgres's own record of the statements it has run is here.</p>
						{whenRunning(<PostgresStatements target={project.target} />)}
					</>
				);
		case 'shards':
			return cloud ? <ShardsSection projectRef={cloud.ref} /> : <p className="field-hint">A cluster is for SnoutData Cloud projects.</p>;
		case 'domains':
			return local ? <LocalDomains row={local} /> : <CloudDomainsSection projectRef={cloud!.ref} />;
		case 'settings':
			return local
				? <><CopyProject local onCopy={props.onCopy} /><LocalSettingsSection row={local} onChanged={props.onChanged} onRemoved={props.onClosed} /></>
				: <><CopyProject local={false} onCopy={props.onCopy} /><CloudBackupsSection projectRef={cloud!.ref} /><CloudDelete row={cloud} onDeleted={props.onClosed} /></>;
		default:
			return null;
	}
}


/** Copy the whole project to the other side (shared/projectCopy.ts). The work is its own tab. */
function CopyProject(props: { local: boolean; onCopy(): void }): JSX.Element {
	return (
		<fieldset>
			<legend>{props.local ? "Copy to SnoutData Cloud" : "Copy to this computer"}</legend>
			<p className="field-hint">
				{props.local
					? "Users, database, files, functions and their secrets, into a new or existing cloud project. This project stays as it is."
					: "Users, database and files, into a local project. This project stays as it is."}
			</p>
			<div className="cloud-actions">
				<button type="button" onClick={props.onCopy}><Icon name={props.local ? 'cloud-upload' : 'cloud-download'} /> {props.local ? "Copy to Cloud…" : "Copy to this computer…"}</button>
			</div>
		</fieldset>
	);
}
