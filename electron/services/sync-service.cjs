const fs = require("node:fs");
const path = require("node:path");

const computerSyncFields = [
    "serialNumber", "serialOverride", "manufacturer", "model", "operatingSystem", "processor", "storage", "memory", "gpu",
    "macAddress", "details", "hostname", "username", "machineType", "acquiredOn", "office", "parHolder", "primaryUser",
    "remarks", "collectedOn", "scriptVersion"
];
const peripheralSyncFields = ["syncId", "computerSerialNumber", "type", "manufacturer", "model", "serialNumber", "assetTag", "assignedUser", "remarks"];

function createSyncService({ app, database, normalizeServerUrl }) {
    const dataDir = () => app.isPackaged
        ? path.join(process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath("exe")), "data")
        : path.resolve(__dirname, "..", "..", "data");
    const settingsPath = () => path.join(dataDir(), "sync.txt");
    const legacySettingsPath = () => path.join(app.getPath("userData"), "sync-settings.json");

    function loadServerUrl() {
        try {
            const saved = fs.readFileSync(settingsPath(), "utf8").trim();
            return saved ? normalizeServerUrl(saved) : "";
        } catch (error) {
            if (error.code !== "ENOENT") console.warn(`Could not read sync settings: ${error.message}`);
            else {
                try {
                    const legacy = JSON.parse(fs.readFileSync(legacySettingsPath(), "utf8"));
                    const serverUrl = legacy.serverUrl ? normalizeServerUrl(legacy.serverUrl) : "";
                    fs.mkdirSync(dataDir(), { recursive: true });
                    fs.writeFileSync(settingsPath(), `${serverUrl}\n`, "utf8");
                    return serverUrl;
                } catch (legacyError) {
                    if (legacyError.code !== "ENOENT") console.warn(`Could not migrate sync settings: ${legacyError.message}`);
                }
            }
        }
        return process.env.CHICTOOL_SERVER_URL ? normalizeServerUrl(process.env.CHICTOOL_SERVER_URL) : "";
    }

    let serverUrl = loadServerUrl();

    function setServerUrl(value) {
        serverUrl = String(value || "").trim() ? normalizeServerUrl(value) : "";
        fs.mkdirSync(dataDir(), { recursive: true });
        fs.writeFileSync(settingsPath(), `${serverUrl}\n`, "utf8");
        return { serverUrl };
    }

    async function post(endpoint, payload, recordName) {
        if (!serverUrl) throw new Error("Set a target server URL before syncing.");
        let response;
        try {
            response = await fetch(`${serverUrl}${endpoint}`, {
                method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
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

    async function downloadLookups() {
        if (!serverUrl) throw new Error("Set a target server URL before syncing.");
        let response;
        try {
            response = await fetch(`${serverUrl}/api/lookups`, { signal: AbortSignal.timeout(15000) });
        } catch (error) {
            throw new Error(`Could not download lookup values: ${error.name === "TimeoutError" ? "request timed out" : error.message}`);
        }
        if (!response.ok) throw new Error(`Could not download lookup values: ${response.statusText}`);
        const result = await response.json().catch(() => null);
        if (!result || !Array.isArray(result.lookups)) throw new Error("The server returned an invalid lookup response.");
        return database.replaceLookupValues(result.lookups);
    }

    async function sync() {
        if (!serverUrl) throw new Error("Set a target server URL before syncing.");
        const downloadedLookups = await downloadLookups();
        const computers = database.listComputers();
        const peripherals = database.listPeripheralsForSync();
        const failures = [];
        let syncedComputers = 0;
        let syncedPeripherals = 0;

        for (const computer of computers) {
            try {
                const payload = Object.fromEntries(computerSyncFields
                    .filter((field) => {
                        const value = computer[field];
                        return value !== null && typeof value !== "undefined" && !(field === "acquiredOn" && String(value).trim() === "");
                    })
                    .map((field) => [field, field === "acquiredOn" ? String(computer[field]).trim() : computer[field]]));
                await post("/api/computers", payload, computer.serialNumber);
                syncedComputers += 1;
            } catch (error) {
                failures.push(`Computer ${computer.serialNumber}: ${error.message}`);
            }
        }

        for (const peripheral of peripherals) {
            try {
                if (peripheral.deletedAt) {
                    const response = await fetch(`${serverUrl}/api/peripherals/${encodeURIComponent(peripheral.syncId)}`, {
                        method: "DELETE", signal: AbortSignal.timeout(15000)
                    });
                    if (!response.ok && response.status !== 404) throw new Error(response.statusText);
                } else {
                    const payload = Object.fromEntries(peripheralSyncFields
                        .filter((field) => peripheral[field] !== null && typeof peripheral[field] !== "undefined")
                        .map((field) => [field, peripheral[field]]));
                    await post("/api/peripherals", payload, peripheral.serialNumber || peripheral.syncId);
                }
                syncedPeripherals += 1;
            } catch (error) {
                failures.push(`Peripheral ${peripheral.serialNumber || peripheral.syncId}: ${error.message}`);
            }
        }

        return {
            lookups: { downloaded: downloadedLookups }, computers: { synced: syncedComputers, total: computers.length },
            peripherals: { synced: syncedPeripherals, total: peripherals.length }, synced: syncedComputers + syncedPeripherals,
            failed: failures.length, failures
        };
    }

    return { getServerUrl: () => serverUrl, loadServerUrl, setServerUrl, sync };
}

module.exports = { createSyncService };
