/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { azureDataStudioFiles, containerSockets, heidisqlPortableFiles, pgadminFiles, pgpassFiles, ssmsRoot, tablePlusFiles, workbenchFiles, type HostEnv } from './paths';

const win: HostEnv = { platform: 'win32', home: 'C:\\Users\\me', appData: 'C:\\Users\\me\\AppData\\Roaming', tmp: 'C:\\Temp', env: { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' } };
const mac: HostEnv = { platform: 'darwin', home: '/Users/me', appData: '/Users/me/Library/Application Support', tmp: '/var/folders/xy/T', env: {} };
const linux: HostEnv = { platform: 'linux', home: '/home/me', appData: '/home/me/.config', tmp: '/tmp', env: { XDG_RUNTIME_DIR: '/run/user/1000' } };

test('pgAdmin: %APPDATA%\\pgAdmin on Windows, ~/.pgadmin elsewhere', () => {
	assert.deepEqual(pgadminFiles(win), ['C:\\Users\\me\\AppData\\Roaming\\pgAdmin\\pgadmin4.db']);
	assert.deepEqual(pgadminFiles(mac), ['/Users/me/.pgadmin/pgadmin4.db']);
	assert.deepEqual(pgadminFiles(linux), ['/home/me/.pgadmin/pgadmin4.db']);
});

test('MySQL Workbench per platform', () => {
	assert.deepEqual(workbenchFiles(win), ['C:\\Users\\me\\AppData\\Roaming\\MySQL\\Workbench\\connections.xml']);
	assert.deepEqual(workbenchFiles(mac), ['/Users/me/Library/Application Support/MySQL/Workbench/connections.xml']);
	assert.deepEqual(workbenchFiles(linux), ['/home/me/.mysql/workbench/connections.xml']);
});

test('Azure Data Studio under the config root on each platform', () => {
	assert.equal(azureDataStudioFiles(win)[0], 'C:\\Users\\me\\AppData\\Roaming\\azuredatastudio\\User\\settings.json');
	assert.equal(azureDataStudioFiles(mac)[0], '/Users/me/Library/Application Support/azuredatastudio/User/settings.json');
	assert.equal(azureDataStudioFiles(linux)[0], '/home/me/.config/azuredatastudio/User/settings.json');
});

test('SSMS and HeidiSQL exist only on Windows; TablePlus only on macOS', () => {
	assert.equal(ssmsRoot(win), 'C:\\Users\\me\\AppData\\Roaming\\Microsoft\\SQL Server Management Studio');
	assert.equal(ssmsRoot(mac), null);
	assert.equal(ssmsRoot(linux), null);
	assert.ok(heidisqlPortableFiles(win).includes('C:\\Program Files\\HeidiSQL\\portable_settings.txt'));
	assert.ok(heidisqlPortableFiles(win).includes('C:\\Users\\me\\AppData\\Local\\Programs\\HeidiSQL\\portable_settings.txt'));
	assert.deepEqual(heidisqlPortableFiles(mac), []);
	assert.deepEqual(tablePlusFiles(mac), ['/Users/me/Library/Application Support/com.tinyapp.TablePlus/Data/Connections.plist']);
	assert.deepEqual(tablePlusFiles(win), []);
	assert.deepEqual(tablePlusFiles(linux), []);
});

test('pgpass: $PGPASSFILE wins; pgpass.conf on Windows; ~/.pgpass elsewhere', () => {
	assert.deepEqual(pgpassFiles(win), ['C:\\Users\\me\\AppData\\Roaming\\postgresql\\pgpass.conf']);
	assert.deepEqual(pgpassFiles(mac), ['/Users/me/.pgpass']);
	assert.deepEqual(pgpassFiles(linux), ['/home/me/.pgpass']);
	assert.deepEqual(pgpassFiles({ ...linux, env: { PGPASSFILE: '/etc/pgpass' } }), ['/etc/pgpass']);
});

test('container sockets per platform, DOCKER_HOST first', () => {
	assert.deepEqual(containerSockets(win), ['\\\\.\\pipe\\docker_engine', '\\\\.\\pipe\\podman-machine-default']);
	const m = containerSockets(mac);
	for (const s of ['/var/run/docker.sock', '/Users/me/.docker/run/docker.sock', '/Users/me/.colima/default/docker.sock', '/Users/me/.local/share/containers/podman/machine/podman.sock', '/var/folders/xy/T/podman/podman-machine-default-api.sock']) {
		assert.ok(m.includes(s), s);
	}
	assert.deepEqual(containerSockets(linux), ['/var/run/docker.sock', '/run/user/1000/podman/podman.sock', '/run/user/1000/docker.sock', '/run/podman/podman.sock']);
	assert.equal(containerSockets({ ...linux, env: { DOCKER_HOST: 'unix:///custom/docker.sock' } })[0], '/custom/docker.sock');
	assert.equal(containerSockets({ ...win, env: { DOCKER_HOST: 'npipe:////./pipe/custom' } })[0], '\\\\.\\pipe\\custom');
});
