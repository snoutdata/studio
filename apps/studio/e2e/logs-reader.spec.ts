/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createServer, type Server } from 'node:http';
import { expect, test } from '@playwright/test';
import { closeApp, launchApp, type AppHandle } from './helpers';

/*
 * READING a log result.
 *
 * A telemetry connection answers in the same `QueryResult` every driver does, so until this the
 * results pane had one instrument for it: the grid. That put the whole content of a row — the line —
 * in a cell beside four columns of machinery, clipped at its edge, and the JSON view escaped the
 * newlines of exactly one row. The log READER is what a log result opens in instead.
 *
 * The claims, and each of them is about the SHAPE of what a person sees rather than about the data:
 *
 *   1. A telemetry result opens in the reader, not the grid, and the grid is still one click away.
 *   2. A line's repeated timestamp and its request id come OFF the line — they are already the row's
 *      time column, and a column of identical request ids is not a reading.
 *   3. The level is read from the line and colours it, so an error is findable by eye.
 *   4. An embedded payload pretty-prints IN PLACE when the row is opened. This is the whole point:
 *      it is the thing a cell could never do.
 *   5. A relational result with the same column names is NOT a log result. The reader is offered on
 *      the backend, never on the shape, and `ts`/`message` is an ordinary pair of columns.
 *
 * The service is a stub on 127.0.0.1, so this runs
 * anywhere and needs no AWS account. What it exercises is the real driver, the real compiler and the
 * real results pane.
 */

let handle: AppHandle;
let logs: Server;
let endpoint = '';

const GROUP = '/aws/lambda/orders-worker';
const REQUEST_ID = '3f2b6c1e-8a4d-4e7b-9c05-1d2e3f4a5b6c';
/** The minute the events were logged in. Fixed for the run, so a later read (the surrounding
 *  events) sees the same clocks the first one did. */
const LOGGED_FROM = Date.now() - 120_000;

/** A minute of an invented Lambda's output: the control lines, an INFO carrying a request object,
 *  and an ERROR. Every message is in the tab-delimited form the runtime writes. */
function events(): { timestamp: number; ingestionTime: number; eventId: string; logStreamName: string; message: string }[] {
	const start = LOGGED_FROM;
	const stamp = (offset: number): string => new Date(start + offset).toISOString();
	const lines: [number, string][] = [
		[0, `INIT_START Runtime Version: nodejs:20.v1\tRuntime Version ARN: arn:aws:lambda:us-west-2::runtime:0a1b2c`],
		[644, `START RequestId: ${REQUEST_ID} Version: $LATEST`],
		[646, `${stamp(646)}\t${REQUEST_ID}\tINFO\torder handler invoked`],
		[648, `${stamp(648)}\t${REQUEST_ID}\tINFO\tParsed event: ${JSON.stringify({ resource: '/v1/orders', path: '/v1/orders', httpMethod: 'GET', headers: { Accept: '*/*', Host: 'api.example.com', Range: 'bytes=0-32768' }, queryStringParameters: null, isBase64Encoded: false })}`],
		[771, `${stamp(771)}\t${REQUEST_ID}\tERROR\tupstream refused the connection`],
		// A message that is ENTIRELY one record — what a structured logger writes, and what the
		// Azure and GCP drivers produce for every row (a Log Analytics row has no text column at
		// all, so the driver serialises the whole record into `message`).
		[800, JSON.stringify({ severity: 'WARNING', message: 'retrying upstream', attempt: 2, upstream: { host: 'retry-upstream.internal', port: 443 } })],
		[904, `END RequestId: ${REQUEST_ID}`],
	];
	return lines.map(([offset, message], index) => ({
		timestamp: start + offset,
		ingestionTime: start + offset + 2500,
		eventId: `ev-${index}`,
		logStreamName: '2026/01/15/[$LATEST]0123456789abcdef0123456789abcdef',
		message,
	}));
}

