/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useMemo, useState } from 'react';

import { nodePath, valueTree, type ValueNode } from '../../../shared/cellValue';
import { Icon } from './Icon';

// One cell's value as a TREE, for the columnar and document types a single grid line cannot show:
// ClickHouse's Array / Map / Tuple / Nested / JSON / Variant / Dynamic, Postgres arrays and jsonb,
// a Mongo document. The model is pure (`shared/cellValue.ts`); this draws it.
//
// Two things make it worth opening rather than reading the JSON:
//  - every node carries its DECLARED type when the driver gave one, so a `Tuple(id UInt64, …)`
//    reads as fields with types rather than as an object with keys;
//  - every node knows the SQL path that reads it (`payload.items[0].name`), which is what a person
//    wants next, and copying it is one click.

interface CellValueTreeProps {
	/** The raw value from the driver (an array, an object, or a string holding JSON). */
	value: unknown;
	/** The column's declared type, when there is one. It only ever adds names and types. */
	dataType?: string;
	/** The column name, which is the root of every path. */
	columnName: string;
}

/**
 * A branch this size or smaller starts OPEN, at any depth, and a bigger one waits to be asked for.
 * Depth alone is the wrong rule: a three-key object nested four deep is exactly what a reader came
 * for, and a ten-thousand-element array is not, whatever depth it sits at.
 */
const OPEN_UNDER = 60;

export function CellValueTree({ value, dataType, columnName }: CellValueTreeProps): JSX.Element {
	const root = useMemo(() => valueTree(value, dataType, columnName), [value, dataType, columnName]);
	// The paths whose open state the reader has FLIPPED from the default above.
	const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set());
	const [copied, setCopied] = useState<string | null>(null);

	function toggle(path: string): void {
		setFlipped((prev) => {
			const next = new Set(prev);
			if (!next.delete(path)) {
				next.add(path);
			}
			return next;
		});
	}

	function copyPath(path: string, keys: string[]): void {
		void navigator.clipboard.writeText(nodePath(keys, columnName));
		setCopied(path);
		window.setTimeout(() => setCopied((current) => (current === path ? null : current)), 1200);
	}

	return (
		<div className="value-tree" role="tree">
			<TreeRow node={root} keys={[]} depth={0} flipped={flipped} copied={copied} onToggle={toggle} onCopyPath={copyPath} />
		</div>
	);
}

interface TreeRowProps {
	node: ValueNode;
	keys: string[];
	depth: number;
	flipped: ReadonlySet<string>;
	copied: string | null;
	onToggle(path: string): void;
	onCopyPath(path: string, keys: string[]): void;
}

function TreeRow({ node, keys, depth, flipped, copied, onToggle, onCopyPath }: TreeRowProps): JSX.Element {
	const path = keys.join('\u0000');
	const children = node.children;
	const isOpen = children !== undefined && (depth === 0 || node.size <= OPEN_UNDER) !== flipped.has(path);

	return (
		<>
			<div className="value-row" style={{ paddingLeft: 6 + depth * 14 }} role="treeitem" aria-expanded={children ? isOpen : undefined}>
				{children ? (
					<button type="button" className="value-twisty" onClick={() => onToggle(path)} title={isOpen ? "Collapse" : "Expand"}>
						<Icon name={isOpen ? 'chevron-down' : 'chevron-right'} />
					</button>
				) : (
					<span className="value-twisty" />
				)}
				<span className="value-key">{node.key}</span>
				{node.type && <span className="value-type">{node.type}</span>}
				{children ? (
					<span className="value-count">{summary(node)}</span>
				) : node.isNull ? (
					<span className="value-null">NULL</span>
				) : (
					<span className="value-leaf">{node.text}</span>
				)}
				<span className="spacer" />
				<button type="button" className="value-copy" title="Copy the path that reads this" onClick={() => onCopyPath(path, keys)}>
					<Icon name={copied === path ? 'check' : 'copy'} />
				</button>
			</div>
			{children && isOpen && children.map((child, index) => (
				<TreeRow
					key={`${child.key}-${index}`}
					node={child}
					keys={[...keys, child.key]}
					depth={depth + 1}
					flipped={flipped}
					copied={copied}
					onToggle={onToggle}
					onCopyPath={onCopyPath}
				/>
			))}
		</>
	);
}

/** `3 items` / `2 keys`, said of a branch we have already walked. */
function summary(node: ValueNode): string {
	const count = node.children?.length ?? 0;
	if (node.kind === 'array') {
		return count === 1 ? "1 item" : `${count} items`;
	}
	return count === 1 ? "1 key" : `${count} keys`;
}
