/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ConnectionConfig } from '../../shared/connection';
import type { AmbientFlowWizard } from '../../shared/ai';

/*---------------------------------------------------------------------------------------------
 *  The seam between Studio's renderer and Data Flows' renderer half.
 *
 *  Data Flows is private. The app reaches its renderer half only through `@snout/studio-pro/*`:
 *  `/renderer` (the light entry: the Flows panel, the status-bar reading, the run notices, the
 *  capabilities), the code-split views `/wizard`, `/vector-search` and `/settings`, and `/styles`
 *  (its stylesheet, imported by main.tsx after the shell's). A build
 *  without it compiles packages/studio-pro-stub/renderer instead, which implements these same
 *  props with a placeholder. This file is all the two sides share, so it is open.
 *--------------------------------------------------------------------------------------------*/

/** The Flows side view. */
export interface ProFlowsPanelProps {
	connections: ConnectionConfig[];
	settingsRev: number;
	onOpen(flowId: string): void;
	onNew(): void;
	onSearch(flowId: string): void;
	onOpenModel(page: 'setup' | 'record' | 'review'): void;
	/** A failed run handed to the assistant, the way a failed query is. */
	onExplain(request: { prompt: string; error: string; connectionId?: string }): void;
	onCollapse(): void;
}

/** The status bar's Data Flows readings. */
export interface ProStatusItemsProps {
	/** Open Settings on the page that explains what is running. */
	onOpenEngine(): void;
}

/** What the app hands Data Flows for importing a flow file from the palette. */
export interface ProImportHost {
	openFlow(options: { flowId: string }): void;
}

/** The flow wizard tab. */
export interface ProFlowWizardProps {
	connections: ConnectionConfig[];
	connectedIds: string[];
	initialPath?: string;
	flowId?: string;
	defaultConnectionId?: string;
	active: boolean;
	scheduledFlowsAllowed: boolean;
	generatePanelWidth: number;
	onGeneratePanelResize(dx: number): void;
	onOpenAccount(): void;
	onOpenExtractionModel(): void;
	onOpenCloudStorage(): void;
	settingsRev: number;
	onRan(connectionId: string): void;
	onAmbient?(summary: AmbientFlowWizard | null): void;
	guided: boolean;
	onGuidedChange(guided: boolean): void;
	onClose(): void;
}

/** The vector search tab. */
export interface ProVectorSearchProps {
	flowId: string;
	connections: ConnectionConfig[];
	onFlowChange(flowId: string): void;
	onClose(): void;
}

/** A page of Data Flows' own Settings section for a signpost to open on, named by Data Flows. */
export type ProEnginePage = string;
