/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ConnectionFormValues, ImportItemRef, ImportScanResult } from '../../shared/forms';
import type { ConnectionConfig } from '../../shared/connection';
import { toScanResult, type Found } from './common';
import { probePort, type ProbeOutcome } from './probe';
import { PROBE_PORTS, type ProbePort } from './sniff';

// Databases running on this computer, found by asking each well-known port what it is
// (`sniff.ts`). A server that answers is offered with its engine's default username; one that is
// merely open is offered as a guess and left unselected. Nothing here knows a password, and every
// note says so. The ref carries no secret: `file` is the host, `connId` is `driver:port[:name]`,
// and the values are rebuilt from it at apply time.

export const LOCALHOST = '127.0.0.1';

const ENGINE_NAME: Record<string, string> = {
	postgres: "PostgreSQL",
	'mysql-aurora': "MySQL",
	mariadb: "MariaDB",
	sqlserver: "SQL Server",
	oracle: "Oracle",
	clickhouse: "ClickHouse",
	mongodb: "MongoDB",
	db2: "Db2",
	hana: "SAP HANA",
};

const DEFAULT_USER: Record<string, string> = {
	postgres: 'postgres', 'mysql-aurora': 'root', mariadb: 'root', sqlserver: 'sa', oracle: 'system', clickhouse: 'default', db2: 'db2inst1', hana: 'SYSTEM',
};

export function engineName(driver: string): string {
	return ENGINE_NAME[driver] ?? driver;
}

/** The values a probed endpoint becomes. Pure, and the same at scan and at apply. */
export function probedValues(host: string, driver: string, port: number, name?: string): ConnectionFormValues {
	const where = name ?? (host === LOCALHOST ? 'localhost' : host);
	return {
		label: `${engineName(driver)} on ${where}:${port}`,
		driver,
		host: host === LOCALHOST ? 'localhost' : host,
		port,
		username: DEFAULT_USER[driver] ?? '',
		ssl: false,
		readOnly: false,
	};
}

/** What a probe outcome offers, or null when nothing is there. Pure. */
export function foundFromProbe(host: string, spec: ProbePort, outcome: ProbeOutcome, name?: string, lead?: string): Found | null {
	if (outcome.kind === 'closed') {
		return null;
	}
	const driver = outcome.kind === 'answered' ? outcome.verdict.driver : spec.driver;
	const values = probedValues(host, driver, spec.port, name);
	const notes: string[] = [];
	if (lead) {
		notes.push(lead);
	} else if (outcome.kind === 'answered') {
		notes.push(`${outcome.verdict.product ?? engineName(driver)} answered on port ${spec.port}.`);
		if (outcome.verdict.note) {
			notes.push(outcome.verdict.note);
		}
	} else {
		notes.push(`Port ${spec.port} is open, the usual port for ${engineName(driver)}, but it did not say what it is.`);
	}
	notes.push(values.username ? `No password is known; set it after import (the username is ${engineName(driver)}'s default).` : "No username or password is known; set them after import.");
	return {
		ref: { file: host, connId: name ? `${driver}:${spec.port}:${name}` : `${driver}:${spec.port}` },
		values,
		sourceName: values.label,
		supported: true,
		importsPassword: false,
		tentative: outcome.kind === 'open' || undefined,
		note: notes.join(' '),
	};
}

/** Rebuild a probed endpoint's values from its ref. Pure. */
export function valuesFromProbeRef(ref: ImportItemRef): ConnectionFormValues | null {
	const m = /^([\w-]+):(\d+)(?::(.*))?$/.exec(ref.connId);
	if (!m || !ENGINE_NAME[m[1]]) {
		return null;
	}
	return probedValues(ref.file, m[1], Number(m[2]), m[3] || undefined);
}

/** Probe every well-known port on this computer. */
export async function scanLocal(existing: ConnectionConfig[], timeoutMs = 600): Promise<ImportScanResult> {
	const outcomes = await Promise.all(PROBE_PORTS.map((spec) => probePort(LOCALHOST, spec, timeoutMs)));
	const found = outcomes
		.map((o, i) => foundFromProbe(LOCALHOST, PROBE_PORTS[i], o))
		.filter((f): f is Found => f !== null);
	return toScanResult('local', found.length > 0 ? [`${LOCALHOST} (this computer)`] : [], found, existing);
}

export function resolveProbeImport(refs: ImportItemRef[]): ConnectionFormValues[] {
	return refs.map(valuesFromProbeRef).filter((v): v is ConnectionFormValues => v !== null);
}
