/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Icon } from './Icon';
import { useT } from '../i18n';
import { flavorFor } from '../../../shared/engine';
import type { ImportItem } from '../../../shared/forms';

// One importable connection in a picker: the tick, the name, the tags (already added, credentials,
// environment) and the line under it. Shared by the import picker and first-run discovery, so the
// two screens cannot drift apart.

const DRIVER_LABEL: Record<string, string> = {
	'mysql-aurora': "MySQL",
	mariadb: "MariaDB",
	postgres: "PostgreSQL",
	sqlserver: "SQL Server",
	oracle: "Oracle",
	db2: "Db2",
	sqlite: "SQLite",
	duckdb: "DuckDB",
	redshift: "Redshift",
	hana: "SAP HANA",
	clickhouse: "ClickHouse",
	mongodb: "MongoDB",
	snowflake: "Snowflake",
};

interface ImportRowProps {
	item: ImportItem;
	checked: boolean;
	onToggle(): void;
	/** The tag for a duplicate ("already added"; the cloud says it will update instead). */
	duplicateLabel?: string;
}

export function ImportRow({ item, checked, onToggle, duplicateLabel }: ImportRowProps): JSX.Element {
	const t = useT();
const v = item.values;
	const fileBased = v.driver === 'sqlite' || v.driver === 'duckdb';
	return (
		<label className={`import-row${item.supported ? '' : ' unsupported'}`} title={item.note}>
			<input type="checkbox" disabled={!item.supported} checked={checked} onChange={onToggle} />
			<div className="import-row-text">
				<div className="import-row-name">
					{item.sourceName}
					{item.duplicate && <span className="import-tag">{duplicateLabel ?? t('connections.import.alreadyAdded')}</span>}
					{item.supported && item.importsPassword && <span className="import-tag" title={t('connections.import.credentialsTitle')}><Icon name="key" /> {t('connections.import.credentials')}</span>}
					{item.tentative && <span className="import-tag" title={t('connections.import.unconfirmedTitle')}>{t('connections.import.unconfirmed')}</span>}
					{v.environment && <span className={`env${v.environment === 'prod' ? ' prod' : ''}`}>{v.environment}</span>}
				</div>
				<div className="muted small">
					{item.supported ? (
						<>
							{flavorFor(v.driver, v.flavor)?.displayName ?? DRIVER_LABEL[v.driver] ?? v.driver}
							{' · '}{fileBased ? (v.database || t('connections.import.noFile')) : `${v.host || t('connections.import.noHost')}${v.port ? `:${v.port}` : ''}`}
							{!fileBased && v.database ? ` · ${v.database}` : ''}
							{v.ssh ? ' · SSH' : ''}
							{item.note ? ` · ${item.note}` : ''}
						</>
					) : (item.note ?? t('connections.import.unsupported'))}
				</div>
			</div>
		</label>
	);
}
