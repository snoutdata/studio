/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { AGENT_KINDS, isAgentKind, type AgentConsoleConfig, type AgentKind, type AgentPreference } from '../shared/agentConsole';
import { alwaysAsksByName } from '../shared/capabilities';

// Non-secret settings for the agent console → userData/agents.json.
// Nothing here is a credential: the MCP bearer token stays in mcp.json where it already lives, and
// no DB secret is ever involved.
//
// baseDir is a constructor argument so the store is node-testable without Electron (the FlowStore
// pattern).

function defaults(): AgentConsoleConfig {
	return { lastKind: 'claude', allowMutatingCapabilities: false, routeDatabaseThroughApp: true, paths: {}, agents: {}, autoApproveCapabilities: [] };
}

export class AgentConsoleStore {
	private cache: AgentConsoleConfig | null = null;

	constructor(private readonly userDataDir: string) {}

	private path(): string {
		return join(this.userDataDir, 'agents.json');
	}

	private read(): AgentConsoleConfig {
		if (this.cache) {
			return this.cache;
		}
		const config = defaults();
		const path = this.path();
		if (existsSync(path)) {
			try {
				const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<AgentConsoleConfig>;
				if (typeof raw.lastKind === 'string' && isAgentKind(raw.lastKind)) {
					config.lastKind = raw.lastKind;
				}
				// Only an explicit `true` opens the mutating path. A corrupt or partial file must
				// fail closed, never open.
				config.allowMutatingCapabilities = raw.allowMutatingCapabilities === true;
				// The mirror image of the switch above, and deliberately so: this one is not a
				// permission, it is how integrated the console is, and the integrated launch is
				// what the feature IS. So only an explicit `false` opts out, and a corrupt file
				// gets the integrated default rather than an agent quietly running loose.
				config.routeDatabaseThroughApp = raw.routeDatabaseThroughApp !== false;
				// Same fail-closed reading as the switch above: anything that is not a list of
				// strings grants nothing, so a corrupt file cannot hand out a standing yes.
				if (Array.isArray(raw.autoApproveCapabilities)) {
					// A standing yes for something asked about every time (running SQL) is never kept,
					// even one stored before it was.
					config.autoApproveCapabilities = raw.autoApproveCapabilities.filter((name): name is string => typeof name === 'string' && name.length > 0 && !alwaysAsksByName(name));
				}
				if (raw.agents && typeof raw.agents === 'object') {
					for (const kind of AGENT_KINDS) {
						const pref = (raw.agents as Record<string, unknown>)[kind];
						if (pref && typeof pref === 'object') {
							const { enabled, firstSeenAt } = pref as AgentPreference;
							config.agents[kind] = {
								// Only a real boolean counts as a decision. Anything else is "not decided",
								// which is what lets a later discovery turn the agent on.
								enabled: typeof enabled === 'boolean' ? enabled : undefined,
								firstSeenAt: typeof firstSeenAt === 'number' ? firstSeenAt : undefined,
							};
						}
					}
				}
				if (raw.paths && typeof raw.paths === 'object') {
					for (const kind of AGENT_KINDS) {
						const value = (raw.paths as Record<string, unknown>)[kind];
						if (typeof value === 'string' && value.length > 0) {
							config.paths[kind] = value;
						}
					}
				}
			} catch {
				// Corrupt file: defaults, and the next write repairs it.
			}
		}
		this.cache = config;
		return config;
	}

