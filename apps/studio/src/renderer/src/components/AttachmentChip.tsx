/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Icon } from './Icon';
import type { DocumentAttachment } from '../../../shared/ai';

/*
 * One attached document, as a chip. Pulled out of ChatPanel.tsx when the render surface was
 * extracted: the composer shows a removable chip while a file is pending, and the surface shows a
 * static one under the turn that sent it, so two different components need the same chip.
 */

function chars(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k` : `${n}`;
}

/** The size/coverage sub-label under an attachment chip — shows how much of the file was sent so
 *  truncation is never silent (cost-legible, like the schema/token readouts). */
export function attachLabel(a: DocumentAttachment): string {
	return a.truncated
		? `excerpt · ${chars(a.text.length)} of ${chars(a.originalChars)} chars`
		: `${chars(a.originalChars)} chars`;
}

/** One attachment chip (pending in the composer, or shown under a sent user turn). With no
 *  `onRemove` it's a static display chip; with it, it carries a remove button. */
export function AttachmentChip({ att, onRemove }: { att: DocumentAttachment; onRemove?: () => void }): JSX.Element {
	return (
		<span className="chat-attach-chip" title={att.truncated ? `${att.name} (only an excerpt, ${att.coverage}, was sent to the assistant)` : att.name}>
			<Icon name="file-text" />
			<span className="chat-attach-name">{att.name}</span>
			<span className="chat-attach-size muted">{attachLabel(att)}</span>
			{onRemove && <button type="button" className="icon-btn" aria-label="Remove" onClick={onRemove}><Icon name="close" /></button>}
		</span>
	);
}
