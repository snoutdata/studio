/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Connection contracts shared by the extension host (client) and the language
// server. Pure types only — no runtime dependencies — so both packages can import
// them. The first DB target is MySQL/Aurora over an optional SSH tunnel.

import type { CloudAccount } from './cloud';
import type { NativeRuntime } from './components';
import type { DataAccessLevel } from './engine';

export interface SshTunnelConfig {
	/** SSH host (the bastion/jump box that can reach the DB cluster). */
	host: string;
	/** SSH port. Default 22. */
	port?: number;
	username: string;
	/** Path to a private key file (preferred). */
	privateKeyPath?: string;
	/** Passphrase for the private key, if any. */
	passphrase?: string;
	/** Password auth (discouraged; prefer keys). */
	password?: string;
	/** Local bind port. Omit to auto-allocate. */
	localPort?: number;
	/** Send SSH-level keepalives so the bastion (and any NLB in front of it) doesn't
	 *  idle-out the session and silently kill the tunnel. Defaults to on; omitted/undefined
	 *  is treated as enabled. Set false only if a bastion rejects keepalive traffic. */
	keepAlive?: boolean;
	/** The SSH server's host-key fingerprint (`SHA256:...`) the tunnel must see. Not stored on
	 *  the connection: main fills it in at connect time from what it remembered for this SSH host
	 *  and port (trust on first use), and the tunnel refuses a different key. Absent = first use. */
	hostKeyFingerprint?: string;
}

/**
 * A reusable, named SSH tunnel definition that many connections can share. Stored
 * separately from connections; a connection points at one via
 * {@link ConnectionConfig.sshTunnelRef}. Secrets (key passphrase / SSH password) live in
 * the keychain keyed by the profile id, never here. Resolved to a concrete
 * {@link SshTunnelConfig} in main at connect time, so the server is unchanged.
 */
export interface SshTunnelProfile {
	/** Stable id; referenced by ConnectionConfig.sshTunnelRef and keys the profile's secrets. */
	id: string;
	/** Human label shown in the picker, e.g. "prod bastion". */
	name: string;
	host: string;
	port?: number;
	username: string;
	privateKeyPath?: string;
	keepAlive?: boolean;
}

/**
 * Pull the DB credentials from AWS Secrets Manager at connect time instead of storing a
 * password locally. The fetched secret is expected to be JSON (the shape AWS RDS writes:
 * `username`/`password`, optionally `host`/`port`/`dbname`); username/password override the
 * connection's. A `host` in the secret is where the credentials go, with its `port`: a connection
 * that names a different host is refused (awsSecrets.ts). `dbname` fills in only a blank database.
 */
export interface AwsSecretConfig {
	/** AWS region the secret lives in, e.g. 'us-east-1'. */
	region: string;
	/** Secret name or full ARN in AWS Secrets Manager. */
	secretId: string;
	/** Named profile from the shared AWS config/credentials file. Omit to use the default
	 *  provider chain (env vars, SSO, EC2/ECS role). */
	profile?: string;
	/** Explicit IAM access key id. Paired with a secret access key kept in the secret store;
	 *  when both are present they take precedence over the profile / default chain. */
	accessKeyId?: string;
}

/**
 * TLS settings for a connection. `rejectUnauthorized` controls whether the server
 * certificate is verified. The CA the cert is checked against is chosen by `caBundle`
 * (the app-bundled Amazon RDS global CA) or `caPath` (a user-supplied .pem); both are
 * resolved to the actual PEM in `ca` by the main process at connect time (the server
 * only ever sees `rejectUnauthorized` + `ca`). With neither set, the system trust store
 * is used.
 */
export interface SslConfig {
	/** Verify the server certificate. False = encrypt but accept any cert. */
	rejectUnauthorized?: boolean;
	/** Resolved CA certificate PEM the driver verifies against (filled in main). */
	ca?: string;
	/** Use the app-bundled Amazon RDS global CA bundle (resolved to `ca` in main). */
	caBundle?: 'rds';
	/** Path to a custom CA certificate .pem file (resolved to `ca` in main). */
	caPath?: string;
}

