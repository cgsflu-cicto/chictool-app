# CHICTool Desktop App

Electron desktop application for the Angular frontend in the sibling `../chictool-web` project. It no longer depends on the legacy `chictool` project folder.

Electron owns its SQLite implementation in `src/database.js` and its development database at `data/pcinfo.db`. The existing inventory and account data have been migrated. SQLite columns, database API fields, and fields passed between Angular and Electron use camelCase (for example, `serialNumber` and `computerId`). Existing snake_case columns are renamed in place on startup; a pre-migration backup is retained as `data/pcinfo.pre-camelcase.db`.

The desktop app uses the migrated account and audit data. The first launch lets you create a local account if no users exist; later launches require signing in. Development uses `chictool-app/data/pcinfo.db`. A packaged portable build uses a `data/pcinfo.db` folder beside the executable.

When Angular runs directly in a browser, its demo inventory continues to use browser local storage.

The computer form can capture hardware locally or from a remote Windows computer. The PowerShell collector is maintained in this project at `resources/powershell/pcinfo-worker.ps1`; remote collection requires WinRM and suitable credentials/permissions on the target. Credentials are sent to the worker over stdin and are not saved. Captured values are loaded into the form for review and are written to SQLite only when you choose Save. Hardware collection currently requires Windows.

## Development

In one terminal, run `npm --prefix ../chictool-web start`. In another, run `npm run dev` here.

## Production build

Run `npm run package`. It builds the Angular app with relative asset URLs, packages it with Electron, and includes the result under the application's resources directory.
