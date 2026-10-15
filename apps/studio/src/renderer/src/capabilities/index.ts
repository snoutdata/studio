/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CapabilityHandler } from './registry';
import { appStateCapabilities } from './appState';
import { connectionCapabilities } from './connections';
import { tunnelCapabilities } from './tunnels';
import { workspaceCapabilities } from './workspace';
import { schemaCapabilities } from './schema';
import { settingsCapabilities } from './settings';
import { editorCapabilities } from './editor';
import { knowledgeCapabilities } from './knowledge';
import { resultCapabilities } from './results';
import { logCapabilities } from './logs';
import { flowCapabilities } from '@snout/studio-pro/capabilities';
import { notifyCapabilities } from './notify';
import { canvasCapabilities } from './canvas';
import { monitorCapabilities } from './monitors';
import { securityCapabilities } from './security';
import { orbitCapabilities } from './orbit';
import { cloudCapabilities } from './cloud';
import { shardsCapabilities } from './shards';

export { capabilityRegistry } from './registry';
export type { AppCapabilityBridge, AppSnapshot, CapabilityContext, CapabilityHandler } from './registry';

/**
 * The always-available capabilities, registered once at App init. Component-scoped capabilities
 * (ones that only make sense while a particular view is mounted) should use `useCapabilities`
 * instead. Adding a new module's capabilities to the assistant is just adding it to this list.
 */
export const staticCapabilities: CapabilityHandler[] = [
	...appStateCapabilities,
	...connectionCapabilities,
	...tunnelCapabilities,
	...workspaceCapabilities,
	...schemaCapabilities,
	...settingsCapabilities,
	...editorCapabilities,
	...knowledgeCapabilities,
	...resultCapabilities,
	...logCapabilities,
	...flowCapabilities,
	...notifyCapabilities,
	...canvasCapabilities,
	...monitorCapabilities,
	...securityCapabilities,
	...orbitCapabilities,
	...cloudCapabilities,
	...shardsCapabilities,
];
