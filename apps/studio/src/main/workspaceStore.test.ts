/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { WorkspaceStore } from './workspaceStore';

/** A store rooted in a fresh temp userData dir, so tests never touch Electron's `app`. */
function freshStore(): { store: WorkspaceStore; base: string } {
	const base = mkdtempSync(join(tmpdir(), 'snout-ws-'));
	return { store: new WorkspaceStore(base), base };
}

test('create dedupes names and list reflects new files', () => {
	const { store, base } = freshStore();
	try {
		const a = store.create('report', 'SELECT 1;');
		assert.equal(a.name, 'report.sql');
		const b = store.create('report');
		assert.equal(b.name, 'report-2.sql');
		const names = store.list().map((f) => f.name).sort();
		assert.deepEqual(names, ['report-2.sql', 'report.sql']);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test('read / save round-trips by name', () => {
	const { store, base } = freshStore();
	try {
		store.create('q.sql', 'SELECT 1;');
		assert.equal(store.read('q.sql'), 'SELECT 1;');
		store.save('q.sql', 'SELECT 2;');
		assert.equal(store.read('q.sql'), 'SELECT 2;');
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test('rename moves the file and dedupes on collision', () => {
	const { store, base } = freshStore();
	try {
		const a = store.create('a', 'x');
		store.create('b', 'y');
		const renamed = store.rename(a.path, 'b'); // 'b.sql' exists -> dedupe
		assert.equal(renamed.name, 'b-2.sql');
		const names = store.list().map((f) => f.name).sort();
		assert.deepEqual(names, ['b-2.sql', 'b.sql']);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test('remove deletes the file', () => {
	const { store, base } = freshStore();
	try {
		const f = store.create('gone.sql', '');
		store.remove(f.path);
		assert.equal(store.list().length, 0);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test('list ignores non-sql files', () => {
	const { store, base } = freshStore();
	try {
		const root = store.root();
		writeFileSync(join(root, 'notes.txt'), 'hi');
		store.create('keep.sql', '');
		assert.deepEqual(store.list().map((f) => f.name), ['keep.sql']);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test('search matches names and contents with line numbers', () => {
	const { store, base } = freshStore();
	try {
		store.create('orders.sql', 'SELECT *\nFROM orders\nJOIN customers USING (id);');
		store.create('misc.sql', 'SELECT now();');
		const byName = store.search('orders');
		assert.ok(byName.some((h) => h.name === 'orders.sql' && h.nameMatch));
		const byContent = store.search('customers');
		const hit = byContent.find((h) => h.name === 'orders.sql');
		assert.ok(hit);
		assert.equal(hit?.matches[0].line, 3);
		assert.ok(hit?.matches[0].text.includes('customers'));
		assert.equal(store.search('zzz-nothing').length, 0);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test('path-escape guard rejects paths outside the root', () => {
	const { store, base } = freshStore();
	try {
		store.root();
		assert.throws(() => store.read('../../secret.txt'), /outside the workspace/);
		assert.throws(() => store.read('/etc/passwd'), /outside the workspace/);
		assert.throws(() => store.save('../escape.sql', 'x'), /outside the workspace/);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test('importFile copies an external file into the workspace', () => {
	const { store, base } = freshStore();
	try {
		const src = join(base, 'external.sql');
		writeFileSync(src, 'SELECT 42;');
		const imported = store.importFile(src);
		assert.equal(imported.name, 'external.sql');
		assert.equal(store.read('external.sql'), 'SELECT 42;');
		// A second import of the same name dedupes rather than overwriting.
		const again = store.importFile(src);
		assert.equal(again.name, 'external-2.sql');
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test('setRoot repoints the workspace folder', () => {
	const { store, base } = freshStore();
	try {
		const custom = join(base, 'custom-scripts');
		store.setRoot(custom);
		assert.equal(store.root(), custom);
		store.create('here.sql', '');
		assert.ok(readFileSync(join(custom, 'here.sql'), 'utf8') === '');
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

/**
 * A store whose root holds links, made the way a cloned repository can carry them. False when
 * this machine will not make one (Windows without the privilege), and the test is skipped.
 */
function linked(make: (root: string, outside: string) => void): { store: WorkspaceStore; base: string; root: string; outside: string } | false {
	const { store, base } = freshStore();
	const root = store.root();
	const outside = join(base, 'outside');
	mkdirSync(outside);
	try {
		make(root, outside);
	} catch {
		rmSync(base, { recursive: true, force: true });
		return false;
	}
	return { store, base, root, outside };
}

test('a link to a file outside the root is not read, listed, searched or written through', (t) => {
	const ws = linked((root, outside) => {
		writeFileSync(join(outside, 'id_ed25519'), 'PRIVATE KEY');
		symlinkSync(join(outside, 'id_ed25519'), join(root, 'notes.sql'));
	});
	if (!ws) {
		t.skip('this machine cannot make a link');
		return;
	}
	try {
		assert.throws(() => ws.store.read('notes.sql'), /outside the workspace/);
		assert.throws(() => ws.store.save('notes.sql', 'overwritten'), /link/);
		assert.equal(readFileSync(join(ws.outside, 'id_ed25519'), 'utf8'), 'PRIVATE KEY');
		assert.deepEqual(ws.store.list().map((f) => f.name), []);
		assert.deepEqual(ws.store.search('PRIVATE'), []);
		// Renaming a file onto it, or creating one by its name, never writes through it either.
		ws.store.create('notes', 'SELECT 1;');
		assert.equal(readFileSync(join(ws.outside, 'id_ed25519'), 'utf8'), 'PRIVATE KEY');
	} finally {
		rmSync(ws.base, { recursive: true, force: true });
	}
});

test('a link to a directory outside the root is not read or listed', (t) => {
	const ws = linked((root, outside) => {
		writeFileSync(join(outside, 'secret.sql'), 'SECRET');
		symlinkSync(outside, join(root, 'dir.sql'), 'dir');
	});
	if (!ws) {
		t.skip('this machine cannot make a link');
		return;
	}
	try {
		assert.throws(() => ws.store.read('dir.sql'), /outside the workspace/);
		assert.throws(() => ws.store.read('dir.sql/secret.sql'), /outside the workspace/);
		assert.deepEqual(ws.store.list(), []);
		assert.deepEqual(ws.store.search('SECRET'), []);
	} finally {
		rmSync(ws.base, { recursive: true, force: true });
	}
});

test('a dangling link counts as taken: create and rename never write outside', (t) => {
	const ws = linked((root, outside) => {
		symlinkSync(join(outside, 'zshenv'), join(root, 'query.sql'));
	});
	if (!ws) {
		t.skip('this machine cannot make a link');
		return;
	}
	try {
		const created = ws.store.create('query', 'SELECT 1;');
		assert.equal(created.name, 'query-2.sql');
		assert.equal(existsSync(join(ws.outside, 'zshenv')), false);
		const other = ws.store.create('other', 'SELECT 2;');
		const renamed = ws.store.rename(other.path, 'query.sql');
		assert.notEqual(renamed.name, 'query.sql');
		assert.equal(existsSync(join(ws.outside, 'zshenv')), false);
		assert.ok(lstatSync(join(ws.root, 'query.sql')).isSymbolicLink(), 'the link itself is left alone');
		assert.throws(() => ws.store.save('query.sql', 'x'), /link/);
		assert.equal(existsSync(join(ws.outside, 'zshenv')), false);
	} finally {
		rmSync(ws.base, { recursive: true, force: true });
	}
});

test('a link to another file inside the root reads and lists like the file', (t) => {
	const ws = linked((root) => {
		writeFileSync(join(root, 'real.sql'), 'SELECT 3;');
		symlinkSync(join(root, 'real.sql'), join(root, 'alias.sql'));
	});
	if (!ws) {
		t.skip('this machine cannot make a link');
		return;
	}
	try {
		assert.equal(ws.store.read('alias.sql'), 'SELECT 3;');
		assert.deepEqual(ws.store.list().map((f) => f.name).sort(), ['alias.sql', 'real.sql']);
		assert.equal(ws.store.search('SELECT 3').length, 2);
		// Removing the link removes the link, not the file it points at.
		ws.store.remove('alias.sql');
		assert.equal(ws.store.read('real.sql'), 'SELECT 3;');
	} finally {
		rmSync(ws.base, { recursive: true, force: true });
	}
});

test('an import copies a regular file, and refuses a link or anything that is not a file', (t) => {
	const { store, base } = freshStore();
	const outside = join(base, 'elsewhere');
	mkdirSync(outside);
	writeFileSync(join(outside, 'credentials'), '[default]\naws_secret_access_key = SECRET');
	writeFileSync(join(outside, 'report.sql'), 'SELECT 1;');
	try {
		assert.equal(store.read(store.importFile(join(outside, 'report.sql')).path), 'SELECT 1;');
		try {
			symlinkSync(join(outside, 'credentials'), join(outside, 'creds.sql'));
		} catch {
			t.skip('this machine cannot make a link');
			return;
		}
		assert.throws(() => store.importFile(join(outside, 'creds.sql')), /"creds\.sql" is a link, so it was not imported/);
		assert.throws(() => store.importFile(outside), /not a regular file/);
		assert.equal(store.list().some((f) => readFileSync(f.path, 'utf8').includes('SECRET')), false);
		if (process.platform !== 'win32') {
			execFileSync('mkfifo', [join(outside, 'pipe.sql')]);
			assert.throws(() => store.importFile(join(outside, 'pipe.sql')), /not a regular file/);
		}
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});
