// SPDX-FileCopyrightText: 2026 Wallpapi contributors
// SPDX-License-Identifier: MIT OR LGPL-2.1-or-later

import {defineConfig} from '@eslint/config-helpers';
import globals from 'globals';
import gnome from './tools/eslint-config-gnome/index.js';

export default defineConfig([
    gnome.configs.recommended,
    gnome.configs.jsdoc,
    {
        ignores: [
            '.git/',
            '.opencode/',
            'docs/',
            'node_modules/',
            'schemas/gschemas.compiled',
        ],
    },
    {
        files: [
            'extension.js',
            'lib.js',
            'prefs.js',
            'themes.js',
            'tests/**/*.mjs',
            'scripts/**/*.mjs',
        ],
        languageOptions: {
            sourceType: 'module',
            globals: {
                ...globals.browser,
                global: 'readonly',
            },
        },
        rules: {
            'jsdoc/require-jsdoc': 'off',
            'jsdoc/require-param-description': 'off',
            'jsdoc/require-returns': 'off',
            'no-unused-vars': ['error', {
                varsIgnorePattern: '(^unused|_$)',
                argsIgnorePattern: '^(unused|_)',
                caughtErrorsIgnorePattern: '^(unused|_)',
            }],
        },
    },
    {
        files: [
            'tests/**/*.mjs',
        ],
        languageOptions: {
            sourceType: 'module',
        },
        rules: {
            'jsdoc/require-param': 'off',
            'jsdoc/require-param-type': 'off',
        },
    },
    {
        // tests/run.mjs loads test modules sequentially on purpose
        files: ['tests/run.mjs'],
        rules: {
            'no-await-in-loop': 'off',
        },
    },
]);
