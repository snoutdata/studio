/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// What Studio's assistant is told about its database tools: SURFACE, the descriptions only. Studio
// keeps the names, the argument schemas and when each tool is offered.

export const LIST_TABLES = {
	description: 'List the tables and views in the connected database (names, kind, column count). Use a filter on large databases.',
	filter: { description: 'Optional case-insensitive substring to filter table names.' },
};

export const DESCRIBE_TABLE = {
	description: "Get a table's columns, types, primary key, foreign keys and indexes (its structure/DDL). Call this before writing SQL against a table.",
	name: { description: 'Table name, optionally schema-qualified (e.g. "orders" or "public.orders").' },
};

export const SEARCH_COLUMNS = {
	description: 'Find tables and columns whose name contains a term, across the whole schema. Useful when you do not know which table holds a field.',
	term: { description: 'Substring to search for in table and column names.' },
};

export const RUN_QUERY = {
	description: 'Run a single READ-ONLY query (SELECT/WITH/SHOW/DESCRIBE/EXPLAIN) against the database and return the rows. The user must approve each query before it runs. Results are row-limited.',
	sql: { description: 'One read-only SQL statement. Do not add a trailing semicolon or multiple statements.' },
};

/** `run_query` on a document (MongoDB) database. */
export const RUN_PIPELINE = {
	description: 'Run a single READ-ONLY query against the MongoDB database and return the documents. The user must approve each query before it runs. Results are row-limited. Provide a read-only aggregation pipeline as JSON in `sql`: an object {"collection":"<name>","pipeline":[<stages>]} (or a bare [<stages>] array plus the `collection` argument). No write stages ($out/$merge). Read-only SQL is also accepted and auto-translated.',
	sql: { description: 'A MongoDB aggregation pipeline as JSON — {"collection":"orders","pipeline":[{"$match":{...}},{"$limit":20}]} — or a read-only SQL SELECT.' },
	collection: { description: 'The collection to run the pipeline against (only needed when `sql` is a bare [stages] array).' },
};

/** The optional `connection` argument every database tool takes. */
export const CONNECTION_ARG = {
	description: 'Optional: the saved connection to run against, given as its id or label (from list_connections). Defaults to the ACTIVE connection. Set this to inspect or query a DIFFERENT database in the same task (e.g. compare prod vs dev, or copy a column between them). Do NOT try to "switch" the active connection — pass this argument instead.',
};