export type DatabaseEnvironment = 'dev' | 'stage' | 'prod' | (string & {});

export interface ConnectionConfig {
	/** Stable id; used as the schema-cache key. */
	id: string;
	/** Human label shown in the UI. */
	label: string;
	/** Driver id, e.g. 'mysql-aurora'. Must match a registered DatabaseDriver. */
	driver: string;
	/** The wire-compatible engine this really is (CockroachDB on `postgres`, TiDB on `mysql-aurora`).
	 *  Names only: behaviour is the driver's. See engine/dialect/flavors.ts. */
	flavor?: string;
	/** DB host as seen from the tunnel endpoint (or directly, if no tunnel). */
	host: string;
	/** DB port, e.g. 3306. */
	port: number;
	database?: string;
	username: string;
	/** Scaffold-only: real secrets belong in SecretStorage (ROADMAP phase a). */
	password?: string;
	ssl?: boolean | SslConfig;
	/** Inline (connection-private) SSH tunnel. Mutually exclusive with `sshTunnelRef`. */
	sshTunnel?: SshTunnelConfig;
	/** Reference a saved {@link SshTunnelProfile} by id instead of an inline tunnel. Resolved
	 *  to a concrete `sshTunnel` in main at connect time; the two are mutually exclusive. */
	sshTunnelRef?: string;
	/** When set, DB credentials are fetched from AWS Secrets Manager at connect time
	 *  rather than read from the local secret store. */
	awsSecret?: AwsSecretConfig;
	/** Set when an IMPORT saved this connection with {@link awsSecret}: it does not connect until
	 *  a person has opened it and saved it from the connection form, since its host and secret came
	 *  from another tool's file and connecting fetches the secret with the user's own AWS
	 *  credentials. Only that save clears it; an edit by the assistant or an agent does not. */
	awsSecretUnconfirmed?: boolean;
	/** The same, for an IMPORT that connects through an SSH tunnel: the tunnel's server and the key
	 *  it signs in with came from another tool's file, and connecting signs in there with the user's
	 *  own key and sends the database login through it. */
	sshTunnelUnconfirmed?: boolean;
	/** Drives env labels and prod guardrails later (DEV/STAGE/PROD). */
	environment?: DatabaseEnvironment;
	/** When true, writes/DDL are blocked and in-grid editing is disabled (a per-
	 *  connection safety net — stricter than the prod-confirm guard). */
	readOnly?: boolean;
	/** What the AI may see of THIS database, overriding Settings → AI for it (absent: use that
	 *  default). Applies to the assistant and to agents over MCP; engine/context/dataAccess.ts. */
	aiDataAccess?: DataAccessLevel;
	/** Resolved native-driver runtime (stock-Node binary + native module path + env), filled in
	 *  main at connect time for drivers whose client ships as a downloaded component (e.g. Db2's
	 *  ibm_db sidecar). Never persisted; the server passes it to the driver's sidecar. */
	nativeRuntime?: NativeRuntime;
	/** Pinecone (vector backend): the data-plane API version sent on requests.
	 *  Optional; the driver defaults to a known-good version. The API key is the connection's
	 *  resolved `password`; index hosts are discovered from the control plane, not configured. */
	pineconeApiVersion?: string;
	/** Snowflake: the virtual warehouse to run queries on (Snowflake needs a running warehouse to
	 *  execute a query). Carried like a non-secret field; the driver passes it to the session. */
	warehouse?: string;
	/** Snowflake: the role to assume for the session (optional; defaults to the user's default role). */
	role?: string;
	/**
	 * TELEMETRY connections: the saved {@link CloudAccount} this connection authenticates as, by id.
	 *
	 * A REFERENCE and not a copy, and a VENDOR credential rather than a telemetry one: the account
	 * the user set up once for a Data Flow's S3 bucket is the same account a CloudWatch connection
	 * uses, and the next AWS service will be the same one again. The rule it follows (see `cloud.ts`):
	 * an account is a vendor, and which SERVICE it is pointed at is decided here, by the
	 * connection's driver id.
	 */
	cloudAccountId?: string;
	/**
	 * The container within that account this connection reads: an AWS region, an Azure Log Analytics
	 * workspace id, a GCP project id.
	 *
	 * One field rather than three because it is one CONCEPT — "which of this account's worlds" — and
	 * only the driver knows what its vendor calls it (`TelemetryServiceInfo.containerNoun`, which is
	 * what labels the form field).
	 */
	cloudScope?: string;
	/**
	 * The scopes (log groups, tables, log names) this connection exposes as tables, NAMED by hand
	 * instead of enumerated.
	 *
	 * Empty, which is the normal case, means "every scope in the container", discovered by asking
	 * the provider. It exists because enumerating is its own permission and a great many real
	 * credentials do not have it: an IAM policy scoped to the four log groups a team owns grants
	 * `logs:FilterLogEvents` on those four and denies `logs:DescribeLogGroups` account-wide, and
	 * such a credential can read every event the user wants and could not connect at all. Naming
	 * the scopes replaces the call that needs the permission, rather than working around it.
	 */
	cloudScopes?: string[];
	/**
	 * The account itself, RESOLVED in main at connect time from {@link cloudAccountId}. Never
	 * persisted and never sent to the renderer — the same rule `nativeRuntime` and `SslConfig.ca`
	 * follow: the server child is handed what it needs, already looked up.
	 */
	cloudAccount?: CloudAccount;
	/**
	 * That account's secret, resolved from the keychain in main. Never persisted, exactly as a DB
	 * password is not: {@link password} is the pattern this copies.
	 */
	cloudSecret?: string;
	/**
	 * The SnoutData Cloud project this connection was imported from, by ref.
	 *
	 * A TAG and not a mode. Everything below the sidebar treats this as an ordinary
	 * connection — same driver, same pool, same guard, same secret store — and nothing
	 * reads this field to behave differently. It exists for two things only: a second
	 * import UPDATES the connection instead of making a duplicate beside it, and a
	 * password reset in the cloud can be pulled down again in one click without the user
	 * hunting for which of their connections it was.
	 *
	 * That is what keeps a standing rule cheap (nothing that already works may break): a hosted database
	 * is not a new kind of connection, so nothing that already works can be broken by one.
	 */
	cloudProjectRef?: string;
	/**
	 * Set on the database of a LOCAL project (the SnoutData stack in the user's own Docker): the
	 * project's id in `userData/localProjects.json`. A tag, like `cloudProjectRef`: the panel finds
	 * the connection by it, and the explorer draws the butterfly and hides the platform's schemas
	 * for it.
	 */
	localProjectId?: string;
	/** Max simultaneous connections the driver's pool opens to this database (the "Connection pool
	 *  size" setting). Absent = {@link DEFAULT_POOL_MAX}; always run through {@link clampPoolMax} at
	 *  the pool-build site so it stays within [{@link MIN_POOL_MAX}, {@link MAX_POOL_MAX}]. The DB's
	 *  own `max_connections` is the real ceiling; this only caps our end. Background work (schema
	 *  poll, monitors) runs on a separate small pool and does not count against this. */
	poolMax?: number;
}

/** Default interactive-pool size when a connection sets no {@link ConnectionConfig.poolMax}. */
export const DEFAULT_POOL_MAX = 4;
/** Lower bound for the "Connection pool size" setting. */
export const MIN_POOL_MAX = 4;
/** Upper bound for the "Connection pool size" setting — enough for heavy monitors without
 *  inviting exhaustion of a shared server's `max_connections`. */
export const MAX_POOL_MAX = 16;

/**
 * Single source of truth for the interactive-pool size: default when unset, and clamped into
 * [{@link MIN_POOL_MAX}, {@link MAX_POOL_MAX}] so every driver's `makePool` agrees on the bounds.
 * Non-finite/NaN input falls back to the default.
 */
export function clampPoolMax(poolMax?: number): number {
	if (poolMax === undefined || !Number.isFinite(poolMax)) {
		return DEFAULT_POOL_MAX;
	}
	return Math.min(MAX_POOL_MAX, Math.max(MIN_POOL_MAX, Math.floor(poolMax)));
}
