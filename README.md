# NPI SnapWalk

**Your factory visit partner**

NPI SnapWalk is a single-file, mobile-first web app for factory visits. It replaces
paper notes with a structured on-device workflow and produces an Excel report at the
end of the visit.

Internal project code: 190E (repository documentation and code comments only; never
shown in the user interface).

> The product name is **provisional** and pending a trademark check. No registered or
> unregistered trademark claim is made.

## Live address

https://npi-snapwalk.pages.dev

## What it does

- **Engineering Build report** - record observations by category, set status, attach one
  photo per observation, and export a formatted Excel workbook.
- **Run@Rate capacity report** - capture line, shift and capacity data for up to five
  production lines, compare plan and actual capacity, and export the assessment.
- Photos are compressed on device, stored as blobs in IndexedDB, and re-attached to the
  workbook on export.
- Drafts are saved automatically in the browser and restored when the app is reopened.
- "Same as Above" lets a row inherit observation fields from the row above.

The app is fully client-side. There is no backend, no account, and no telemetry.

## Data storage

All data stays in the browser on the device:

- `localStorage` holds draft text, numbers and lightweight photo metadata.
- `IndexedDB` holds the compressed photo blobs.
- `sessionStorage` holds a small per-session UI flag.

Nothing is uploaded. Clearing site data for the app removes all saved drafts and photos.
Because each deployment origin has its own storage, drafts do not move between origins.

## Supported browsers

- Chrome, Edge and Safari (current and previous major version), desktop and mobile.
- iOS Safari 15+ and Android Chrome 100+ for camera capture.
- IndexedDB and `Blob` support are required. Without IndexedDB the app still runs, but
  photos are kept in memory for the current session only.

## Build

Requires Node.js 18 or newer. There are no runtime dependencies to install; ExcelJS and
FileSaver are loaded from CDN when the built page is opened online.

```
node build/build-html.js
```

Outputs:

- `dist/index.html` - deployment artifact
- `NPI_SnapWalk_V23.16.00.html` - identical versioned copy

## Repository layout

```
src/config/app-config.js   product identity, version, storage prefix
src/config/constants.js    application constants and storage keys
src/calc/                  Run@Rate calculation and formatting
src/export/                Excel helpers and design tokens
src/state/                 normalization and persistence utilities
src/main.js                application logic and UI wiring
src/template.html          HTML shell, styles and build placeholder
build/build-html.js        single-file build script
```

## Licensing

No license has been chosen yet, so no LICENSE file is included.

> The app name NPI SnapWalk is provisional (trademark check pending). All data is stored locally in the browser.
