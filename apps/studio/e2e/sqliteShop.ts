/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

/*
 * A small SQLite database and a way to connect the app to it, for the specs that need real tables
 * to look at (the move screen, the schema map, the table designer).
 */

/**
 * A small shop schema with believable spread, written to a SQLite file.
 *
 * Deterministic on purpose: the same numbers on every run, so a spec can assert on them. The
 * status distribution is weighted rather than `i % 4`, so a chart over it has some shape.
 */
export function seedShopDb(dir: string): string {
	const file = join(dir, 'shop.db');
	const db = new DatabaseSync(file);
	db.exec(`
		CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT, email TEXT, country TEXT, joined TEXT);
		CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, status TEXT, total REAL, placed_at TEXT);
		CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER, sku TEXT, qty INTEGER, price REAL);
	`);
	const names = ['Ann Smith', 'Bo Chen', 'Cy Diaz', 'Dee Novak', 'Eli Roth', 'Fay Okafor', 'Gil Marsh', 'Hana Ito'];
	const countries = ['GB', 'SG', 'ES', 'CZ', 'US', 'NG', 'IE', 'JP'];
	const addCustomer = db.prepare('INSERT INTO customers (name, email, country, joined) VALUES (?, ?, ?, ?)');
	names.forEach((name, i) => {
		addCustomer.run(name, `${name.split(' ')[0].toLowerCase()}@example.com`, countries[i], `2026-0${1 + (i % 8)}-1${i % 10}`);
	});
	const statuses = ['closed', 'closed', 'closed', 'closed', 'closed', 'closed', 'closed',
		'shipped', 'shipped', 'shipped', 'shipped', 'open', 'open', 'open', 'refunded'];
	const addOrder = db.prepare('INSERT INTO orders (customer_id, status, total, placed_at) VALUES (?, ?, ?, ?)');
	const addItem = db.prepare('INSERT INTO order_items (order_id, sku, qty, price) VALUES (?, ?, ?, ?)');
	for (let i = 0; i < 480; i++) {
		addOrder.run(1 + (i % names.length), statuses[i % statuses.length], 20 + ((i * 37) % 900),
			`2026-08-${String(1 + (i % 22)).padStart(2, '0')}`);
		addItem.run(i + 1, `SKU-${1000 + (i % 60)}`, 1 + (i % 4), 9.99 + ((i * 7) % 120));
	}
	db.close();
	return file;
}

/** Add a SQLite connection through the real IPC and connect it. Returns its id. */
export async function addSqliteConnection(page: Page, label: string, file: string): Promise<string> {
	return page.evaluate(async (input) => {
		const api = (window as unknown as {
			sqlApi: {
				saveConnection(form: unknown): Promise<{ id: string }>;
				connect(id: string): Promise<{ error?: string }>;
			};
		}).sqlApi;
		const saved = await api.saveConnection({
			label: input.label, driver: 'sqlite', host: '', port: 0,
			database: input.file, username: '', ssl: false, readOnly: false,
		});
		const result = await api.connect(saved.id);
		if (result.error) {
			throw new Error(`connect failed: ${result.error}`);
		}
		return saved.id;
	}, { label, file });
}
