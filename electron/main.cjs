const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require("electron");
const { createServer } = require("node:http");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { execFile, spawn } = require("node:child_process");

const developmentUrl = process.env.CHICTOOL_WEB_URL;
const developmentDataDir = path.resolve(__dirname, "..", "data");
const scanPortValue = Number(process.env.CHICTOOL_SCAN_PORT || 47831);
const scanPort = Number.isInteger(scanPortValue) && scanPortValue > 0 && scanPortValue <= 65535 ? scanPortValue : 47831;
const maxScanBodyBytes = 16 * 1024;
let database;
let mainWindow;
let syncServerUrl = "";
let hotspotName = "CHICTool";
let hotspotPassword = "";
let scanServer;
let scanServerError = "";
const pendingScans = new Map();

function sendJson(response, statusCode, body) {
    response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
}

function rejectScan(request, response, statusCode, message) {
    const client = request.socket.remoteAddress || "unknown client";
    console.warn(`[scan] Rejected request from ${client} (${statusCode}): ${message}`);
    return sendJson(response, statusCode, { ok: false, error: message });
}

function readScanBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let bodyBytes = 0;
        let tooLarge = false;
        request.on("data", (chunk) => {
            if (tooLarge) return;
            bodyBytes += chunk.length;
            if (bodyBytes > maxScanBodyBytes) {
                tooLarge = true;
                chunks.length = 0;
                return;
            }
            chunks.push(chunk);
        });
        request.on("end", () => {
            if (tooLarge) {
                reject(Object.assign(new Error("Request body exceeds the 16 KB limit."), { statusCode: 413 }));
                return;
            }
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
                reject(Object.assign(new Error("Request body must be valid JSON."), { statusCode: 400 }));
            }
        });
        request.on("error", reject);
        request.on("aborted", () => reject(Object.assign(new Error("Request body was interrupted."), { statusCode: 400 })));
    });
}

function finishScan(requestId, result) {
    const pending = pendingScans.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timeout);
    pendingScans.delete(requestId);
    pending.resolve(result);
    return true;
}

function deliverScan(value) {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
        return Promise.resolve({ ok: false, statusCode: 503, message: "The CHICTool window is not available." });
    }
    if (!mainWindow.isFocused()) {
        return Promise.resolve({ ok: false, statusCode: 409, message: "Focus the CHICTool window and try again." });
    }

    const requestId = randomUUID();
    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            finishScan(requestId, { ok: false, statusCode: 408, message: "The CHICTool window did not respond in time." });
        }, 5000);
        pendingScans.set(requestId, { resolve, timeout });
        try {
            mainWindow.webContents.send("scan:fill", { requestId, value });
        } catch {
            finishScan(requestId, { ok: false, statusCode: 503, message: "Could not deliver the scan to the CHICTool window." });
        }
    });
}

async function handleScanRequest(request, response) {
    const client = request.socket.remoteAddress || "unknown client";
    let pathname;
    try {
        pathname = new URL(request.url || "/", "http://localhost").pathname;
    } catch {
        return rejectScan(request, response, 400, "Invalid request URL.");
    }
    console.info(`[scan] Request from ${client}: ${request.method} ${pathname}`);
    if (pathname !== "/scan") return rejectScan(request, response, 404, "Not found.");
    if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        return rejectScan(request, response, 405, "Use POST /scan.");
    }
    if (
        String(request.headers["content-type"] || "")
            .split(";", 1)[0]
            .trim()
            .toLowerCase() !== "application/json"
    ) {
        return rejectScan(request, response, 415, "Content-Type must be application/json.");
    }

    try {
        const body = await readScanBody(request);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            return rejectScan(request, response, 400, "JSON body must include a string codevalue property.");
        }
        const codeValue = Object.prototype.hasOwnProperty.call(body, "codevalue") ? body.codevalue : body.code;
        if (typeof codeValue !== "string") {
            return rejectScan(request, response, 400, "JSON body must include a string codevalue property.");
        }
        if (!codeValue.trim()) return rejectScan(request, response, 400, "codevalue must not be empty.");
        if (codeValue.length > 4096) return rejectScan(request, response, 413, "codevalue must be 4096 characters or fewer.");

        const result = await deliverScan(codeValue);
        if (result.ok) {
            console.info(`[scan] Inserted ${codeValue.length} characters for ${client}.`);
        } else {
            console.warn(`[scan] Could not insert scan for ${client} (${result.statusCode}): ${result.message}`);
        }
        return sendJson(response, result.ok ? 200 : result.statusCode, result.ok ? { code: "OK", codevalue: codeValue } : { ok: false, error: result.message });
    } catch (error) {
        if (response.headersSent || response.destroyed) return;
        return rejectScan(request, response, error.statusCode || 500, error.message || "Could not process scan.");
    }
}

