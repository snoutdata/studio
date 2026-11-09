/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useState } from 'react';
import { Icon } from './Icon';
import type { QueryParameter } from '../../../shared/engine';
import { useT } from '../i18n';

interface QueryParamsDialogProps {
	parameters: readonly QueryParameter[];
	/** What each was last given on this connection, to start from. */
	initial: Readonly<Record<string, string>>;
	onRun(values: Record<string, string>): void;
	onCancel(): void;
}

/** An example value in the form a type's parameter is written, shown until the person types. */
function example(type: string): string {
	const base = type.replace(/^(?:Nullable|LowCardinality)\((.*)\)$/, '$1');
	if (/^Array\(/.test(base)) {
		return /String|UUID|Date/.test(base) ? "['a', 'b']" : '[1, 2, 3]';
	}
	if (/^Map\(/.test(base)) {
		return "{'key': 1}";
	}
	if (/^Tuple\(/.test(base)) {
		return "(1, 'a')";
	}
	if (/^DateTime/.test(base)) {
		return '2026-01-31 12:00:00';
	}
	if (/^Date/.test(base)) {
		return '2026-01-31';
	}
	if (/^U?Int|^Float|^Decimal/.test(base)) {
		return '42';
	}
	if (base === 'Bool') {
		return 'true';
	}
	if (base === 'Identifier') {
		return 'table_name';
	}
	return '';
}

/**
 * The values for a statement's `{name:Type}` placeholders, asked before it runs. They are written
 * as the value itself, with no quotes (`O'Brien`, not `'O''Brien'`), since ClickHouse binds them on
 * the server with their types rather than pasting them into the SQL.
 */
export function QueryParamsDialog({ parameters, initial, onRun, onCancel }: QueryParamsDialogProps): JSX.Element {
	const t = useT();
	const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(parameters.map((p) => [p.name, initial[p.name] ?? ''])));

	function submit(e: React.FormEvent): void {
		e.preventDefault();
		onRun(values);
	}

	return (
		<div className="modal-backdrop" onClick={onCancel} onKeyDown={(e) => { if (e.key === 'Escape') { onCancel(); } }}>
			<form className="modal query-params" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
				<h2><Icon name="symbol-parameter" /> {t('editor.params.title')}</h2>
				<p className="confirm-detail">{t('editor.params.detail')}</p>
				<fieldset>
					{parameters.map((p, i) => (
						<label key={p.name} className="query-param">
							<span className="query-param-name">{p.name}<span className="muted">{p.type}</span></span>
							<input
								type="text"
								value={values[p.name] ?? ''}
								placeholder={example(p.type)}
								spellCheck={false}
								autoFocus={i === 0}
								aria-label={p.name}
								onChange={(e) => setValues((prev) => ({ ...prev, [p.name]: e.target.value }))}
							/>
						</label>
					))}
				</fieldset>
				<div className="modal-actions">
					<span className="spacer" />
					<button type="button" className="secondary" onClick={onCancel}><Icon name="close" /> {t('editor.common.cancel')}</button>
					<button type="submit"><Icon name="play" /> {t('editor.common.run')}</button>
				</div>
			</form>
		</div>
	);
}
