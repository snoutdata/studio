/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Icon } from './Icon';
import type { ConnectionConfig } from '../../../shared/connection';
import { engineDisplayName } from '../../../shared/engine';
import { driverKind } from '../driverKind';

// How a connection is marked wherever it is listed: the sidebar's row and the connection pickers
// draw these same pieces, so a PROD tag or a driver glyph cannot be on one and missing from the
// other.

/** "PostgreSQL (relational)": the driver mark's tooltip. */
export function driverTitle(driverId: string, flavor?: string): string {
	return `${engineDisplayName(driverId, flavor)} (${driverKind(driverId).group.toLowerCase()})`;
}

/** The status dot and, beside it, what KIND of backend this is. */
export function ConnectionMarks({ config, connected }: { config: ConnectionConfig; connected: boolean }): JSX.Element {
	const isProd = config.environment === 'prod';
	return (
		<>
			<span className={`dot${connected ? ' on' : ''}${isProd ? ' prod' : ''}`}><Icon name="circle-filled" /></span>
			{/* The same mark the connection form's driver picker uses, from the same definition. It
			    stays dim: the dot carries the state and the label carries the identity, and a third
			    thing competing with either would make the row harder to scan, not easier. */}
			{config.cloudProjectRef || config.localProjectId
				? <span className="tree-icon driver-mark" title={`${config.localProjectId ? "SnoutData local project" : "SnoutData Cloud"} (${driverTitle(config.driver, config.flavor)})`}><Icon name="glyph:butterfly" /></span>
				: <span className="tree-icon driver-mark" title={driverTitle(config.driver, config.flavor)}><Icon name={driverKind(config.driver).icon} /></span>}
		</>
	);
}

/** The environment tag (PROD in its warning colour) and the read-only tag, after the name. */
export function ConnectionTags({ config }: { config: ConnectionConfig }): JSX.Element {
	const isProd = config.environment === 'prod';
	return (
		<>
			{config.environment && <span className={`env${isProd ? ' prod' : ''}`}>{config.environment}</span>}
			{config.readOnly && <span className="env ro" title="Read-only connection. Writes and DDL are blocked.">RO</span>}
		</>
	);
}