function localScanAddresses() {
    const addresses = [];
    for (const entries of Object.values(os.networkInterfaces())) {
        for (const entry of entries || []) {
            if (!entry.internal && (entry.family === "IPv4" || entry.family === 4)) addresses.push(entry.address);
        }
    }
    return [...new Set(addresses)].sort();
}

function scanEndpointInfo() {
    const addresses = localScanAddresses();
    return {
        enabled: Boolean(scanServer?.listening),
        port: scanPort,
        urls: addresses.map((address) => `http://${address}:${scanPort}/scan`),
        error: scanServerError
    };
}

function startScanServer() {
    scanServer = createServer((request, response) => void handleScanRequest(request, response));
    scanServer.requestTimeout = 10000;
    scanServer.headersTimeout = 10000;
    scanServer.keepAliveTimeout = 5000;
    return new Promise((resolve) => {
        let settled = false;
        scanServer.on("error", (error) => {
            scanServerError = error.message;
            console.error(`Could not start the network scan endpoint: ${error.message}`);
            if (!settled) {
                settled = true;
                resolve(false);
            }
        });
        scanServer.listen(scanPort, "0.0.0.0", () => {
            settled = true;
            scanServerError = "";
            console.info(`Network scan endpoint listening on 0.0.0.0:${scanPort}/scan`);
            resolve(true);
        });
    });
}

function stopScanServer() {
    for (const requestId of pendingScans.keys()) {
        finishScan(requestId, { ok: false, statusCode: 503, message: "The CHICTool app is shutting down." });
    }
    if (scanServer?.listening) {
        console.info("[scan] Stopping network scan endpoint.");
        scanServer.close();
    }
}

function syncSettingsPath() {
    return path.join(app.getPath("userData"), "sync-settings.json");
}

function hotspotSettingsPath() {
    return path.join(app.getPath("userData"), "hotspot-settings.json");
}

function normalizeHotspotName(value) {
    const name = String(value || "").trim();
    if (!name) throw new Error("Hotspot name is required.");
    if (name.length > 32) throw new Error("Hotspot name must be 32 characters or fewer.");
    return name;
}

function loadHotspotSettings() {
    let saved = {};
    try {
        saved = JSON.parse(fs.readFileSync(hotspotSettingsPath(), "utf8"));
    } catch (error) {
        if (error.code !== "ENOENT") console.warn(`Could not read hotspot settings: ${error.message}`);
    }
    let password = "";
    if (saved.passwordEncrypted) {
        try {
            if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure password storage is unavailable.");
            password = safeStorage.decryptString(Buffer.from(saved.passwordEncrypted, "base64"));
        } catch (error) {
            console.warn(`Could not decrypt saved hotspot password: ${error.message}`);
        }
    }
    return {
        networkName: Object.prototype.hasOwnProperty.call(saved, "networkName")
            ? normalizeHotspotName(saved.networkName)
            : process.env.CHICTOOL_HOTSPOT_NAME ? normalizeHotspotName(process.env.CHICTOOL_HOTSPOT_NAME) : "CHICTool",
        password
    };
}

function saveHotspotSettings(networkName, password) {
    const normalizedName = normalizeHotspotName(networkName);
    const normalizedPassword = String(password || "");
    if (normalizedPassword && !safeStorage.isEncryptionAvailable()) {
        throw new Error("Secure password storage is unavailable on this device.");
    }
    fs.mkdirSync(path.dirname(hotspotSettingsPath()), { recursive: true });
    fs.writeFileSync(hotspotSettingsPath(), JSON.stringify({
        networkName: normalizedName,
        passwordEncrypted: normalizedPassword
            ? safeStorage.encryptString(normalizedPassword).toString("base64")
            : ""
    }, null, 2), "utf8");
    hotspotName = normalizedName;
    hotspotPassword = normalizedPassword;
    return { networkName: hotspotName, password: hotspotPassword };
}

