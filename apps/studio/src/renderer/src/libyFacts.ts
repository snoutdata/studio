/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What Studio tells Liby: the facts about the app she reads, and the shape of what she hands back.
// These are the app's side of her (the interface), so they are Studio's and open source. Liby
// herself, everything she says and how she behaves here, is in the private package
// (`@snout/liby/studio`), which imports these. A build without that package
// gets `packages/liby-stub` instead, built against the same types.

import type { LibyEvent, LibyMood } from '@snout/liby';
import type { ErrorClass } from '../../shared/engine';
import type { ChecklistTaskId } from './onboarding';

// ---- Her events -------------------------------------------------------------------------------------

/** Everything she reacts to in Studio: her own events (@snout/liby) and Studio's. */
export type StudioEvent =
	| LibyEvent
	| { kind: 'query-ok'; rows: number; ms: number; changed: boolean; sql?: string }
	| { kind: 'query-error'; errorClass: ErrorClass }
	| { kind: 'connection-ok'; label?: string; production?: boolean }
	| { kind: 'connection-error' }
	/** Any other error the notifications center recorded (an export, a flow, sign-in). */
	| { kind: 'error' }
	| { kind: 'saved' };

// ---- The connection form ----------------------------------------------------------------------------

export type FormShape = 'server' | 'file' | 'account' | 'vector' | 'logs' | 'uri';

/** What the connection form holds right now. */
export interface FormFacts {
	edit: boolean;
	label: string;
	driver: string;
	driverName: string;
	defaultPort?: number;
	host: string;
	port: string;
	database: string;
	username: string;
	environment: string;
	ssl: boolean;
	shape: FormShape;
	/** Whether the driver was chosen by the user in this form (not the default it opened on). */
	driverPicked: boolean;
}

/** A database found on this computer (discovery's docker and local sources) and not yet saved. */
export interface FoundDb {
	where: 'docker' | 'local';
	/** The container's name, or what the port answered as. */
	name: string;
	driverName: string;
	port: number;
	/** Discovery could not confirm what it is (an open port that did not say). */
	tentative: boolean;
}

// ---- A query, a statement, a table ------------------------------------------------------------------

/** The part of a schema she reads: table names and their columns. */
export interface SchemaGlance {
	tables: { name: string; columns: string[] }[];
}

export interface RiskyFacts {
	verb: string;
	/** An UPDATE/DELETE with no WHERE (or an always-true one). */
	unfiltered: boolean;
	production: boolean;
	/** Whether the app will stop and confirm it (prod, with the confirm setting on). */
	confirms: boolean;
	/** The table it writes, when known. */
	table?: string;
	label?: string;
}

export interface TableFacts {
	name: string;
	columns: number;
	primaryKey: string[];
	/** Tables its foreign keys point at. */
	references: string[];
	/** Tables whose foreign keys point at it. */
	referencedBy: string[];
	rows?: number;
}

// ---- The SQL editor and its results -----------------------------------------------------------------

export type ResultFacts =
	| { ok: true; rows: number; columns: string[]; ms?: number; sql: string }
	| { ok: false; error: string; sql?: string };

export interface EditorFacts {
	/** Whether a connection is open for this tab. */
	connected: boolean;
	/** How many connections exist at all. */
	connections: number;
	connectionLabel?: string;
	/** The whole buffer. */
	sql: string;
	/** The statement under the caret (or the selection). */
	statement?: string;
	risky?: RiskyFacts | null;
	/** The first thing the static advisor (sargability) found in that statement. */
	advisory?: string;
	result?: ResultFacts;
	schema?: SchemaGlance | null;
	/** The run and inline-edit shortcuts as this platform writes them ("Ctrl+Enter"). */
	runKey: string;
	editKey: string;
}

export interface SidebarFacts {
	connections: number;
	connected: number;
}

// ---- What she hands back ----------------------------------------------------------------------------

/** Something she can do about it, offered as a button in her bubble. */
export type HelpAction =
	/** Send a question to the Liby panel (it opens, grounded in the screen). */
	| { kind: 'ask'; label: string; prompt: string }
	/** The palette command of that id. */
	| { kind: 'command'; label: string; id: string }
	/** "Liby: Fix Last Error". */
	| { kind: 'fix'; label: string }
	/** A screen's own action (a component that registered a helper knows how to do it). */
	| { kind: 'do'; label: string; run: () => void };

export interface HelpMove {
	line: string;
	mood: LibyMood;
	actions?: HelpAction[];
}

// ---- Moments ----------------------------------------------------------------------------------------

export type MomentId = 'launch' | 'welcome' | ChecklistTaskId | 'allDone';

export interface Moment {
	id: MomentId;
	/** A greeting repeats every launch; a milestone shows once. */
	kind: 'greeting' | 'milestone';
	/** A `data-tour="…"` anchor to land on. Absent, or not on screen: where the user is. */
	anchor?: string;
	/** Her face when she says it. */
	mood?: LibyMood;
	message: string;
}

export interface MomentSwitches {
	/** Settings → "Hide Liby" (the setting keeps its old name). */
	disableMascot: boolean;
	/** Settings → "Disable onboarding tips". */
	disableOnboarding: boolean;
}

// ---- The first-run tour --------------------------------------------------------------------------

/** The tour's steps, by the `data-tour` anchor each points at (`welcome` is the centred first card). */
export type TourStepId = 'welcome' | 'activity-bar' | 'add-connection' | 'editor' | 'run-button' | 'results' | 'ai-assistant';

/** A tour step's words. With a `LibyMood`, the companion (`@snout/liby`) presents the step wearing that
 *  face. Without one, the card is the app's own. */
export interface TourCopy {
	title: string;
	body: string;
	mood?: LibyMood;
}
