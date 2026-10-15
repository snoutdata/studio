/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { DatabaseSchema } from './schema';
import { emitTypeScriptTypes } from './typescriptTypes';

/**
 * A schema in, TypeScript out, compared exactly.
 *
 * The file this emitter produces is checked into customers' repositories and read by their
 * compiler, so a test that checks "it contains `Row`" checks nothing worth checking. The first case below is the shape, character for character;
 * the rest are the decisions (nullability, insert optionality, one-to-one, the type map).
 */

const posts: DatabaseSchema = {
	database: 'app',
	fetchedAt: 0,
	tables: [
		{
			name: 'posts',
			schema: 'public',
			kind: 'table',
			columns: [
				{ name: 'id', dataType: 'bigint', nullable: false, isPrimaryKey: true, autoIncrement: true },
				{ name: 'author_id', dataType: 'uuid', nullable: true, isPrimaryKey: false },
				{ name: 'body', dataType: 'text', nullable: false, isPrimaryKey: false },
				{ name: 'created_at', dataType: 'timestamp with time zone', nullable: false, isPrimaryKey: false, default: 'now()' }
			],
			primaryKey: ['id'],
			foreignKeys: [
				{
					constraintName: 'posts_author_id_fkey',
					columns: ['author_id'],
					referencedTable: 'users',
					referencedColumns: ['id']
				}
			]
		}
	]
};

const EXPECTED_POSTS = `export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      posts: {
        Row: {
          author_id: string | null
          body: string
          created_at: string
          id: number
        }
        Insert: {
          author_id?: string | null
          body: string
          created_at?: string
          id?: number
        }
        Update: {
          author_id?: string | null
          body?: string
          created_at?: string
          id?: number
        }
        Relationships: [
          {
            foreignKeyName: "posts_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}
`;