function normalizeServerUrl(value) {
    const url = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Server URL must use HTTP or HTTPS.");
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
}

function loadSyncServerUrl() {
    try {
        const saved = JSON.parse(fs.readFileSync(syncSettingsPath(), "utf8"));
        if (Object.prototype.hasOwnProperty.call(saved, "serverUrl")) {
            return saved.serverUrl ? normalizeServerUrl(saved.serverUrl) : "";
        }
    } catch (error) {
        if (error.code !== "ENOENT") console.warn(`Could not read sync settings: ${error.message}`);
    }
    return process.env.CHICTOOL_SERVER_URL ? normalizeServerUrl(process.env.CHICTOOL_SERVER_URL) : "";
}

function requireDatabaseSession() {
    if (!database.getAuthState().currentUser) throw new Error("Please sign in before using database operations.");
}

function runHotspot(action, networkName = "", password = "") {
    if (process.platform !== "win32") return Promise.reject(new Error("Mobile Hotspot is only available on Windows."));
    const script = powershellResource("hotspot.ps1");
    return new Promise((resolve, reject) => {
        execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Action", action, "-NetworkName", networkName, "-Password", password], { windowsHide: true, timeout: 30000 }, (error, stdout, stderr) => {
            let result;
            try { result = JSON.parse(stdout.trim()); } catch { return reject(new Error(stderr.trim() || "Mobile Hotspot did not return a valid response.")); }
            if (error || !result.ok) return reject(new Error(result?.error || stderr.trim() || "Mobile Hotspot operation failed."));
            resolve(result);
        });
    });
}