test.beforeAll(async () => {
	logs = createServer((request, response) => {
		const target = String(request.headers['x-amz-target'] ?? '');
		let body = '';
		request.on('data', (chunk) => { body += chunk; });
		request.on('end', () => {
			response.writeHead(200, { 'content-type': 'application/x-amz-json-1.1' });
			if (target.includes('DescribeLogGroups')) {
				response.end(JSON.stringify({ logGroups: [{ logGroupName: GROUP, storedBytes: 12_884_901_888 }] }));
				return;
			}
			if (target.includes('FilterLogEvents')) {
				// The window is honoured, as the service does; the filter pattern is not, since the
				// executor applies every predicate again anyway.
				const { startTime, endTime } = JSON.parse(body || '{}') as { startTime?: number; endTime?: number };
				response.end(JSON.stringify({ events: events().filter((event) => (startTime === undefined || event.timestamp >= startTime) && (endTime === undefined || event.timestamp < endTime)) }));
				return;
			}
			// A GROUP BY goes to Logs Insights, which is StartQuery + poll rather than one call.
			// One poll is enough here: the stub answers Complete immediately.
			if (target.includes('StartQuery')) {
				response.end(JSON.stringify({ queryId: 'q-1' }));
				return;
			}
			if (target.includes('GetQueryResults')) {
				response.end(JSON.stringify({
					status: 'Complete',
					results: events().map((event) => [{ field: 'message', value: event.message }, { field: 'n', value: '1' }]),
				}));
				return;
			}
			response.end('{}');
		});
	});
	await new Promise<void>((resolve) => {
		logs.listen(0, '127.0.0.1', () => {
			const address = logs.address();
			endpoint = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
			resolve();
		});
	});
	handle = await launchApp('logs-reader');

	// The account and the connection go in through the IPC: this spec is about the RESULTS pane,
	// and clicking through Settings and the connection form to reach it would be testing those.
	await handle.page.evaluate(async ({ where, group }: { where: string; group: string }) => {
		const api = window.sqlApi as unknown as {
			cloud: { save(input: unknown): Promise<unknown> };
			saveConnection(form: unknown): Promise<{ id: string }>;
		};
		await api.cloud.save({
			account: { id: 'acct-logs', name: 'acme aws', vendor: 'aws', region: 'us-west-2', endpoint: where, auth: { mode: 'key', keyId: 'AKIAEXAMPLE' } },
			secret: 'a-very-secret-value',
		});
		await api.saveConnection({
			label: 'orders logs',
			driver: 'cloudwatch',
			host: '',
			port: 0,
			database: '',
			username: '',
			ssl: false,
			readOnly: true,
			cloudAccountId: 'acct-logs',
			cloudScope: 'us-west-2',
			cloudScopes: [group],
		});
		// A plain SQLite connection beside it, to prove the reader is offered on the BACKEND.
		await api.saveConnection({ label: 'plain sqlite', driver: 'sqlite', host: '', port: 0, database: ':memory:', username: '', ssl: false, readOnly: false });
	}, { where: endpoint, group: GROUP });
});

test.afterAll(async () => {
	await closeApp(handle);
	await new Promise<void>((resolve) => logs.close(() => resolve()));
});

