# HearthCade desktop app

A thin [Tauri](https://tauri.app) shell for Windows, macOS and Linux whose window opens `https://hearthcade.com`. It
holds no copy of the web app: every web deploy (frontend and backend) reaches it the next time a page loads. Read
[docs/apps.md](../docs/apps.md) first. Features are specified and built for the web only, never here.

| File | What it is |
| --- | --- |
| `src-tauri/src/main.rs` | The window, which links stay inside it, `window.hearthcadeShell` for the page, and the shell updater |
| `src-tauri/tauri.conf.json` | Name, icons, installers, the updater endpoint and public key. `version` comes from `package.json` |
| `src-tauri/capabilities/remote.json` | The one native call the site may make (follow a game into full screen on Windows) |
| `shell/index.html` | The local page the build requires. The window never shows it |
| `release-manifests.mjs` | Writes `latest.json` (updater) and `hearthcade-desktop.json` (Get the app page) for a release |

## Releasing a new shell

Only change the shell for something the web cannot do. Then bump `version` in `package.json` and merge to `main`:
`.github/workflows/desktop.yml` builds the installers on Windows, macOS and Linux runners and publishes the GitHub
release `desktop-v<version>`. The site serves its files at `/download/desktop/<windows|mac|linux|linux-deb>` and the
updater manifest at `/download/desktop/latest.json` (`src/desktop.ts`). Installed apps check at launch and every six
hours, download in the background and install when the player quits.

## Signing

- **Installers are not code-signed.** There is no Windows certificate and no Apple Developer ID, so Windows SmartScreen
  and macOS Gatekeeper ask the player to confirm the first time. `/download` explains how. The macOS app is ad-hoc
  signed (`signingIdentity: "-"`) so Apple silicon does not call it damaged.
- **Shell updates are signed** with a free key pair made by `npx tauri signer generate`. The public key is in
  `tauri.conf.json`. The private key goes in the repository secret `TAURI_SIGNING_PRIVATE_KEY` (Settings, Secrets and
  variables, Actions), with `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` only if it has a password. Without the secret, releases
  have no `latest.json` and installed apps keep the shell they have (they still get every web change). If the private
  key is ever lost, make a new pair, put the new public key here, and players install the next version by hand once.

## Building locally

```sh
cd desktop && npm ci
npx tauri build --bundles deb,appimage      # Linux: needs libwebkit2gtk-4.1-dev, see the workflow
npx tauri dev                                # a window onto hearthcade.com
```