function initializeDatabase() {
    const databaseModule = app.isPackaged ? path.join(app.getAppPath(), "src", "database.js") : path.join(__dirname, "..", "src", "database.js");
    process.env.PCINFO_DATA_DIR = app.isPackaged ? path.join(process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath("exe")), "data") : developmentDataDir;
    database = require(databaseModule);
    database.initDatabase();
    syncServerUrl = loadSyncServerUrl();
    const hotspotSettings = loadHotspotSettings();
    hotspotName = hotspotSettings.networkName;
    hotspotPassword = hotspotSettings.password;

    ipcMain.handle("sqlite:authState", () => database.getAuthState());
    ipcMain.handle("sqlite:login", (_event, username, password) => {
        const user = database.authenticateUser(username, password);
        database.setActiveUser(user);
        return database.getAuthState();
    });
    ipcMain.handle("sqlite:register", (_event, username, password) => {
        const user = database.registerUser(username, password);
        if (!database.getAuthState().currentUser) database.setActiveUser(user);
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
    ipcMain.handle("inventory:capture", (_event, request) => captureComputer(request));
    ipcMain.handle("inventory:downloadTargetSetup", () => downloadTargetSetup());
    ipcMain.handle("inventory:trustTarget", (_event, hostname) => trustTarget(hostname));
    ipcMain.handle("sqlite:peripherals:list", () => database.listPeripherals(null, "all").map(toPeripheral));
    ipcMain.handle("sqlite:peripherals:save", (_event, peripheral) => toPeripheral(database.savePeripheral(fromPeripheral(peripheral))));
    ipcMain.handle("sqlite:peripherals:delete", (_event, id) => database.deletePeripheral(id));
    ipcMain.handle("database:syncSettings", () => ({ serverUrl: syncServerUrl }));
    ipcMain.handle("database:setSyncServer", (_event, serverUrl) => {
        requireDatabaseSession();
        syncServerUrl = String(serverUrl || "").trim() ? normalizeServerUrl(serverUrl) : "";
        fs.mkdirSync(path.dirname(syncSettingsPath()), { recursive: true });
        fs.writeFileSync(syncSettingsPath(), JSON.stringify({ serverUrl: syncServerUrl }, null, 2), "utf8");
        return { serverUrl: syncServerUrl };
    });
    ipcMain.handle("database:sync", () => {
        requireDatabaseSession();
        return syncInventoryToServer();
    });
    ipcMain.handle("database:reset", () => {
        requireDatabaseSession();
        return database.resetDatabase();
    });
    ipcMain.handle("hotspot:settings", () => ({ networkName: hotspotName, password: hotspotPassword }));
    ipcMain.handle("hotspot:setNetworkName", (_event, networkName, password) => {
        requireDatabaseSession();
        return saveHotspotSettings(networkName, password);
    });
    ipcMain.handle("hotspot:openWindowsSettings", async () => {
        requireDatabaseSession();
        if (process.platform !== "win32") throw new Error("Windows Mobile Hotspot settings are only available on Windows.");
        await shell.openExternal("ms-settings:network-mobilehotspot");
    });
    ipcMain.handle("hotspot:status", () => { requireDatabaseSession(); return runHotspot("Status"); });
    ipcMain.handle("hotspot:start", (_event, networkName, password) => { requireDatabaseSession(); return runHotspot("Start", normalizeHotspotName(networkName), String(password || "")); });
    ipcMain.handle("hotspot:stop", () => { requireDatabaseSession(); return runHotspot("Stop"); });
    ipcMain.handle("scan:endpointInfo", () => scanEndpointInfo());
    ipcMain.handle("scan:complete", (event, requestId, result) => {
        if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("Scan acknowledgment is not authorized.");
        if (typeof requestId !== "string" || !result || typeof result.ok !== "boolean") return false;
        return finishScan(requestId, result.ok ? { ok: true } : { ok: false, statusCode: 422, message: String(result.message || "No editable text field is focused.") });
    });
}

const computerSyncFields = [
    "serialNumber",
    "serialOverride",
    "manufacturer",
    "model",
    "operatingSystem",
    "processor",
    "storage",
    "memory",
    "gpu",
    "macAddress",
    "details",
    "hostname",
    "username",
    "machineType",
    "acquiredOn",
    "office",
    "parHolder",
    "primaryUser",
    "remarks",
    "collectedOn",
    "scriptVersion"
];
const peripheralSyncFields = ["syncId", "computerSerialNumber", "type", "manufacturer", "model", "serialNumber", "assetTag", "assignedUser", "remarks"];

async function postToSyncServer(endpoint, payload, recordName) {
    if (!syncServerUrl) throw new Error("Set a target server URL before syncing.");
    let response;
    try {
        response = await fetch(`${syncServerUrl}${endpoint}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(15000)
        });
    } catch (error) {
        throw new Error(`Could not reach the target server: ${error.name === "TimeoutError" ? "request timed out" : error.message}`);
    }
    if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(`Server rejected ${recordName}: ${result.message || result.error || response.statusText}`);
    }
}

async function downloadLookupsFromServer() {
    if (!syncServerUrl) throw new Error("Set a target server URL before syncing.");
    let response;
    try {
        response = await fetch(`${syncServerUrl}/api/lookups`, { signal: AbortSignal.timeout(15000) });
    } catch (error) {
        throw new Error(`Could not download lookup values: ${error.name === "TimeoutError" ? "request timed out" : error.message}`);
    }
    if (!response.ok) throw new Error(`Could not download lookup values: ${response.statusText}`);
    const result = await response.json().catch(() => null);
    if (!result || !Array.isArray(result.lookups)) throw new Error("The server returned an invalid lookup response.");
    return database.replaceLookupValues(result.lookups);
}

async function syncInventoryToServer() {
    if (!syncServerUrl) throw new Error("Set a target server URL before syncing.");
    const downloadedLookups = await downloadLookupsFromServer();
    const computers = database.listComputers();
    const peripherals = database.listPeripheralsForSync();
    const failures = [];
    let syncedComputers = 0;
    let syncedPeripherals = 0;

    for (const computer of computers) {
        try {
            const payload = Object.fromEntries(
                computerSyncFields
                    .filter((field) => {
                        const value = computer[field];
                        return value !== null && typeof value !== "undefined" && !(field === "acquiredOn" && String(value).trim() === "");
                    })
                    .map((field) => [field, field === "acquiredOn" ? String(computer[field]).trim() : computer[field]])
            );
            await postToSyncServer("/api/computers", payload, computer.serialNumber);
            syncedComputers += 1;
        } catch (error) {
            failures.push(`Computer ${computer.serialNumber}: ${error.message}`);
        }
    }

    for (const peripheral of peripherals) {
        try {
            if (peripheral.deletedAt) {
                const response = await fetch(`${syncServerUrl}/api/peripherals/${encodeURIComponent(peripheral.syncId)}`, {
                    method: "DELETE",
                    signal: AbortSignal.timeout(15000)
                });
                if (!response.ok && response.status !== 404) throw new Error(response.statusText);
            } else {
                const payload = Object.fromEntries(
                    peripheralSyncFields.filter((field) => peripheral[field] !== null && typeof peripheral[field] !== "undefined").map((field) => [field, peripheral[field]])
                );
                await postToSyncServer("/api/peripherals", payload, peripheral.serialNumber || peripheral.syncId);
            }
            syncedPeripherals += 1;
        } catch (error) {
            failures.push(`Peripheral ${peripheral.serialNumber || peripheral.syncId}: ${error.message}`);
        }
    }

    return {
        lookups: { downloaded: downloadedLookups },
        computers: { synced: syncedComputers, total: computers.length },
        peripherals: { synced: syncedPeripherals, total: peripherals.length },
        synced: syncedComputers + syncedPeripherals,
        failed: failures.length,
        failures
    };
}

function captureComputer(request = {}) {
    const mode = request.mode === "remote" ? "remote" : "local";
    const hostname = String(request.hostname || "").trim();
    if (mode === "remote") {
        if (!hostname || !/^[A-Za-z0-9.-]+$/.test(hostname)) throw new Error("Enter a valid remote hostname or IP address.");
        if (!String(request.username || "").trim()) throw new Error("Remote username is required.");
        if (!String(request.password || "")) throw new Error("Remote password is required.");
    }
    if (process.platform !== "win32") throw new Error("Hardware collection requires Windows PowerShell and Windows hardware inventory cmdlets.");

    const workerPath = app.isPackaged
        ? path.join(process.resourcesPath, "chictool-powershell", "pcinfo-worker.ps1")
        : path.join(__dirname, "..", "resources", "powershell", "pcinfo-worker.ps1");
    return new Promise((resolve, reject) => {
        const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", workerPath], {
            windowsHide: true,
            stdio: ["pipe", "pipe", "pipe"]
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timeout = setTimeout(() => {
            settled = true;
            child.kill();
            reject(new Error("PowerShell collection timed out after 60 seconds. Check WinRM and target configuration."));
        }, 60000);
        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });
        child.on("error", (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            reject(error);
        });
        child.on("close", (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (code !== 0) return reject(new Error(stderr.trim() || `PowerShell exited with code ${code}.`));
            try {
                const result = JSON.parse(stdout);
                if (!result.ok) return reject(new Error(result.error || "Hardware collection failed."));
                const data = Array.isArray(result.data) ? result.data[0] : result.data;
                if (!data || typeof data !== "object") return reject(new Error("PowerShell returned no computer details."));
                resolve({
                    serialNumber: data.serial_number || "",
                    manufacturer: data.manufacturer || "",
                    model: data.model || "",
                    operatingSystem: data.operating_system || "",
                    processor: data.processor || "",
                    storage: data.storage || "",
                    memory: data.memory || "",
                    gpu: data.gpu || "",
                    macAddress: data.mac_address || "",
                    details: data.details || "",
                    hostname: mode === "remote" ? hostname : os.hostname(),
                    username: mode === "remote" ? String(request.username || "") : os.userInfo().username,
                    primaryUser: data.primary_user || "",
                    collectedOn: new Date().toISOString().slice(0, 10),
                    scriptVersion: "1.0"
                });
            } catch {
                reject(new Error(stderr.trim() || "PowerShell returned invalid JSON."));
            }
        });
        child.stdin.end(JSON.stringify({ mode, hostname, username: request.username, password: request.password }));
    });
}

function powershellResource(name) {
    return app.isPackaged ? path.join(process.resourcesPath, "chictool-powershell", name) : path.join(__dirname, "..", "resources", "powershell", name);
}

async function downloadTargetSetup() {
    const source = powershellResource("target-setup.ps1");
    const result = await dialog.showSaveDialog(mainWindow, {
        title: "Save CHICTool target setup script",
        defaultPath: "chictool-target-setup.ps1",
        filters: [{ name: "PowerShell script", extensions: ["ps1"] }]
    });
    if (result.canceled || !result.filePath) return "Download cancelled.";
    fs.copyFileSync(source, result.filePath);
    return `Target setup script saved to ${result.filePath}`;
}

function trustTarget(hostnameValue) {
    const hostname = String(hostnameValue || "").trim();
    if (!/^[A-Za-z0-9.-]+$/.test(hostname)) {
        return Promise.reject(new Error("Enter a valid hostname or IP address."));
    }
    if (process.platform !== "win32") {
        return Promise.reject(new Error("Trusting a target requires Windows PowerShell."));
    }
    const script = powershellResource("add-trusted-host.ps1");
    const command = `$p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','${script.replace(/'/g, "''")}','-HostName','${hostname}'); exit $p.ExitCode`;
    return new Promise((resolve, reject) => {
        execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true }, (error, _stdout, stderr) => {
            if (error) return reject(new Error(stderr.trim() || "The elevated TrustedHosts operation was cancelled or failed."));
            resolve(`TrustedHosts updated for ${hostname}.`);
        });
    });
}

function toComputer(row) {
    // Normalize SQLite values and identifiers for the Angular/Electron boundary.
    return {
        id: String(row.id),
        serialNumber: row.serialNumber,
        serialOverride: row.serialOverride || "",
        manufacturer: row.manufacturer || "",
        model: row.model || "",
        operatingSystem: row.operatingSystem || "",
        processor: row.processor || "",
        storage: row.storage || "",
        memory: row.memory || "",
        gpu: row.gpu || "",
        macAddress: row.macAddress || "",
        details: row.details || "",
        hostname: row.hostname || "",
        username: row.username || "",
        machineType: row.machineType,
        acquiredOn: row.acquiredOn || "",
        office: row.office,
        parHolder: row.parHolder || "",
        primaryUser: row.primaryUser || "",
        remarks: row.remarks || "",
        collectedOn: row.collectedOn,
        scriptVersion: row.scriptVersion || ""
    };
}

function fromComputer(row) {
    return {
        id: row.id ? Number(row.id) : undefined,
        serialNumber: row.serialNumber,
        serialOverride: row.serialOverride,
        manufacturer: row.manufacturer,
        model: row.model,
        operatingSystem: row.operatingSystem,
        processor: row.processor,
        storage: row.storage,
        memory: row.memory,
        gpu: row.gpu,
        macAddress: row.macAddress,
        details: row.details,
        hostname: row.hostname,
        username: row.username,
        machineType: row.machineType,
        acquiredOn: row.acquiredOn,
        office: row.office,
        parHolder: row.parHolder,
        primaryUser: row.primaryUser,
        remarks: row.remarks,
        collectedOn: row.collectedOn,
        scriptVersion: row.scriptVersion
    };
}

function toPeripheral(row) {
    // Normalize SQLite values and identifiers for the Angular/Electron boundary.
    return {
        id: String(row.id),
        syncId: row.syncId,
        computerId: row.computerId ? String(row.computerId) : "",
        type: row.type,
        manufacturer: row.manufacturer || "",
        model: row.model || "",
        serialNumber: row.serialNumber || "",
        assetTag: row.assetTag || "",
        assignedUser: row.assignedUser || "",
        remarks: row.remarks || ""
    };
}

function fromPeripheral(row) {
    return {
        id: row.id ? Number(row.id) : undefined,
        syncId: row.syncId || undefined,
        computerId: row.computerId ? Number(row.computerId) : null,
        type: row.type,
        manufacturer: row.manufacturer,
        model: row.model,
        serialNumber: row.serialNumber,
        assetTag: row.assetTag,
        assignedUser: row.assignedUser,
        remarks: row.remarks
    };
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

    if (developmentUrl) {
        void window.loadURL(developmentUrl).catch((error) => console.error("Could not load the Angular dev server:", error));
    } else {
        void window.loadFile(webEntry()).catch((error) => console.error("Could not load the Angular build:", error));
    }
}

app.whenReady().then(async () => {
    initializeDatabase();
    await startScanServer();
    createWindow();
    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", stopScanServer);
