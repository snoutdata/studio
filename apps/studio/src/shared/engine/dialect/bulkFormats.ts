/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  The input formats an engine can be handed a FILE of.
 *
 *  A list and nothing else, with no imports, because the dialect declares it (`index.ts`) and the
 *  code that uses it (`bulkLoad.ts`) reads it back off the dialect. Keeping the list here is what
 *  stops those two importing each other.
 *--------------------------------------------------------------------------------------------*/

/** One of the engine's own input formats, as its `FORMAT` clause names it. */
export interface BulkFormat {
	/** The name the engine knows it by. Sent verbatim, so it is never taken from user text. */
	readonly id: string;
	/** What it is called on the picker. */
	readonly label: string;
	/** Lowercase, dot-led extensions that mean this format. The FIRST format in the list that
	 *  claims an extension is what a file of that name is read as. */
	readonly extensions: readonly string[];
	/**
	 * The file carries its own column names.
	 *
	 * This is the field that decides whether a load can go wrong quietly: a named format is
	 * matched to the table by NAME, so a file whose columns are in a different order still lands
	 * correctly, while an unnamed one is matched by POSITION and a reordered file fills the wrong
	 * columns with no error at all.
	 */
	readonly named: boolean;
	/** One line for the picker, where the choice is not obvious from the name. */
	readonly note?: string;
}

/**
 * ClickHouse's input formats, in the order the picker offers them.
 *
 * Not all of them: the ones a person actually has a file of. The order matters twice over, since
 * `formatForFile` takes the first claimant of an extension, which is why `CSVWithNames` sits above
 * `CSV` (a .csv with a header row is what a person almost always has, and it is the guess whose
 * being wrong is loud rather than silent).
 */
export const CLICKHOUSE_BULK_FORMATS: readonly BulkFormat[] = [
	{ id: 'Parquet', label: "Parquet", extensions: ['.parquet', '.pq'], named: true, note: "Columnar, typed, and the fastest of these to load." },
	{ id: 'CSVWithNames', label: "CSV with a header row", extensions: ['.csv'], named: true },
	{ id: 'CSV', label: "CSV, no header row", extensions: [], named: false },
	{ id: 'TabSeparatedWithNames', label: "Tab separated with a header row", extensions: ['.tsv', '.tab'], named: true },
	{ id: 'TabSeparated', label: "Tab separated, no header row", extensions: [], named: false },
	{ id: 'JSONEachRow', label: "JSON, one object per line", extensions: ['.jsonl', '.ndjson', '.json'], named: true },
	{ id: 'ORC', label: "ORC", extensions: ['.orc'], named: true },
	{ id: 'Arrow', label: "Arrow", extensions: ['.arrow'], named: true },
	{ id: 'Avro', label: "Avro", extensions: ['.avro'], named: true },
	{ id: 'Native', label: "ClickHouse Native", extensions: ['.native'], named: true, note: "What the server itself writes. No conversion at either end." },
];
