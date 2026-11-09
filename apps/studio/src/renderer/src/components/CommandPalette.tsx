/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useState } from 'react';

import { useT } from '../i18n';
import { ASSISTANT_NAME } from '../../../shared/assistant';
import { translate, type Vars } from '../../../shared/i18n/core';

export interface Command {
	id: string;
	label: string;
	/** Where the English of this label is, when it is not `commands.<id>`. */
	labelKey?: string;
	labelVars?: Vars;
	hint?: string;
	run(): void;
}

/** A command's label in English, or undefined when it has none in the catalog (the Dev: entries). */
function englishLabel(command: Command): string | undefined {
	const key = command.labelKey ?? `commands.${command.id}`;
	const english = translate('en', key, { assistant: ASSISTANT_NAME, ...command.labelVars });
	return english === key ? undefined : english;
}

/** A search matches the label on screen, and the English one, so a shortcut or a habit from an English setup still finds it. */
function matches(command: Command, needle: string): boolean {
	return command.label.toLowerCase().includes(needle) || (englishLabel(command)?.toLowerCase().includes(needle) ?? false);
}

interface CommandPaletteProps {
	commands: Command[];
	onClose(): void;
}

/** VSCode-style command launcher: filter by label, arrow keys to move, Enter to run. */
export function CommandPalette({ commands, onClose }: CommandPaletteProps): JSX.Element {
	const t = useT();
	const [query, setQuery] = useState('');
	const [index, setIndex] = useState(0);

	const filtered = commands.filter((c) => matches(c, query.toLowerCase()));
	const selected = Math.min(index, Math.max(0, filtered.length - 1));

	function choose(command: Command | undefined): void {
		if (command) {
			onClose();
			command.run();
		}
	}

	return (
		<div className="modal-backdrop palette-backdrop" onClick={onClose}>
			<div className="palette" onClick={(e) => e.stopPropagation()}>
				<input
					autoFocus
					value={query}
					placeholder={t('shell.palette.placeholder')}
					onChange={(e) => { setQuery(e.target.value); setIndex(0); }}
					onKeyDown={(e) => {
						if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, filtered.length - 1)); }
						else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
						else if (e.key === 'Enter') { e.preventDefault(); choose(filtered[selected]); }
						else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
					}}
				/>
				<div className="palette-list">
					{filtered.length === 0 && <div className="muted pad">{t('shell.palette.noMatch')}</div>}
					{filtered.map((command, i) => (
						<div
							key={command.id}
							className={`palette-item${i === selected ? ' active' : ''}`}
							onMouseEnter={() => setIndex(i)}
							onClick={() => choose(command)}
						>
							<span>{command.label}</span>
							{command.hint && <span className="muted">{command.hint}</span>}
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
