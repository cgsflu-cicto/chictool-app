const { app, BrowserWindow, ipcMain, safeStorage, shell, dialog } = require("electron");
const path = require("node:path");
const { execFile, spawn } = require("node:child_process");
const { createInventoryService } = require("./services/inventory-service.cjs");
const { createHotspotService } = require("./services/hotspot-service.cjs");
const { createScanService } = require("./services/scan-service.cjs");
const { createSyncService } = require("./services/sync-service.cjs");
const { toComputer, fromComputer, toPeripheral, fromPeripheral } = require("./mappers/inventory-mappers.cjs");

const developmentUrl = process.env.CHICTOOL_WEB_URL;
const developmentDataDir = path.resolve(__dirname, "..", "data");
const scanPortValue = Number(process.env.CHICTOOL_SCAN_PORT || 47831);
const scanPort = Number.isInteger(scanPortValue) && scanPortValue > 0 && scanPortValue <= 65535 ? scanPortValue : 47831;
let database;
let mainWindow;
let inventory;
let hotspot;
let scan;
let sync;

function normalizeServerUrl(value) {
    const url = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Server URL must use HTTP or HTTPS.");
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
}

function powershellResource(name) {
    return app.isPackaged
        ? path.join(process.resourcesPath, "chictool-powershell", name)
        : path.join(__dirname, "..", "resources", "powershell", name);
}

function requireDatabaseSession() {
    if (!database.getAuthState().currentUser) throw new Error("Please sign in before using database operations.");
}

function initializeDatabase() {
    const databaseModule = app.isPackaged ? path.join(app.getAppPath(), "src", "database.js") : path.join(__dirname, "..", "src", "database.js");
    process.env.PCINFO_DATA_DIR = app.isPackaged ? path.join(process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath("exe")), "data") : developmentDataDir;
    database = require(databaseModule);
    database.initDatabase();

    hotspot = createHotspotService({ app, safeStorage, execFile, scanPort, powershellResource });
    inventory = createInventoryService({ app, dialog, spawn, execFile, getWindow: () => mainWindow, powershellResource });
    sync = createSyncService({ app, database, normalizeServerUrl });
    scan = createScanService({
        getWindow: () => mainWindow,
        runHotspot: (...args) => hotspot.run(...args),
        getHotspotName: () => hotspot.getNetworkName(),
        scanPort,
        execFile
    });
    registerIpcHandlers();
}

function registerIpcHandlers() {
    ipcMain.handle("sqlite:authState", () => database.getAuthState());
    ipcMain.handle("sqlite:login", (_event, username, password) => {
        const user = database.authenticateUser(username, password);
        database.setActiveUser(user);
        hotspot.addFirewallExceptionAfterLogin();
        return database.getAuthState();
    });
    ipcMain.handle("sqlite:register", (_event, username, password) => {
        const user = database.registerUser(username, password);
        if (!database.getAuthState().currentUser) {
            database.setActiveUser(user);
            hotspot.addFirewallExceptionAfterLogin();
        }
        return database.getAuthState();
    });
    ipcMain.handle("sqlite:logout", () => {
        database.setActiveUser(null);
        return database.getAuthState();
    });
    ipcMain.handle("sqlite:lookups", () => database.getLookupValues());
    ipcMain.handle("sqlite:computers:list", () => database.listComputers().map(toComputer));
    ipcMain.handle("sqlite:computers:save", (_event, computer) => toComputer(database.saveComputer(fromComputer(computer))));
    ipcMain.handle("sqlite:computers:delete", (_event, id) => database.deleteComputer(id));
    ipcMain.handle("inventory:capture", (_event, request) => inventory.captureComputer(request));
    ipcMain.handle("inventory:downloadTargetSetup", () => inventory.downloadTargetSetup());
    ipcMain.handle("inventory:trustTarget", (_event, hostname) => inventory.trustTarget(hostname));
    ipcMain.handle("sqlite:peripherals:list", () => database.listPeripherals(null, "all").map(toPeripheral));
    ipcMain.handle("sqlite:peripherals:save", (_event, peripheral) => toPeripheral(database.savePeripheral(fromPeripheral(peripheral))));
    ipcMain.handle("sqlite:peripherals:delete", (_event, id) => database.deletePeripheral(id));
    ipcMain.handle("database:syncSettings", () => ({ serverUrl: sync.getServerUrl() }));
    ipcMain.handle("database:setSyncServer", (_event, serverUrl) => {
        requireDatabaseSession();
        return sync.setServerUrl(serverUrl);
    });
    ipcMain.handle("database:sync", () => {
        requireDatabaseSession();
        return sync.sync();
    });
    ipcMain.handle("database:reset", () => {
        requireDatabaseSession();
        return database.resetDatabase();
    });
    ipcMain.handle("hotspot:settings", () => hotspot.getSettings());
    ipcMain.handle("hotspot:setNetworkName", (_event, networkName, password) => {
        requireDatabaseSession();
        return hotspot.saveSettings(networkName, password);
    });
    ipcMain.handle("hotspot:openWindowsSettings", async () => {
        requireDatabaseSession();
        if (process.platform !== "win32") throw new Error("Windows Mobile Hotspot settings are only available on Windows.");
        await shell.openExternal("ms-settings:network-mobilehotspot");
    });
    ipcMain.handle("hotspot:status", () => hotspot.run("Status"));
    ipcMain.handle("hotspot:start", (_event, networkName, password) => {
        requireDatabaseSession();
        return hotspot.run("Start", hotspot.normalizeName(networkName), String(password || ""));
    });
    ipcMain.handle("hotspot:stop", () => { requireDatabaseSession(); return hotspot.run("Stop"); });
    ipcMain.handle("scan:endpointInfo", () => scan.endpointInfo());
    ipcMain.handle("scan:complete", (event, requestId, result) => {
        if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("Scan acknowledgment is not authorized.");
        if (typeof requestId !== "string" || !result || typeof result.ok !== "boolean") return false;
        return scan.finish(requestId, result.ok
            ? { ok: true }
            : { ok: false, statusCode: 422, message: String(result.message || "No editable text field is focused.") });
    });
}

function webEntry() {
    if (developmentUrl) return developmentUrl;
    if (app.isPackaged) return path.join(process.resourcesPath, "angular-web", "index.html");
    return path.join(__dirname, "..", "..", "chictool-web", "dist", "chictool-web", "browser", "index.html");
}

function createWindow() {
    const window = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1024,
        minHeight: 700,
        show: false,
        backgroundColor: "#f7f9fc",
        webPreferences: {
            preload: path.join(__dirname, "preload.cjs"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });
    mainWindow = window;

    window.once("ready-to-show", () => window.show());
    window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
        console.error(`Failed to load ${validatedURL}: ${errorDescription} (${errorCode})`);
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith("https://")) void shell.openExternal(url);
        return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, url) => {
        const allowed = developmentUrl ? url.startsWith(developmentUrl) : url.startsWith("file:");
        if (!allowed) event.preventDefault();
    });

    if (developmentUrl) void window.loadURL(developmentUrl).catch((error) => console.error("Could not load the Angular dev server:", error));
    else void window.loadFile(webEntry()).catch((error) => console.error("Could not load the Angular build:", error));
}

app.whenReady().then(async () => {
    initializeDatabase();
    await scan.start();
    createWindow();
    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => scan?.stop());
