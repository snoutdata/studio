/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { catalogOf } from '../../../shared/i18n/core';

// The fr catalog, one chunk, loaded by loadLocale().
export default catalogOf(import.meta.glob(['../../../shared/i18n/fr/*.json', '!../../../shared/i18n/fr/main*.json'], { eager: true, import: 'default' }));
