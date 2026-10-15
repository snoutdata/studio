/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DatabaseDriver } from '../databaseDriver';
import { createMySqlFamilyDriver } from '../mysql/mysqlAuroraDriver';

/**
 * MariaDB driver. MariaDB is a MySQL fork the `mysql2` client speaks to directly and whose
 * INFORMATION_SCHEMA introspection matches MySQL's, so it re-uses the MySQL-family driver
 * wholesale; only the id + display name differ. The `mariadb` Dialect (src/shared/engine/dialect)
 * carries the small surface differences (display name + sql-formatter language).
 */
export function createMariaDbDriver(): DatabaseDriver {
	return createMySqlFamilyDriver('mariadb', 'MariaDB');
}
