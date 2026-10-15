/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useState } from 'react';
import { monaco } from '../monaco';

/** Syntax-highlighted code, painted with the exact same tokenizer + theme colors as the
 *  editor (via Monaco's `colorize`). Falls back to plain text until colorization resolves.
 *  `lang` defaults to `sql`; document (MongoDB) connections pass `json` for proposed pipelines. */
export function SqlCode({ sql, lang = 'sql' }: { sql: string; lang?: string }): JSX.Element {
	const [html, setHtml] = useState<string | null>(null);
	useEffect(() => {
		let alive = true;
		void monaco.editor.colorize(sql, lang, { tabSize: 2 }).then((h) => {
			if (alive) {
				setHtml(h);
			}
		});
		return () => {
			alive = false;
		};
	}, [sql, lang]);
	if (html === null) {
		return <pre className="sql-code">{sql}</pre>;
	}
	return <pre className="sql-code" dangerouslySetInnerHTML={{ __html: html }} />;
}
