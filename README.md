# CHICTool Desktop App

Electron desktop application for the Angular frontend in the sibling `../chictool-web` project. It no longer depends on the legacy `chictool` project folder.

Electron owns its SQLite implementation in `src/database.js` and its development database at `data/pcinfo.db`. SQLite columns, database API fields, and fields passed between Angular and Electron use camelCase (for example, `serialNumber` and `computerId`).

The first launch lets you create a local account if no users exist; later launches require signing in. Development uses `chictool-app/data/pcinfo.db`. A packaged portable build uses a `data/pcinfo.db` folder beside the executable.

When Angular runs directly in a browser, its demo inventory continues to use browser local storage.

The computer form can capture hardware locally or from a remote Windows computer. The PowerShell collector is maintained in this project at `resources/powershell/pcinfo-worker.ps1`; remote collection requires WinRM and suitable credentials/permissions on the target. Credentials are sent to the worker over stdin and are not saved. Captured values are loaded into the form for review and are written to SQLite only when you choose Save. Hardware collection currently requires Windows.

## Push Mode

Push Mode is available from the desktop login screen. Configure a receiver using its base address, such as `http://192.168.1.20:4783`; CHICTool checks `GET /push/health` before saving that address to `push.txt` in Electron's user data folder. Capture sends the local computer record to `POST /push` on that receiver.

The receiving app queues submissions in memory and opens its Push inbox. A reviewer selects a device type and office, reviews the captured details, then saves or discards the submission. Saving requires signing in. The sender waits for that decision and reports the result. The receiver queue is cleared when the app exits, so submissions awaiting review should be handled before closing the receiver.

The receiver currently accepts requests from reachable network clients without a shared token, and the example HTTP address is unencrypted. Use this on a trusted network; authenticated HTTPS transport is a follow-up hardening item.

## Development

In one terminal, run `npm --prefix ../chictool-web start`. In another, run `npm run dev` here.

## Production build

Run `npm run package`. It builds the Angular app with relative asset URLs, packages it with Electron, and includes the result under the application's resources directory.
