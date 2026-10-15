/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { opendir, open, rm } from 'node:fs/promises';
import { runWaiter, type WaiterConfig, type WaiterDeps } from './swapWaiter';

// The swap waiter's real side effects (swapWaiter.ts holds every decision). Bundled by
// esbuild.server.mjs to out/server/swap-waiter.cjs with nothing but Node built-ins, because the app
// copies that one file out of the asar and runs it in Node mode with archive support off:
//   swap-waiter.exe <install>.swap\waiter.cjs <install>.swap\config.json     the waiter
//   SnoutData.exe   <tmp>\folder-tool.cjs --flush <dir>                        force a tree to disk
//   SnoutData.exe   <tmp>\folder-tool.cjs --remove <dir>                       delete a tree
// The last two are the app's whole-folder work, which never runs in its main process
// (stagedUpdate.runFolderTool says why).

/** fsync every file under `dir`. */
async function flushTree(dir: string): Promise<number> {
	let count = 0;
	for await (const entry of await opendir(dir, { recursive: true })) {
		if (!entry.isFile()) {
			continue;
		}
		const handle = await open(`${entry.parentPath}\\${entry.name}`, 'r+');
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
		count++;
	}
	return count;
}

async function folderTool(command: string, dir: string): Promise<never> {
	try {
		if (command === '--flush') {
			await flushTree(dir);
		} else {
			await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
		}
		process.exit(0);
	} catch (err) {
		process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
		process.exit(1);
	}
}

/** Start a program for the app (an installer, the staged build's self-check), so its launch, and the
 *  scan Defender does inside it, never happens on the app's main thread. Exits with its exit code. */
function runProgram(timeoutMs: number, file: string, args: string[]): void {
	const child = spawn(file, args, { cwd: tmpdir(), stdio: 'ignore', windowsHide: true, env: childEnv() });
	const timer = setTimeout(() => child.kill(), timeoutMs);
	child.once('error', (err) => {
		process.stderr.write(`${err.message}\n`);
		process.exit(1);
	});
	child.once('exit', (code) => {
		clearTimeout(timer);
		process.exit(code ?? 1);
	});
}

// What this process runs as must not reach what it starts: Node mode would start an app as plain
// Node, and archive support off would leave it unable to read its own app.asar. Either is an app
// that does not start.
function childEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	delete env.ELECTRON_RUN_AS_NODE;
	delete env.ELECTRON_NO_ASAR;
	return env;
}

if (process.argv[2] === '--flush' || process.argv[2] === '--remove') {
	void folderTool(process.argv[2], process.argv[3]);
} else if (process.argv[2] === '--run') {
	runProgram(Number(process.argv[3]), process.argv[4], process.argv.slice(5));
} else {
	waiterMain();
}

function waiterMain(): void {
const cfg = JSON.parse(readFileSync(process.argv[2], 'utf8')) as WaiterConfig;


function log(message: string): void {
	try {
		appendFileSync(cfg.log, `${new Date().toISOString()} staged update waiter: ${message}\n`);
	} catch {
		// The log is for diagnosis; it never stops the swap.
	}
}

let lastSeen = '';

const deps: WaiterDeps = {
	exists: (path) => existsSync(path),
	read: (path) => {
		try {
			return readFileSync(path, 'utf8');
		} catch {
			return null;
		}
	},
	write: (path, text) => {
		try {
			writeFileSync(path, text, 'utf8');
		} catch (err) {
			log(`could not write ${path}: ${err instanceof Error ? err.message : String(err)}`);
		}
	},
	remove: (path) => {
		try {
			rmSync(path, { force: true });
		} catch {
			// Best effort.
		}
	},
	removeDir: (path) => {
		try {
			rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
		} catch {
			// Best effort: the next launch removes what is left.
		}
	},
	rename: (from, to) => {
		try {
			renameSync(from, to);
			return true;
		} catch {
			return false;
		}
	},
	alive: (pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch (err) {
			return (err as NodeJS.ErrnoException).code === 'EPERM';
		}
	},
	otherAppProcesses: (exe) => {
		const filters = ['/FI', `IMAGENAME eq ${exe}`];
		if (process.env.USERNAME) {
			filters.push('/FI', `USERNAME eq ${process.env.USERNAME}`);
		}
		const out = spawnSync('tasklist', [...filters, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
		if (out.error || typeof out.stdout !== 'string') {
			log(`tasklist failed (${out.error?.message ?? 'no output'}); going on the app's own exit`);
			return 0;
		}
		const pids = out.stdout
			.split(/\r?\n/)
			.map((line) => line.split('","')[1])
			.filter((pid) => pid !== undefined && Number(pid) !== process.pid);
		if (pids.length > 0 && pids.join() !== lastSeen) {
			// What holds the swap up, which is the one thing that explains a wait ending in the stock
			// installer.
			lastSeen = pids.join();
			log(`still running as ${exe}: ${pids.join(', ')}`);
		}
		return pids.length;
	},
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	launch: (file, args) => {
		try {
			// The app starts in its own folder, as its shortcut starts it; anything else in the temp folder.
			const cwd = file.toLowerCase().endsWith(`\\${cfg.exe.toLowerCase()}`) ? dirname(file) : tmpdir();
			spawn(file, args, { cwd, detached: true, stdio: 'ignore', env: childEnv() }).unref();
		} catch (err) {
			log(`could not start ${file}: ${err instanceof Error ? err.message : String(err)}`);
		}
	},
	run: (file, args) =>
		new Promise((resolve) => {
			try {
				const child = spawn(file, args, { cwd: tmpdir(), stdio: 'ignore', env: childEnv() });
				child.once('error', (err) => {
					log(`could not start ${file}: ${err.message}`);
					resolve(null);
				});
				child.once('exit', (code) => resolve(code));
			} catch (err) {
				log(`could not start ${file}: ${err instanceof Error ? err.message : String(err)}`);
				resolve(null);
			}
		}),
	closeApp: (exe) => {
		const filters = ['/FI', `PID ne ${process.pid}`];
		if (process.env.USERNAME) {
			filters.push('/FI', `USERNAME eq ${process.env.USERNAME}`);
		}
		spawnSync('taskkill', ['/F', '/IM', exe, ...filters], { windowsHide: true });
	},
	reg: (key, name, value) => {
		spawnSync('reg', ['add', key, '/v', name, '/d', value, '/f'], { windowsHide: true });
	},
	unreg: (key, name) => {
		spawnSync('reg', ['delete', key, '/v', name, '/f'], { windowsHide: true });
	},
	writeDurable: (path, text) => {
		try {
			mkdirSync(dirname(path), { recursive: true });
			const fd = openSync(path, 'w');
			try {
				writeSync(fd, text);
				// FlushFileBuffers: the contents AND the NTFS log up to this file's creation are on disk
				// before any rename after it is issued.
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			return true;
		} catch (err) {
			log(`could not write ${path} to disk: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	},
	copy: (from, to) => {
		try {
			copyFileSync(from, to);
		} catch (err) {
			log(`could not refresh ${to}: ${err instanceof Error ? err.message : String(err)}`);
		}
	},
	log,
};

void runWaiter(cfg, deps)
	.then((outcome) => log(`done: ${outcome}`))
	.catch((err) => log(`crashed: ${err instanceof Error ? err.message : String(err)}`))
	.finally(() => process.exit(0));
}
