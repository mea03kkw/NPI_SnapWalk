#!/usr/bin/env node
/**
 * Build Script - NPI SnapWalk (internal project code 190E)
 *
 * Assembles the single-file deployment artifact from modular source.
 *
 * Source modules are concatenated and injected into the HTML template
 * to produce dist/index.html plus the versioned copy
 * NPI_SnapWalk_V2.3.16.00.html in the project root, the root index.html
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
const VERSIONED_OUTPUT = path.join(ROOT, 'NPI_SnapWalk_V2.3.16.00.html');
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

    const ICONS_SRC = path.join(ROOT, 'assets', 'icons');
    const R9_ASSETS_SRC = path.join(ROOT, 'assets', 'pixel-r9');
    const copyDir = (from, to) => {
        if (!fs.existsSync(from)) return;
        fs.mkdirSync(to, { recursive: true });
        for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
            const source = path.join(from, entry.name);
            const target = path.join(to, entry.name);
            if (entry.isDirectory()) copyDir(source, target);
            else fs.copyFileSync(source, target);
        }
    };
    const copyFile = (from, to) => {
        if (!fs.existsSync(from)) return;
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
    };

    copyDir(ICONS_SRC, path.join(PUBLIC_DIR, 'assets', 'icons'));
    copyDir(ICONS_SRC, path.join(DIST_DIR, 'assets', 'icons'));
    copyDir(R9_ASSETS_SRC, path.join(PUBLIC_DIR, 'assets', 'pixel-r9'));
    copyDir(R9_ASSETS_SRC, path.join(DIST_DIR, 'assets', 'pixel-r9'));
    copyFile(path.join(PUBLIC_DIR, 'manifest.webmanifest'), path.join(DIST_DIR, 'manifest.webmanifest'));
    copyFile(path.join(PUBLIC_DIR, 'manifest.webmanifest'), path.join(ROOT, 'manifest.webmanifest'));
    copyFile(path.join(ROOT, 'favicon.ico'), path.join(PUBLIC_DIR, 'favicon.ico'));
    copyFile(path.join(ROOT, 'favicon.ico'), path.join(DIST_DIR, 'favicon.ico'));

    const r9Refs = [...new Set(output.match(/assets\/pixel-r9\/[A-Za-z0-9_.\/-]+/g) || [])];
    const missingR9 = r9Refs.filter(p => !fs.existsSync(path.join(ROOT, p)));
    if (missingR9.length) {
        console.error('ERROR: Missing R9 assets referenced by the template:');
        for (const p of missingR9) console.error('  ' + p);
        process.exit(1);
    }
    for (const outDir of [PUBLIC_DIR, DIST_DIR]) {
        const missingCopied = r9Refs.filter(p => !fs.existsSync(path.join(outDir, p)));
        if (missingCopied.length) {
            console.error('ERROR: R9 assets missing from ' + outDir + ':');
            for (const p of missingCopied) console.error('  ' + p);
            process.exit(1);
        }
    }

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
