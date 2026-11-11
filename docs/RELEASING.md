# Publishing a release

DeskThing installs and updates apps from a GitHub repository's releases. Each release needs two files attached: the app zip and `latest.json`. `npm run build` makes both.

## One-time setup

1. Create the public repository **andy-iiiiv/agentthing** on GitHub.
2. Push this project to it (`main` branch).

The manifest (`deskthing/manifest.json`) already points `repository`, `homepage` and `updateUrl` at that repo. Until the repo exists, `npm run build` warns that the URL "is not valid"; that goes away once it's public.

## Each release

1. Bump the version in **both** `package.json` and `deskthing/manifest.json` (they must match; the Car Thing reloads itself when the server's version changes).
2. Build:
   ```sh
   npm run typecheck
   npm run build
   ```
   This writes `dist/agentthing-v<version>.zip` and `dist/latest.json`. `latest.json` holds the version, the zip's SHA-512 hash and its download URL (`…/releases/latest/download/agentthing-v<version>.zip`), so build last, after any change.
3. Commit, tag and push:
   ```sh
   git tag v<version>
   git push origin main --tags
   ```
4. On GitHub, create a release from the tag `v<version>` and attach **both** `dist/agentthing-v<version>.zip` and `dist/latest.json`. Mark it as the latest release.

Anyone who added the repo in DeskThing then sees the update.

## Getting into DeskThing's main app list

DeskThing's built-in list of community apps comes from Riprod's official apps repository. Once a few people have used AgentThing, ask Riprod (the DeskThing author) to add `https://github.com/andy-iiiiv/agentthing`, through the DeskThing Discord or the official apps repo. Until then, people add it by URL (see [SETUP.md](SETUP.md)).

## Before each release, check

- `npm run typecheck` passes, and the `?mock` preview looks right (`npm run dev:vite`, then `http://localhost:5173/?mock`).
- No personal names or paths in sample data (`src/mock.ts`, `scripts/simulate.mjs`) or screenshots (`docs/images/`).
- README and SETUP still match the settings in `server/index.ts`.
