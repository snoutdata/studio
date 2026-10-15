/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

import { awsCredentials } from './aws/credentials';
import type { AwsSecretConfig, ConnectionConfig } from '../shared/connection';

// Fetches DB credentials from AWS Secrets Manager so a connection can live behind AWS
// without a password ever being stored locally. AWS auth, in precedence order: an explicit
// access key id + secret access key (the secret is kept in the local keychain); a named
// profile from the shared AWS config; otherwise the SDK's default provider chain (env vars,
// SSO, EC2/ECS role). Only runs in the main process at connect/test time.

/** The credential fields we read out of a secret. Matches the JSON shape AWS RDS writes. */
export interface SecretFields {
	username?: string;
	password?: string;
	host?: string;
	port?: number;
	database?: string;
}

function pickString(record: Record<string, unknown>, ...keys: string[]): string | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === 'string' && value !== '') {
			return value;
		}
	}
	return undefined;
}

function pickPort(record: Record<string, unknown>): number | undefined {
	const value = record.port;
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
		return Number(value);
	}
	return undefined;
}

/** Read the secret string from AWS and parse the credential fields out of it. */
async function fetchSecretFields(aws: AwsSecretConfig, secretAccessKey: string | undefined): Promise<SecretFields> {
	const client = new SecretsManagerClient({
		region: aws.region,
		...awsCredentials(aws, secretAccessKey),
	});
	let secretString: string | undefined;
	try {
		const result = await client.send(new GetSecretValueCommand({ SecretId: aws.secretId }));
		secretString = result.SecretString;
	} catch (err) {
		throw new Error(`AWS Secrets Manager: ${err instanceof Error ? err.message : String(err)}`);
	} finally {
		client.destroy();
	}
	if (!secretString) {
		throw new Error(`AWS Secrets Manager: secret "${aws.secretId}" has no string value (binary secrets are not supported).`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(secretString);
	} catch {
		throw new Error(`AWS Secrets Manager: secret "${aws.secretId}" is not JSON (expected keys like "username" and "password").`);
	}
	if (!parsed || typeof parsed !== 'object') {
		throw new Error(`AWS Secrets Manager: secret "${aws.secretId}" is not a JSON object.`);
	}
	const record = parsed as Record<string, unknown>;
	return {
		username: pickString(record, 'username', 'user'),
		password: pickString(record, 'password'),
		host: pickString(record, 'host'),
		port: pickPort(record),
		database: pickString(record, 'database', 'dbname', 'dbName'),
	};
}

/** A host as written, compared without case, surrounding space or a trailing dot. */
function sameHost(a: string, b: string): boolean {
	const norm = (host: string): string => host.trim().toLowerCase().replace(/\.$/, '');
	return norm(a) === norm(b);
}

/**
 * The connection a secret's credentials are sent to. Username/password come from the secret.
 * When the secret names a host (an RDS-managed secret does), that host and its port are where
 * the credentials go: a connection that names a DIFFERENT host is refused rather than quietly
 * redirected, because otherwise a connection whose host someone else wrote (an imported
 * data-sources.json) could fetch the secret with the user's AWS credentials and send it there.
 * A secret with no host leaves the connection's host and port as they are. The database fills in
 * only when the connection has none: it does not change where the credentials go.
 */
export function mergeSecretFields(config: ConnectionConfig, fields: SecretFields, secretId: string): ConnectionConfig {
	if (!fields.username && !fields.password) {
		throw new Error(`AWS Secrets Manager: secret "${secretId}" has no "username" or "password" field.`);
	}
	const merged: ConnectionConfig = {
		...config,
		username: fields.username ?? config.username,
		password: fields.password ?? config.password,
		database: config.database || fields.database,
	};
	if (!fields.host) {
		return { ...merged, host: config.host || '', port: config.port || fields.port || 0 };
	}
	const given = config.host?.trim() ?? '';
	if (given !== '' && !sameHost(given, fields.host)) {
		throw new Error(`AWS Secrets Manager: secret "${secretId}" is for the database at "${fields.host}", but this connection points at "${given}", so its credentials were not sent. Clear the host on the connection to use the secret's, or set it to "${fields.host}".`);
	}
	return { ...merged, host: fields.host, port: fields.port || config.port || 0 };
}

/** Return a copy of `config` with credentials (and, when the secret names one, the address) filled from its AWS secret. */
export async function applyAwsSecret(config: ConnectionConfig, aws: AwsSecretConfig, secretAccessKey?: string): Promise<ConnectionConfig> {
	return mergeSecretFields(config, await fetchSecretFields(aws, secretAccessKey), aws.secretId);
}
