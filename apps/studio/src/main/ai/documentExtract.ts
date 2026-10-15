/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';

import type { DocumentAttachment } from '../../shared/ai';
import { buildAttachment } from '../../shared/engine';

/**
 * Read a file the user attached to the chat and turn it into a size-capped
 * {@link DocumentAttachment} (see {@link buildAttachment}). Text formats (.txt/.md/.csv/.json/…)
 * are read as UTF-8; .pdf and .docx are parsed with pure-JS libraries (no native module). PDFs are
 * split into real pages so the digest samples across them. Runs in main, where Node + these libs
 * live; the renderer only hands over the path.
 */

/** Don't attempt to parse a file larger than this — a giant PDF/DOCX would be slow and the digest
 *  caps the output to a few KB regardless. Refused with a clear message before any parse. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** PDF/DOCX parsing pulls in @napi-rs/canvas + pdfjs-dist/mammoth, which are excluded from the
 *  Linux bundle to keep the .deb under GitHub's 100 MB host limit (see electron-builder.yml's
 *  linux.files + afterPackTrimLocales.cjs). So those two formats are parsed on Windows/macOS only;
 *  Linux keeps the plain-text formats. Gating here means the absent modules are never imported. */
const PARSED_SUPPORTED = process.platform !== 'linux';

/** The plain-text extensions read directly as UTF-8 (no parser needed). */
const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.text', '.sql', '.yaml', '.yml', '.xml']);

/** The extensions the attach picker advertises (text always; PDF/DOCX only where parseable). */
export const ATTACHABLE_EXTENSIONS = [...TEXT_EXTS, ...(PARSED_SUPPORTED ? ['.pdf', '.docx'] : [])].map((e) => e.slice(1));

async function readText(path: string): Promise<string> {
	return readFile(path, 'utf8');
}

/** Per-page text from a PDF via pdf-parse v2 (pdfjs under the hood). Imported lazily so the
 *  ~MB of pdfjs only loads when a PDF is actually attached. */
async function extractPdfPages(path: string): Promise<string[]> {
	const { PDFParse } = await import('pdf-parse');
	const data = new Uint8Array(await readFile(path));
	const parser = new PDFParse({ data });
	try {
		const result = await parser.getText();
		const pages = result.pages.map((p) => p.text);
		if (pages.some((p) => p.trim())) {
			return pages;
		}
		// No per-page text (scanned/image-only, or an odd PDF). Try the concatenated text, but strip
		// pdf-parse's injected "-- N of M --" page-boundary markers first, so a text-less PDF doesn't
		// masquerade as having content (it would otherwise extract to just those markers).
		const fallback = result.text.replace(PAGE_MARKER, '').trim();
		return fallback ? [fallback] : [];
	} finally {
		await parser.destroy();
	}
}

/** pdf-parse v2 injects a "-- N of M --" marker between pages in its concatenated text. It's a
 *  delimiter, not document content, so it's stripped before the text is used. */
const PAGE_MARKER = /--\s*\d+\s+of\s+\d+\s*--/g;

/** Raw text from a .docx via mammoth (no pages in the format, so the digest sections on
 *  headings/paragraphs). Imported lazily like the PDF path. */
async function extractDocxText(path: string): Promise<string> {
	const mammoth = await import('mammoth');
	const { value } = await mammoth.extractRawText({ buffer: await readFile(path) });
	return value;
}

/** Extract + cap one attached document by path. Throws a user-readable Error on an unsupported
 *  type, an oversized file, or a parse failure — the IPC handler maps it to `{ ok: false }`. */
export async function extractDocument(path: string): Promise<DocumentAttachment> {
	const ext = extname(path).toLowerCase();
	const name = basename(path);

	const info = await stat(path).catch(() => null);
	if (!info || !info.isFile()) {
		throw new Error("Couldn't read that file.");
	}
	if (info.size > MAX_FILE_BYTES) {
		throw new Error(`"${name}" is too large to attach (over ${Math.round(MAX_FILE_BYTES / (1024 * 1024))} MB).`);
	}

	if (PARSED_SUPPORTED && ext === '.pdf') {
		const pages = await extractPdfPages(path).catch((err) => {
			throw new Error(`Couldn't read the PDF "${name}": ${err instanceof Error ? err.message : String(err)}`);
		});
		// A scanned/image-only PDF extracts to nothing usable (often just stray page artifacts), so
		// require a small minimum of real text before accepting it.
		return nonEmpty(buildAttachment({ name, text: pages.join('\n\n'), sections: pages, unit: 'page' }),
			`No text could be extracted from "${name}". It may be a scanned or image-only PDF (no text layer).`, PDF_MIN_CHARS);
	}
	if (PARSED_SUPPORTED && ext === '.docx') {
		const text = await extractDocxText(path).catch((err) => {
			throw new Error(`Couldn't read the Word document "${name}": ${err instanceof Error ? err.message : String(err)}`);
		});
		return nonEmpty(buildAttachment({ name, text, unit: 'section' }), `No text could be extracted from "${name}".`);
	}
	if (TEXT_EXTS.has(ext)) {
		const text = await readText(path);
		const markdown = ext === '.md' || ext === '.markdown';
		return nonEmpty(buildAttachment({ name, text, unit: 'section', markdown }), `"${name}" is empty.`);
	}
	throw new Error(`Can't attach "${name}". Supported: ${ATTACHABLE_EXTENSIONS.join(', ')}.`);
}

/** Below this many extracted characters a PDF is treated as having no real text layer (scanned or
 *  image-only) rather than as a tiny document — a few stray glyphs aren't usable context. Applied
 *  to PDFs only; a genuinely tiny text/markdown file the user picked is still accepted. */
const PDF_MIN_CHARS = 16;

/** Reject an attachment that extracted to no usable text (a scanned PDF, an empty file) with a
 *  clear message, rather than attaching a useless chip the model can't do anything with. */
function nonEmpty(att: DocumentAttachment, message: string, minChars = 1): DocumentAttachment {
	if (att.originalChars < minChars) {
		throw new Error(message);
	}
	return att;
}