	private write(config: AgentConsoleConfig): void {
		this.cache = config;
		const path = this.path();
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, JSON.stringify(config, null, 2), 'utf8');
	}

	config(): AgentConsoleConfig {
		const config = this.read();
		return { ...config, paths: { ...config.paths }, agents: { ...config.agents }, autoApproveCapabilities: [...config.autoApproveCapabilities] };
	}

	/** What the user has said about this agent (an empty object ⇒ they have not said anything). */
	preference(kind: AgentKind): AgentPreference {
		return this.read().agents[kind] ?? {};
	}

	/** True once the user has turned this agent on or off. Until then we may decide for them. */
	hasDecided(kind: AgentKind): boolean {
		return typeof this.preference(kind).enabled === 'boolean';
	}

	/** Whether the agent should appear (given it is installed). Undecided reads as off until
	 *  {@link noteDetected} turns it on, which is what makes the first sighting the trigger. */
	isEnabled(kind: AgentKind): boolean {
		return this.preference(kind).enabled === true;
	}

	/** The user turning an agent on or off by hand. This is the decision that sticks: an agent
	 *  switched off here is never auto-shown again, however often it is found. */
	setEnabled(kind: AgentKind, enabled: boolean): void {
		const config = this.read();
		const agents = { ...config.agents, [kind]: { ...config.agents[kind], enabled } };
		this.write({ ...config, agents });
	}

	/**
	 * We just found this agent installed. Returns true if this is the FIRST time and we therefore
	 * turned it on for the user.
	 *
	 * The whole point of the undecided state: someone who installs Codex three months from now gets
	 * it offered then, without us having to ask on the off-chance at first run; and someone who
	 * switched it off keeps it off, because a decision outranks a discovery.
	 */
	noteDetected(kind: AgentKind, now: number): boolean {
		const config = this.read();
		const pref = config.agents[kind] ?? {};
		if (typeof pref.enabled === 'boolean') {
			return false; // They have decided. Their decision stands, either way.
		}
		const agents = { ...config.agents, [kind]: { enabled: true, firstSeenAt: pref.firstSeenAt ?? now } };
		this.write({ ...config, agents });
		return true;
	}

	lastKind(): AgentKind {
		return this.read().lastKind;
	}

	setLastKind(kind: AgentKind): void {
		this.write({ ...this.read(), lastKind: kind });
	}

	/** Does this console launch its agent under the app's house rules: our MCP tools only, the
	 *  local database clients denied, results drawn in the app? */
	routesDatabaseThroughApp(): boolean {
		return this.read().routeDatabaseThroughApp;
	}

	setRouteDatabaseThroughApp(route: boolean): void {
		this.write({ ...this.read(), routeDatabaseThroughApp: route });
	}

	allowsMutatingCapabilities(): boolean {
		return this.read().allowMutatingCapabilities;
	}

	setAllowMutatingCapabilities(allowed: boolean): void {
		const config = this.read();
		// Turning the door off forgets what was let through it. Leaving stale grants behind would
		// mean switching the feature back on silently re-opens everything the user ever allowed,
		// which is not what "off" looked like when they chose it.
		this.write({ ...config, allowMutatingCapabilities: allowed, autoApproveCapabilities: allowed ? config.autoApproveCapabilities : [] });
	}

	/** Has the user already said "always allow" to this capability? */
	isAutoApproved(name: string): boolean {
		return this.read().autoApproveCapabilities.includes(name);
	}

	/** Remember (or forget) a standing yes for one capability. */
	setAutoApproved(name: string, approved: boolean): void {
		const config = this.read();
		const names = new Set(config.autoApproveCapabilities);
		if (approved && alwaysAsksByName(name)) {
			return;
		}
		if (approved) {
			names.add(name);
		} else if (!names.delete(name)) {
			return;
		}
		this.write({ ...config, autoApproveCapabilities: [...names] });
	}

	/** Remember (or forget) a standing yes for a whole set at once, in ONE write. Ticking twenty
	 *  actions one call at a time would leave the store half-granted if anything went wrong in the
	 *  middle, and would fan out twenty disk writes for one click. */
	setAutoApprovedAll(names: string[], approved: boolean): void {
		const config = this.read();
		const current = new Set(config.autoApproveCapabilities);
		for (const name of names) {
			if (approved && alwaysAsksByName(name)) {
				continue;
			}
			if (approved) {
				current.add(name);
			} else {
				current.delete(name);
			}
		}
		const next = [...current];
		if (next.length === config.autoApproveCapabilities.length && next.every((name) => config.autoApproveCapabilities.includes(name))) {
			return;
		}
		this.write({ ...config, autoApproveCapabilities: next });
	}

	/** Forget every standing yes, so the app asks about everything again. */
	clearAutoApproved(): void {
		const config = this.read();
		if (config.autoApproveCapabilities.length > 0) {
			this.write({ ...config, autoApproveCapabilities: [] });
		}
	}

	pinnedPath(kind: AgentKind): string | undefined {
		return this.read().paths[kind];
	}

	setPinnedPath(kind: AgentKind, path: string | undefined): void {
		const config = this.read();
		const paths = { ...config.paths };
		if (path && path.length > 0) {
			paths[kind] = path;
		} else {
			delete paths[kind];
		}
		this.write({ ...config, paths });
	}
}
