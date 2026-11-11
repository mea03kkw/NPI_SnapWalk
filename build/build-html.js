#!/usr/bin/env node
/**
 * Build Script - NPI SnapWalk (internal project code 190E)
 *
 * Assembles the single-file deployment artifact from modular source.
 *
 * Source modules are concatenated and injected into the HTML template
 * to produce dist/index.html plus the versioned copy
 * NPI_SnapWalk_V23.16.00.html in the project root, the root index.html
 * used by GitHub Pages, and public/index.html used by Cloudflare Pages.
 *
 * Usage:
 *   node build/build-html.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TEMPLATE = path.join(ROOT, 'src', 'template.html');
const DIST_DIR = path.join(ROOT, 'dist');
const DIST_OUTPUT = path.join(DIST_DIR, 'index.html');
const ROOT_OUTPUT = path.join(ROOT, 'index.html');
const VERSIONED_OUTPUT = path.join(ROOT, 'NPI_SnapWalk_V23.16.00.html');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PUBLIC_OUTPUT = path.join(PUBLIC_DIR, 'index.html');

const MODULES = [
    'src/config/app-config.js',
    'src/config/constants.js',
    'src/export/design-tokens.js',
    'src/export/excel-helpers.js',
    'src/calc/rnr-formatters.js',
    'src/calc/run-rate-calc.js',
    'src/state/rnr-factories.js',
    'src/state/persistence-utils.js',
    'src/state/normalization.js',
    'src/main.js'
];

const PLACEHOLDER = '/* __BUILD_MODULES__ */';

function build() {
    if (!fs.existsSync(TEMPLATE)) {
        console.error('ERROR: Template not found at', TEMPLATE);
        process.exit(1);
    }
    const template = fs.readFileSync(TEMPLATE, 'utf8');

    if (!template.includes(PLACEHOLDER)) {
        console.error('ERROR: Placeholder "' + PLACEHOLDER + '" not found in template.');
        process.exit(1);
    }

    const parts = [];
    for (const mod of MODULES) {
        const fullPath = path.join(ROOT, mod);
        if (!fs.existsSync(fullPath)) {
            console.error('ERROR: Module not found:', fullPath);
            process.exit(1);
        }
        parts.push(fs.readFileSync(fullPath, 'utf8'));
    }
    const assembled = parts.join('\n\n');

    const output = template.replace(PLACEHOLDER, assembled);

    fs.mkdirSync(DIST_DIR, { recursive: true });
    fs.writeFileSync(DIST_OUTPUT, output, 'utf8');
    fs.writeFileSync(ROOT_OUTPUT, output, 'utf8');
    fs.writeFileSync(VERSIONED_OUTPUT, output, 'utf8');
    fs.mkdirSync(PUBLIC_DIR, { recursive: true });
    fs.writeFileSync(PUBLIC_OUTPUT, output, 'utf8');

    const lines = output.split('\n').length;
    console.log('Build complete.');
    console.log('  Output:     ' + DIST_OUTPUT);
    console.log('  Pages root: ' + ROOT_OUTPUT);
    console.log('  Versioned:  ' + VERSIONED_OUTPUT);
    console.log('  CF Pages:   ' + PUBLIC_OUTPUT);
    console.log('  Lines:      ' + lines);
    console.log('  Size:       ' + (Buffer.byteLength(output, 'utf8') / 1024).toFixed(1) + ' KB');
    console.log('  Modules concatenated: ' + MODULES.length);
}

build();