/** Connect a saved connection from the sidebar and run one statement. */
async function run(label: string, sql: string): Promise<void> {
	const { page } = handle;
	const row = page.locator('.tree-row.depth-0', { hasText: label });
	await expect(row).toBeVisible();
	await row.click();
	await row.hover();
	// "Disconnect" is the row's own statement that it is live; a saved connection the app has
	// already opened for us never shows a Connect button to click.
	if (await row.locator('button[aria-label="Connect"]').count() > 0) {
		await row.locator('button[aria-label="Connect"]').click();
	}
	await expect(row.locator('button[aria-label="Disconnect"]')).toBeVisible({ timeout: 30_000 });
	await page.locator('.monaco-editor').first().click();
	await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+a`);
	await page.keyboard.type(sql);
	await page.locator('[data-tour="run-button"]').click();
}

test('a log result opens in the reader, one line per event', async () => {
	const { page } = handle;
	await run('orders logs', `SELECT * FROM "${GROUP}"`);

	const reader = page.locator('.log-view');
	await expect(reader).toBeVisible({ timeout: 30_000 });
	// Seven events, seven lines — and the grid is not what is drawn.
	await expect(page.locator('.log-row')).toHaveCount(7);
	await expect(page.locator('.grid-body')).toHaveCount(0);

	// The line the runtime wrote is `<iso>\t<uuid>\tINFO\torder handler invoked`. What is READ is
	// the last field: the timestamp is already the row's own column and the request id is the same
	// on every line of the invocation.
	const triggered = page.locator('.log-row', { hasText: 'order handler invoked' });
	await expect(triggered.locator('.log-summary')).toHaveText('order handler invoked');
	await expect(triggered.locator('.log-level')).toHaveText('info');
	await expect(triggered.locator('.log-time')).toHaveText(/^\d{2}:\d{2}:\d{2}\.\d{3}$/);

	await page.screenshot({ path: 'e2e/.artifacts/logs-reader-collapsed.png' });
});

test('an ERROR line is coloured, so it is findable by eye', async () => {
	const { page } = handle;
	const failed = page.locator('.log-row', { hasText: 'upstream refused the connection' });
	await expect(failed).toHaveClass(/log-error/);
	await expect(failed.locator('.log-level')).toHaveText('error');
	// The control lines carry no level, and are not guessed at.
	await expect(page.locator('.log-row', { hasText: 'END RequestId' }).locator('.log-level')).toHaveText('');
});

test('an embedded payload pretty-prints in place when the line is opened', async () => {
	const { page } = handle;
	const parsed = page.locator('.log-row', { hasText: 'Parsed event' });
	// In the grid this row was one clipped cell; here the prose stays a line and the object opens.
	await expect(parsed.locator('.log-summary')).toContainText('Parsed event:');
	await parsed.locator('.log-line').click();

	const payload = parsed.locator('.log-json');
	await expect(payload).toBeVisible();
	// Indented, so a nested object is a shape rather than a run of braces…
	await expect(payload).toContainText('"httpMethod": "GET"');
	await expect(payload).toContainText('  "headers": {');
	// …and the keys are told apart from the values.
	await expect(payload.locator('.json-key').first()).toHaveText('"resource"');

	// What the line was CARRYING, which the grid spent four columns on, is here instead.
	await expect(parsed.locator('.log-chip', { hasText: 'request' })).toContainText(REQUEST_ID);
	await expect(parsed.locator('.log-chip', { hasText: 'stream' })).toContainText('[$LATEST]');

	await page.screenshot({ path: 'e2e/.artifacts/logs-reader-expanded.png' });

	// Closing puts it back to one line.
	await parsed.locator('.log-line').click();
	await expect(parsed.locator('.log-json')).toHaveCount(0);
});

test('a message that is entirely one record reads as a line, not as a blob', async () => {
	const { page } = handle;
	// The Azure and GCP shape. With no reading of its own it arrives as
	// `{"severity":"WARNING","message":"retrying upstream",…}` on every single row, which is the
	// grid's problem again one panel to the left.
	const retry = page.locator('.log-row', { hasText: 'retrying upstream' });
	// The record's own text leads, its scalars follow, the level is the badge and is NOT repeated
	// on the line, and the nested object is left to the expansion.
	await expect(retry.locator('.log-summary')).toHaveText('retrying upstream attempt=2');
	await expect(retry.locator('.log-level')).toHaveText('warn');
	await expect(retry).toHaveClass(/log-warn/);

	await retry.locator('.log-line').click();
	await expect(retry.locator('.log-json')).toContainText('"host": "retry-upstream.internal"');
	await retry.locator('.log-line').click();
});

test('`SELECT message` is a narrower question, not a different one', async () => {
	const { page } = handle;
	// The clock is furniture the reader shows when it is there. Demanding it sent "just the lines,
	// please" back to the grid, which is the one place the lines are least readable.
	await run('orders logs', `SELECT message FROM "${GROUP}"`);
	await expect(page.locator('.log-view')).toBeVisible({ timeout: 30_000 });
	await expect(page.locator('.log-row')).toHaveCount(7);
	await expect(page.locator('.log-row', { hasText: 'order handler invoked' }).locator('.log-summary')).toHaveText('order handler invoked');
	// No time column at all, rather than an empty one where a time is supposed to be.
	await expect(page.locator('.log-time')).toHaveCount(0);
	await page.screenshot({ path: 'e2e/.artifacts/logs-reader-message-only.png' });
});

test('a GROUP BY is a table: its rows are groups, not events', async () => {
	const { page } = handle;
	// This one projects `message`, so no column list could tell. `QueryCost.grouped` can.
	await run('orders logs', `SELECT message, count(*) AS n FROM "${GROUP}" GROUP BY message`);
	await expect(page.locator('.cell.head-cell', { hasText: 'n' })).toBeVisible({ timeout: 30_000 });
	await expect(page.locator('.log-view')).toHaveCount(0);
	await expect(page.locator('.view-toggle button[title^="Log reader"]')).toHaveCount(0);

	// …and the next scan comes straight back to the reader.
	await run('orders logs', `SELECT * FROM "${GROUP}"`);
	await expect(page.locator('.log-view')).toBeVisible({ timeout: 30_000 });
});

test('searching narrows the lines, and shows WHY each one matched', async () => {
	const { page } = handle;
	await run('orders logs', `SELECT * FROM "${GROUP}"`);
	await expect(page.locator('.log-view')).toBeVisible({ timeout: 30_000 });

	const search = page.locator('.grid-search input');
	// A term that appears nowhere in any line's one-line reading: it is nested inside a record, so
	// the composed line ("retrying upstream attempt=2") leaves it out entirely. Before the fragment,
	// the one row left looked like it did not match at all.
	await search.fill('retry-upstream.internal');
	await expect(page.locator('.log-row')).toHaveCount(1);

	const hit = page.locator('.log-row').first();
	const summary = hit.locator('.log-summary');
	await expect(summary).toHaveClass(/fragment/);
	await expect(summary).toContainText('retry-upstream.internal');
	// It reads as a quotation out of the line, not as the line.
	await expect(summary).toContainText('…');
	await expect(summary.locator('mark')).toHaveText('retry-upstream.internal');

	// …and the hit is marked inside the payload too, once the line is opened.
	await hit.locator('.log-line').click();
	await expect(hit.locator('.log-json mark').first()).toHaveText('retry-upstream.internal');
	await hit.locator('.log-line').click();

	// A term that IS in the line's own reading leaves the line alone.
	await search.fill('refused');
	await expect(page.locator('.log-row')).toHaveCount(1);
	await expect(page.locator('.log-summary')).not.toHaveClass(/fragment/);
	await expect(page.locator('.log-summary mark')).toHaveText('refused');

	await page.screenshot({ path: 'e2e/.artifacts/logs-reader-search.png' });
	await page.locator('.grid-search-clear').click();
	await expect(page.locator('.log-row')).toHaveCount(7);
});

test('a matched line opens among the events logged around it, as the CloudWatch console shows it', async () => {
	const { page } = handle;
	await run('orders logs', `SELECT * FROM "${GROUP}" WHERE message LIKE '%refused%'`);
	await expect(page.locator('.log-row')).toHaveCount(1, { timeout: 30_000 });

	const hit = page.locator('.log-row').first();
	await hit.locator('.log-line').click();
	await hit.locator('.log-copy', { hasText: "Surrounding events" }).click();

	// The whole stream around it, in order, the matched line among them and marked.
	const lines = hit.locator('.log-context-line');
	await expect(lines).toHaveCount(7);
	await expect(lines.nth(4)).toHaveClass(/anchor/);
	await expect(lines.nth(4)).toContainText('upstream refused the connection');
	await expect(lines.nth(3)).toContainText('Parsed event');
	await expect(lines.nth(5)).toContainText('retrying upstream');
	await expect(hit.locator('.log-context-head')).toContainText('[$LATEST]');
	// Nothing further either way, and the buttons say so rather than doing nothing.
	await expect(hit.locator('.log-context-more').first()).toHaveText(/No earlier events/);
	await expect(hit.locator('.log-context-more').last()).toHaveText(/No later events/);

	// A surrounding line opens out in full where it is.
	await lines.nth(3).click();
	await expect(lines.nth(3)).toHaveClass(/full/);
	await expect(lines.nth(3)).toContainText('"httpMethod": "GET"');

	await page.screenshot({ path: 'e2e/.artifacts/logs-reader-context.png' });

	// And it closes again.
	await hit.locator('.log-copy', { hasText: "Hide surrounding" }).click();
	await expect(hit.locator('.log-context')).toHaveCount(0);
});

test('the grid is still one click away', async () => {
	const { page } = handle;
	await page.locator('.view-toggle button[title="Grid view"]').click();
	await expect(page.locator('.cell.head-cell', { hasText: 'message' })).toBeVisible();
	await expect(page.locator('.log-view')).toHaveCount(0);
	await page.locator('.view-toggle button[title^="Log reader"]').click();
	await expect(page.locator('.log-view')).toBeVisible();
});

test('a relational result with the same column names is a table, not a log', async () => {
	const { page } = handle;
	await run('plain sqlite', "SELECT 1 AS ts, 'hello' AS message");
	await expect(page.locator('.cell.head-cell', { hasText: 'message' })).toBeVisible({ timeout: 30_000 });
	await expect(page.locator('.log-view')).toHaveCount(0);
	await expect(page.locator('.view-toggle button[title^="Log reader"]')).toHaveCount(0);
});
