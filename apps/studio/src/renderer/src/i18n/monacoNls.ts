/*---------------------------------------------------------------------------------------------
 *  Copyright (c) 2026 SNOUTDATA INC. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The text Monaco draws itself: the find box, the right-click menu, the suggestion list. Its ESM build
// has no translations, so electron.vite.config.ts makes its one `_format` look the English sentence up
// here. Keyed by the English, so a Monaco upgrade can only leave a changed sentence in English.
//
// Imported before Monaco, because Monaco reads many of these while its modules load. So this is what
// was chosen at launch: it follows a change of language on the next launch. Only what a user can see.

type Table = Record<string, string>;

const FR: Table = {
	'Cut': 'Couper', 'Copy': 'Copier', 'Paste': 'Coller', 'Command Palette': 'Palette de commandes',
	'Go to Definition': 'Atteindre la définition', 'Go to References': 'Atteindre les références', 'Peek': 'Aperçu',
	'Peek Definition': 'Aperçu de la définition', 'Peek References': 'Aperçu des références', 'Rename Symbol': 'Renommer le symbole',
	'Change All Occurrences': 'Modifier toutes les occurrences', 'Format Document': 'Mettre le document en forme', 'Format Selection': 'Mettre la sélection en forme',
	'Find': 'Rechercher', 'Replace': 'Remplacer', 'Replace All': 'Tout remplacer', 'Previous Match': 'Résultat précédent', 'Next Match': 'Résultat suivant',
	'Close': 'Fermer', 'Find in Selection': 'Rechercher dans la sélection', 'Toggle Replace': 'Afficher ou masquer Remplacer', 'No results': 'Aucun résultat', '{0} of {1}': '{0} sur {1}',
	'Find / Replace': 'Rechercher et remplacer', 'Match Case': 'Respecter la casse', 'Match Whole Word': 'Mot entier', 'Use Regular Expression': 'Expression régulière', 'Preserve Case': 'Conserver la casse',
	'Loading...': 'Chargement...', 'No suggestions.': 'Aucune suggestion.', 'Toggle Line Comment': 'Commenter ou décommenter la ligne', 'Toggle Block Comment': 'Commenter ou décommenter le bloc',
	'No references found': 'Aucune référence trouvée', 'No definition found': 'Aucune définition trouvée', 'No result.': 'Aucun résultat.',
};

const ES: Table = {
	'Cut': 'Cortar', 'Copy': 'Copiar', 'Paste': 'Pegar', 'Command Palette': 'Paleta de comandos',
	'Go to Definition': 'Ir a la definición', 'Go to References': 'Ir a las referencias', 'Peek': 'Vista rápida',
	'Peek Definition': 'Ver la definición', 'Peek References': 'Ver las referencias', 'Rename Symbol': 'Cambiar el nombre del símbolo',
	'Change All Occurrences': 'Cambiar todas las apariciones', 'Format Document': 'Dar formato al documento', 'Format Selection': 'Dar formato a la selección',
	'Find': 'Buscar', 'Replace': 'Reemplazar', 'Replace All': 'Reemplazar todo', 'Previous Match': 'Resultado anterior', 'Next Match': 'Resultado siguiente',
	'Close': 'Cerrar', 'Find in Selection': 'Buscar en la selección', 'Toggle Replace': 'Mostrar u ocultar Reemplazar', 'No results': 'Sin resultados', '{0} of {1}': '{0} de {1}',
	'Find / Replace': 'Buscar y reemplazar', 'Match Case': 'Coincidir mayúsculas y minúsculas', 'Match Whole Word': 'Palabra completa', 'Use Regular Expression': 'Expresión regular', 'Preserve Case': 'Conservar mayúsculas y minúsculas',
	'Loading...': 'Cargando...', 'No suggestions.': 'Sin sugerencias.', 'Toggle Line Comment': 'Comentar o descomentar la línea', 'Toggle Block Comment': 'Comentar o descomentar el bloque',
	'No references found': 'No se encontraron referencias', 'No definition found': 'No se encontró la definición', 'No result.': 'Sin resultados.',
};

const PT: Table = {
	'Cut': 'Recortar', 'Copy': 'Copiar', 'Paste': 'Colar', 'Command Palette': 'Paleta de comandos',
	'Go to Definition': 'Ir para a definição', 'Go to References': 'Ir para as referências', 'Peek': 'Espiar',
	'Peek Definition': 'Espiar a definição', 'Peek References': 'Espiar as referências', 'Rename Symbol': 'Renomear símbolo',
	'Change All Occurrences': 'Alterar todas as ocorrências', 'Format Document': 'Formatar documento', 'Format Selection': 'Formatar seleção',
	'Find': 'Localizar', 'Replace': 'Substituir', 'Replace All': 'Substituir tudo', 'Previous Match': 'Resultado anterior', 'Next Match': 'Próximo resultado',
	'Close': 'Fechar', 'Find in Selection': 'Localizar na seleção', 'Toggle Replace': 'Mostrar ou ocultar Substituir', 'No results': 'Nenhum resultado', '{0} of {1}': '{0} de {1}',
	'Find / Replace': 'Localizar e substituir', 'Match Case': 'Diferenciar maiúsculas de minúsculas', 'Match Whole Word': 'Palavra inteira', 'Use Regular Expression': 'Expressão regular', 'Preserve Case': 'Preservar maiúsculas e minúsculas',
	'Loading...': 'Carregando...', 'No suggestions.': 'Nenhuma sugestão.', 'Toggle Line Comment': 'Comentar ou descomentar a linha', 'Toggle Block Comment': 'Comentar ou descomentar o bloco',
	'No references found': 'Nenhuma referência encontrada', 'No definition found': 'Nenhuma definição encontrada', 'No result.': 'Nenhum resultado.',
};

const TABLES: Record<string, Table> = { fr: FR, es: ES, pt: PT };

const table = TABLES[window.sqlApi?.languageState?.().locale ?? 'en'];
if (table) {
	(globalThis as unknown as { __snoutMonacoNls?: Table }).__snoutMonacoNls = table;
}