describe('emitTypeScriptTypes', () => {
	test('emits the Database block exactly, with helpers and constants switched off', () => {
		const out = emitTypeScriptTypes(posts, { helpers: false, constants: false });
		assert.equal(out, EXPECTED_POSTS);
	});

	test('columns and tables come out alphabetically, whatever order they arrive in', () => {
		const shuffled: DatabaseSchema = {
			...posts,
			tables: [
				{
					name: 'zebra',
					schema: 'public',
					kind: 'table',
					columns: [
						{ name: 'b', dataType: 'text', nullable: false, isPrimaryKey: false },
						{ name: 'a', dataType: 'text', nullable: false, isPrimaryKey: false }
					],
					primaryKey: [],
					foreignKeys: []
				},
				...posts.tables
			]
		};
		const out = emitTypeScriptTypes(shuffled, { helpers: false, constants: false });
		assert.ok(out.indexOf('      posts: {') < out.indexOf('      zebra: {'));
		assert.ok(out.indexOf('          a: string') < out.indexOf('          b: string'));
	});

	test('the helper block and Constants are on by default and name the default schema', () => {
		const out = emitTypeScriptTypes(posts);
		assert.ok(out.includes('type DefaultSchemaName = Extract<keyof Database, "public">\n'));
		assert.ok(out.includes('export type Tables<'));
		assert.ok(out.includes('export type TablesInsert<'));
		assert.ok(out.includes('export type TablesUpdate<'));
		assert.ok(out.includes('export type Enums<'));
		assert.ok(out.includes('export type CompositeTypes<'));
		assert.ok(out.endsWith('} as const\n'));
	});

	test('a column the database refuses a value for is never in Insert and Update, and typed in Row', () => {
		// GENERATED ALWAYS AS IDENTITY, or a computed column: Postgres refuses an insert naming it.
		const table = posts.tables[0];
		const schema: DatabaseSchema = {
			...posts,
			tables: [{ ...table, columns: table.columns.map((c) => (c.name === 'id' ? { ...c, generatedAlways: true } : c)) }]
		};
		const out = emitTypeScriptTypes(schema, { helpers: false, constants: false });
		assert.equal(out.match(/          id\?: never\n/g)?.length, 2);
		assert.ok(out.includes('        Row: {\n          author_id: string | null\n          body: string\n          created_at: string\n          id: number\n'));
	});

	test('no internals block is emitted: Database holds the schemas and nothing else', () => {
		const out = emitTypeScriptTypes(posts);
		assert.ok(out.includes('export type Database = {\n  public: {'));
		assert.ok(!/__Internal/.test(out));
	});

	test('a non-default schema gets its own block, and the default one is emitted even when empty', () => {
		const out = emitTypeScriptTypes(
			{
				database: 'app',
				fetchedAt: 0,
				tables: [
					{
						name: 'sessions',
						schema: 'auth',
						kind: 'table',
						columns: [{ name: 'id', dataType: 'uuid', nullable: false, isPrimaryKey: true }],
						primaryKey: ['id'],
						foreignKeys: []
					}
				]
			},
			{ helpers: false, constants: false }
		);
		assert.ok(out.includes('  auth: {'));
		assert.ok(out.includes('  public: {'));
		// The default schema has nothing in it, so every category is the empty placeholder.
		const publicBlock = out.slice(out.indexOf('  public: {'));
		assert.ok(publicBlock.includes('    Tables: {\n      [_ in never]: never\n    }'));
	});

	test('a view gets Row and Relationships, and no Insert or Update', () => {
		const out = emitTypeScriptTypes(
			{
				database: 'app',
				fetchedAt: 0,
				tables: [
					{
						name: 'recent',
						schema: 'public',
						kind: 'view',
						columns: [{ name: 'id', dataType: 'bigint', nullable: true, isPrimaryKey: false }],
						primaryKey: [],
						foreignKeys: []
					}
				]
			},
			{ helpers: false, constants: false }
		);
		assert.ok(out.includes('    Views: {\n      recent: {'));
		assert.ok(out.includes('        Row: {\n          id: number | null\n        }\n        Relationships: []'));
		assert.ok(!out.includes('Insert:'));
		assert.ok(!out.includes('Update:'));
	});

	test('isOneToOne is true when the referencing columns are themselves unique', () => {
		const oneToOne: DatabaseSchema = {
			database: 'app',
			fetchedAt: 0,
			tables: [
				{
					name: 'profile',
					schema: 'public',
					kind: 'table',
					columns: [{ name: 'user_id', dataType: 'uuid', nullable: false, isPrimaryKey: true }],
					primaryKey: ['user_id'],
					foreignKeys: [
						{
							constraintName: 'profile_user_id_fkey',
							columns: ['user_id'],
							referencedTable: 'users',
							referencedColumns: ['id']
						}
					]
				}
			]
		};
		assert.ok(emitTypeScriptTypes(oneToOne, { helpers: false, constants: false }).includes('isOneToOne: true'));

		// A unique INDEX counts too, and a non-unique one does not.
		const viaIndex = structuredClone(oneToOne) as DatabaseSchema;
		viaIndex.tables[0]!.primaryKey = [];
		viaIndex.tables[0]!.indexes = [{ name: 'profile_user_id_key', columns: ['user_id'], unique: true }];
		assert.ok(emitTypeScriptTypes(viaIndex, { helpers: false, constants: false }).includes('isOneToOne: true'));
		viaIndex.tables[0]!.indexes = [{ name: 'profile_user_id_idx', columns: ['user_id'], unique: false }];
		assert.ok(emitTypeScriptTypes(viaIndex, { helpers: false, constants: false }).includes('isOneToOne: false'));
	});

	test('enums become a union, a column reference, and a Constants array', () => {
		const withEnum: DatabaseSchema = {
			database: 'app',
			fetchedAt: 0,
			tables: [
				{
					name: 'keys',
					schema: 'public',
					kind: 'table',
					columns: [{ name: 'mode', dataType: 'key_mode', nullable: false, isPrimaryKey: false }],
					primaryKey: [],
					foreignKeys: []
				}
			]
		};
		const out = emitTypeScriptTypes(withEnum, {
			helpers: false,
			enums: [{ name: 'key_mode', values: ['admin', 'read', 'write'] }]
		});
		assert.ok(out.includes('          mode: Database["public"]["Enums"]["key_mode"]'));
		assert.ok(out.includes('    Enums: {\n      key_mode: "admin" | "read" | "write"\n    }'));
		assert.ok(out.includes('    Enums: {\n      key_mode: ["admin", "read", "write"],\n    },'));
	});

	test('an unmatched user-defined type is unknown, not a guess', () => {
		const out = emitTypeScriptTypes(
			{
				database: 'app',
				fetchedAt: 0,
				tables: [
					{
						name: 't',
						schema: 'public',
						kind: 'table',
						columns: [
							{ name: 'mood', dataType: 'USER-DEFINED', nullable: false, isPrimaryKey: false },
							{ name: 'tags', dataType: 'ARRAY', nullable: true, isPrimaryKey: false },
							{ name: 'names', dataType: 'text[]', nullable: false, isPrimaryKey: false },
							{ name: 'ints', dataType: '_int4', nullable: false, isPrimaryKey: false }
						],
						primaryKey: [],
						foreignKeys: []
					}
				]
			},
			{ helpers: false, constants: false }
		);
		assert.ok(out.includes('          mood: unknown'));
		assert.ok(out.includes('          tags: unknown[] | null'));
		assert.ok(out.includes('          names: string[]'));
		assert.ok(out.includes('          ints: number[]'));
	});

	test('functions carry their arguments and their return type', () => {
		const out = emitTypeScriptTypes(
			{
				database: 'app',
				fetchedAt: 0,
				tables: [],
				routines: [
					{
						name: 'add',
						schema: 'public',
						kind: 'function',
						returnType: 'integer',
						parameters: [
							{ name: 'b', dataType: 'integer', mode: 'IN' },
							{ name: 'a', dataType: 'integer', mode: 'IN' },
							{ name: 'out_total', dataType: 'integer', mode: 'OUT' }
						]
					},
					{ name: 'tick', schema: 'public', kind: 'procedure', parameters: [] }
				]
			},
			{ helpers: false, constants: false }
		);
		assert.ok(
			out.includes(
				'      add: {\n        Args: {\n          a: number\n          b: number\n        }\n        Returns: number\n      }'
			)
		);
		assert.ok(out.includes('      tick: {\n        Args: never\n        Returns: undefined\n      }'));
	});

	test('a return type that is not a column type is unwrapped', () => {
		const returns = (kind: 'function' | 'procedure', returnType?: string): string => {
			const out = emitTypeScriptTypes(
				{
					database: 'app',
					fetchedAt: 0,
					tables: [],
					routines: [{ name: 'f', schema: 'public', kind, returnType, parameters: [] }]
				},
				{ helpers: false, constants: false }
			);
			return out.split('\n').find((line) => line.trim().startsWith('Returns: '))!.trim();
		};
		assert.equal(returns('function', 'void'), 'Returns: undefined');
		assert.equal(returns('function', 'SETOF users'), 'Returns: unknown[]');
		assert.equal(returns('function', 'nosuchtype'), 'Returns: unknown');
		assert.equal(returns('function', 'SETOF integer'), 'Returns: number[]');
		assert.equal(returns('function', 'SETOF record'), 'Returns: Record<string, unknown>[]');
		assert.equal(returns('function', 'TABLE(a integer, b text)'), 'Returns: Record<string, unknown>[]');
		assert.equal(returns('function', 'trigger'), 'Returns: unknown');
		assert.equal(returns('function', 'jsonb'), 'Returns: Json');
		assert.equal(returns('procedure', 'integer'), 'Returns: undefined');
	});

	test('a function that returns a table returns that table Row', () => {
		const out = emitTypeScriptTypes(
			{
				database: 'app',
				fetchedAt: 0,
				tables: posts.tables,
				routines: [
					{ name: 'all_posts', schema: 'public', kind: 'function', returnType: 'SETOF posts', parameters: [] },
					{ name: 'one_post', schema: 'public', kind: 'function', returnType: 'posts', parameters: [] }
				]
			},
			{ helpers: false, constants: false }
		);
		assert.ok(out.includes('Returns: Database["public"]["Tables"]["posts"]["Row"][]'));
		assert.ok(out.includes('Returns: Database["public"]["Tables"]["posts"]["Row"]\n'));
	});

	test('the type map follows the driver where vendors disagree', () => {
		const flag = (driverId: string, dataType: string): string => {
			const out = emitTypeScriptTypes(
				{
					database: 'app',
					fetchedAt: 0,
					tables: [
						{
							name: 't',
							schema: 'public',
							kind: 'table',
							columns: [{ name: 'c', dataType, nullable: false, isPrimaryKey: false }],
							primaryKey: [],
							foreignKeys: []
						}
					]
				},
				{ driverId, helpers: false, constants: false }
			);
			return out.split('\n').find((line) => line.trim().startsWith('c: '))!.trim();
		};
		// `bit` is a bit string in Postgres and a boolean in SQL Server. It is the one name
		// that means two different things, which is why the per-driver table exists at all.
		assert.equal(flag('postgres', 'bit'), 'c: string');
		assert.equal(flag('sqlserver', 'bit'), 'c: boolean');
		assert.equal(flag('mysql-aurora', 'bit'), 'c: number');
		// The portable half, which is most of it.
		assert.equal(flag('postgres', 'jsonb'), 'c: Json');
		assert.equal(flag('mysql-aurora', 'json'), 'c: Json');
		assert.equal(flag('snowflake', 'variant'), 'c: Json');
		assert.equal(flag('oracle', 'NUMBER(19)'), 'c: number');
		assert.equal(flag('oracle', 'VARCHAR2(200 CHAR)'), 'c: string');
		assert.equal(flag('sqlserver', 'nvarchar(max)'), 'c: string');
		assert.equal(flag('postgres', 'character varying(255)'), 'c: string');
		assert.equal(flag('postgres', 'numeric(10,2)'), 'c: number');
		assert.equal(flag('postgres', 'boolean'), 'c: boolean');
		assert.equal(flag('sqlite', 'INTEGER'), 'c: number');
	});

	test('a column name that is not an identifier is quoted', () => {
		const out = emitTypeScriptTypes(
			{
				database: 'app',
				fetchedAt: 0,
				tables: [
					{
						name: 'odd-table',
						schema: 'public',
						kind: 'table',
						columns: [{ name: 'first name', dataType: 'text', nullable: false, isPrimaryKey: false }],
						primaryKey: [],
						foreignKeys: []
					}
				]
			},
			{ helpers: false, constants: false }
		);
		assert.ok(out.includes('      "odd-table": {'));
		assert.ok(out.includes('          "first name": string'));
	});

	test('a MySQL database is a schema like any other', () => {
		const out = emitTypeScriptTypes(
			{
				database: 'shop',
				fetchedAt: 0,
				tables: [
					{
						name: 'orders',
						schema: 'shop',
						kind: 'table',
						columns: [{ name: 'id', dataType: 'bigint', nullable: false, isPrimaryKey: true, autoIncrement: true }],
						primaryKey: ['id'],
						foreignKeys: []
					}
				]
			},
			{ driverId: 'mysql-aurora', defaultSchema: 'shop', constants: false }
		);
		assert.ok(out.includes('  shop: {'));
		assert.ok(out.includes('type DefaultSchemaName = Extract<keyof Database, "shop">'));
		assert.ok(out.includes('        Insert: {\n          id?: number\n        }'));
	});
	test('the helpers compile, and each resolves to the entry it names', () => {
		const schema: DatabaseSchema = {
			database: 'app',
			fetchedAt: 0,
			tables: [
				...posts.tables,
				{
					name: 'recent',
					schema: 'public',
					kind: 'view',
					columns: [{ name: 'id', dataType: 'bigint', nullable: true, isPrimaryKey: false }],
					primaryKey: [],
					foreignKeys: []
				},
				{
					name: 'events',
					schema: 'audit',
					kind: 'table',
					columns: [{ name: 'level', dataType: 'level', nullable: false, isPrimaryKey: false }],
					primaryKey: [],
					foreignKeys: []
				}
			]
		};
		const generated = emitTypeScriptTypes(schema, { enums: [{ name: 'level', schema: 'audit', values: ['info', 'warn'] }] })
			// Nothing introspects composite types, so one is written in by hand to exercise the helper.
			.replace(/( {2}public: \{[\s\S]*?)CompositeTypes: \{\n {6}\[_ in never\]: never\n {4}\}/, '$1CompositeTypes: {\n      address: { street: string | null }\n    }');
		assert.ok(generated.includes('address: { street'));
		const check = `import type { CompositeTypes, Database, Enums, Tables, TablesInsert, TablesUpdate } from './types.js'
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Holds<T extends true> = T
type Public = Database["public"]
type Audit = Database["audit"]
export type Checks = [
  Holds<Same<Tables<"posts">, Public["Tables"]["posts"]["Row"]>>,
  Holds<Same<Tables<"recent">, Public["Views"]["recent"]["Row"]>>,
  Holds<Same<Tables<"posts" | "recent">, Public["Tables"]["posts"]["Row"] | Public["Views"]["recent"]["Row"]>>,
  Holds<Same<TablesInsert<"posts">, Public["Tables"]["posts"]["Insert"]>>,
  Holds<Same<TablesUpdate<"posts">, Public["Tables"]["posts"]["Update"]>>,
  Holds<Same<Tables<{ schema: "audit" }, "events">, Audit["Tables"]["events"]["Row"]>>,
  Holds<Same<TablesInsert<{ schema: "audit" }, "events">, Audit["Tables"]["events"]["Insert"]>>,
  Holds<Same<TablesUpdate<{ schema: "audit" }, "events">, Audit["Tables"]["events"]["Update"]>>,
  Holds<Same<Enums<{ schema: "audit" }, "level">, "info" | "warn">>,
  Holds<Same<CompositeTypes<"address">, { street: string | null }>>,
]
// @ts-expect-error a view has no Insert
export type ViewInsert = TablesInsert<"recent">
// @ts-expect-error no such table
export type Missing = Tables<"nope">
// @ts-expect-error the table is in another schema
export type Elsewhere = Tables<{ schema: "audit" }, "posts">
// @ts-expect-error no such schema
export type NoSchema = Tables<{ schema: "nope" }, "posts">
`;
		const dir = mkdtempSync(join(tmpdir(), 'snout-typegen-'));
		try {
			writeFileSync(join(dir, 'types.ts'), generated);
			writeFileSync(join(dir, 'check.ts'), check);
			const tsc = require.resolve('typescript/bin/tsc');
			const args = [tsc, '--noEmit', '--strict', '--target', 'es2022', '--module', 'nodenext', '--moduleResolution', 'nodenext', 'check.ts'];
			const run = spawnSync(process.execPath, args, { cwd: dir, encoding: 'utf8', timeout: 60_000 });
			assert.equal(run.status, 0, run.stdout + run.stderr);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
