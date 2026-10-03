const { createServer } = require("node:http");
const { randomUUID } = require("node:crypto");
const os = require("node:os");

function createScanService({ getWindow, runHotspot, getHotspotName, scanPort, execFile }) {
    const maxBodyBytes = 16 * 1024;
    const pendingScans = new Map();
    let server;
    let serverError = "";

    function sendJson(response, statusCode, body) {
        response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify(body));
    }

    function reject(request, response, statusCode, message) {
        const client = request.socket.remoteAddress || "unknown client";
        console.warn(`[scan] Rejected request from ${client} (${statusCode}): ${message}`);
        return sendJson(response, statusCode, { ok: false, error: message });
    }

    function readBody(request) {
        return new Promise((resolve, rejectBody) => {
            const chunks = [];
            let size = 0;
            let tooLarge = false;
            request.on("data", (chunk) => {
                if (tooLarge) return;
                size += chunk.length;
                if (size > maxBodyBytes) { tooLarge = true; chunks.length = 0; return; }
                chunks.push(chunk);
            });
            request.on("end", () => {
                if (tooLarge) return rejectBody(Object.assign(new Error("Request body exceeds the 16 KB limit."), { statusCode: 413 }));
                try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
                catch { rejectBody(Object.assign(new Error("Request body must be valid JSON."), { statusCode: 400 })); }
            });
            request.on("error", rejectBody);
            request.on("aborted", () => rejectBody(Object.assign(new Error("Request body was interrupted."), { statusCode: 400 })));
        });
    }

    function finish(requestId, result) {
        const pending = pendingScans.get(requestId);
        if (!pending) return false;
        clearTimeout(pending.timeout);
        pendingScans.delete(requestId);
        pending.resolve(result);
        return true;
    }

    function deliver(value) {
        const window = getWindow();
        if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return Promise.resolve({ ok: false, statusCode: 503, message: "The CHICTool window is not available." });
        if (!window.isFocused()) return Promise.resolve({ ok: false, statusCode: 409, message: "Focus the CHICTool window and try again." });
        const requestId = randomUUID();
        return new Promise((resolve) => {
            const timeout = setTimeout(() => finish(requestId, { ok: false, statusCode: 408, message: "The CHICTool window did not respond in time." }), 5000);
            pendingScans.set(requestId, { resolve, timeout });
            try { window.webContents.send("scan:fill", { requestId, value }); }
            catch { finish(requestId, { ok: false, statusCode: 503, message: "Could not deliver the scan to the CHICTool window." }); }
        });
    }

    async function handleRequest(request, response) {
        const client = request.socket.remoteAddress || "unknown client";
        let pathname;
        try { pathname = new URL(request.url || "/", "http://localhost").pathname; }
        catch { return reject(request, response, 400, "Invalid request URL."); }
        console.info(`[scan] Request from ${client}: ${request.method} ${pathname}`);
        if (pathname !== "/scan") return reject(request, response, 404, "Not found.");
        if (request.method !== "POST") { response.setHeader("allow", "POST"); return reject(request, response, 405, "Use POST /scan."); }
        if (String(request.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase() !== "application/json") return reject(request, response, 415, "Content-Type must be application/json.");
        try {
            const body = await readBody(request);
            if (!body || typeof body !== "object" || Array.isArray(body)) return reject(request, response, 400, "JSON body must include a string codevalue property.");
            const codeValue = Object.prototype.hasOwnProperty.call(body, "codevalue") ? body.codevalue : body.code;
            if (typeof codeValue !== "string") return reject(request, response, 400, "JSON body must include a string codevalue property.");
            if (!codeValue.trim()) return reject(request, response, 400, "codevalue must not be empty.");
            if (codeValue.length > 4096) return reject(request, response, 413, "codevalue must be 4096 characters or fewer.");
            const result = await deliver(codeValue);
            if (result.ok) console.info(`[scan] Inserted ${codeValue.length} characters for ${client}.`);
            else console.warn(`[scan] Could not insert scan for ${client} (${result.statusCode}): ${result.message}`);
            return sendJson(response, result.ok ? 200 : result.statusCode, result.ok ? { code: "OK", codevalue: codeValue } : { ok: false, error: result.message });
        } catch (error) {
            if (response.headersSent || response.destroyed) return;
            return reject(request, response, error.statusCode || 500, error.message || "Could not process scan.");
        }
    }

    function localAddresses() {
        const addresses = [];
        for (const [interfaceName, entries] of Object.entries(os.networkInterfaces())) {
            if (/^vEthernet(?:\s|$)/i.test(interfaceName)) continue;
            for (const entry of entries || []) {
                const isIpv4 = entry.family === "IPv4" || entry.family === 4;
                const isLinkLocal = isIpv4 && entry.address.startsWith("169.254.");
                if (!entry.internal && isIpv4 && !isLinkLocal) addresses.push({ interfaceName, address: entry.address });
            }
        }
        return [...new Map(addresses.map((entry) => [entry.address, entry])).values()].sort((a, b) => a.interfaceName.localeCompare(b.interfaceName) || a.address.localeCompare(b.address));
    }

    function readWifiSsid() {
        if (process.platform !== "win32") return Promise.resolve("");
        return new Promise((resolve) => execFile("netsh.exe", ["wlan", "show", "interfaces"], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
            if (error) return resolve("");
            resolve(stdout.match(/^\s*SSID\s*:\s*(.+?)\s*$/im)?.[1] || "");
        }));
    }

    async function endpointInfo() {
        const wifiPromise = readWifiSsid();
        let activeHotspot = null;
        try { activeHotspot = await runHotspot("Status"); } catch { /* Discovery remains available without hotspot status. */ }
        const wifiSsid = await wifiPromise;
        const endpoints = localAddresses().map(({ interfaceName, address }) => {
            const isHotspot = activeHotspot?.state === "On" && /^Local Area Connection\*/i.test(interfaceName);
            return {
                interfaceName: isHotspot ? "Hotspot Gateway" : interfaceName,
                networkName: isHotspot ? activeHotspot.networkName || getHotspotName() : /^(wi-?fi|wlan)/i.test(interfaceName) && wifiSsid ? wifiSsid : interfaceName,
                address, url: `http://${address}:${scanPort}/scan`
            };
        });
        return { enabled: Boolean(server?.listening), port: scanPort, urls: endpoints.map((endpoint) => endpoint.url), endpoints, error: serverError };
    }

    function start() {
        server = createServer((request, response) => void handleRequest(request, response));
        server.requestTimeout = 10000;
        server.headersTimeout = 10000;
        server.keepAliveTimeout = 5000;
        return new Promise((resolve) => {
            let settled = false;
            server.on("error", (error) => {
                serverError = error.message;
                console.error(`Could not start the network scan endpoint: ${error.message}`);
                if (!settled) { settled = true; resolve(false); }
            });
            server.listen(scanPort, "0.0.0.0", () => {
                settled = true;
                serverError = "";
                console.info(`Network scan endpoint listening on 0.0.0.0:${scanPort}/scan`);
                resolve(true);
            });
        });
    }

    function stop() {
        for (const requestId of pendingScans.keys()) finish(requestId, { ok: false, statusCode: 503, message: "The CHICTool app is shutting down." });
        if (server?.listening) { console.info("[scan] Stopping network scan endpoint."); server.close(); }
    }

    return { start, stop, endpointInfo, finish };
}

module.exports = { createScanService };
