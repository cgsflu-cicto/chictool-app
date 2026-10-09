const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function createPushService({ app, getWindow, database, normalizeServerUrl }) {
    const pending = new Map();
    const results = new Map();
    const maxBodyBytes = 64 * 1024;
    const resultLifetimeMs = 10 * 60 * 1000;
    const configPath = () => {
        const dataDir = app.isPackaged
            ? path.join(process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(app.getPath("exe")), "data")
            : app.getPath("userData");
        return path.join(dataDir, "push.txt");
    };

    function getConfig() {
        try { return { serverUrl: normalizeServerUrl(fs.readFileSync(configPath(), "utf8")) }; }
        catch { return { serverUrl: "" }; }
    }

    async function testServer(value) {
        const serverUrl = normalizeServerUrl(value);
        const response = await fetch(`${serverUrl}/push/health`, { signal: AbortSignal.timeout(8000) });
        if (!response.ok) throw new Error(`Receiver returned HTTP ${response.status}.`);
        const result = await response.json();
        if (result?.ok !== true) throw new Error("The address is not a CHICTool push receiver.");
        return { serverUrl };
    }

    async function setConfig(value) {
        const { serverUrl } = await testServer(value);
        fs.mkdirSync(path.dirname(configPath()), { recursive: true });
        fs.writeFileSync(configPath(), `${serverUrl}\n`, "utf8");
        return { serverUrl };
    }

    async function sendCapture(computer) {
        const { serverUrl } = getConfig();
        if (!serverUrl) throw new Error("Configure and test a CHICTool receiver first.");
        const response = await fetch(`${serverUrl}/push`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(computer),
            signal: AbortSignal.timeout(15000)
        });
        const accepted = await response.json().catch(() => ({}));
        if (response.status !== 202 || !accepted.submissionId) throw new Error(accepted.error || `Receiver returned HTTP ${response.status}.`);
        const statusUrl = `${serverUrl}/push/status/${encodeURIComponent(accepted.submissionId)}`;
        const deadline = Date.now() + 10 * 60 * 1000;
        while (Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
            const statusResponse = await fetch(statusUrl, { signal: AbortSignal.timeout(8000) });
            if (!statusResponse.ok) throw new Error("The receiver could not confirm the review decision.");
            const result = await statusResponse.json();
            if (result.status === "saved") return { status: "saved", message: "Computer details were reviewed and saved." };
            if (result.status === "discarded") return { status: "discarded", message: "The receiver discarded this submission." };
        }
        throw new Error("The receiver has not reviewed this submission yet. It remains queued for review.");
    }

    function sendJson(response, status, body) {
        response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        response.end(JSON.stringify(body));
    }

    async function readJson(request) {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
            size += chunk.length;
            if (size > maxBodyBytes) throw Object.assign(new Error("Request body exceeds 64 KB."), { statusCode: 413 });
            chunks.push(chunk);
        }
        try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { throw Object.assign(new Error("Request body must be valid JSON."), { statusCode: 400 }); }
    }

    function statusOf(id) {
        if (pending.has(id)) return { status: "pending" };
        const result = results.get(id);
        if (result && result.expiresAt > Date.now()) return { status: result.status, message: result.message || "" };
        results.delete(id);
        return null;
    }

    async function handleRequest(request, response, pathname) {
        if (pathname === "/push/health" && request.method === "GET") return sendJson(response, 200, { ok: true, service: "chictool-push" });
        if (pathname === "/push" && request.method === "POST") {
            if (String(request.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase() !== "application/json") {
                return sendJson(response, 415, { ok: false, error: "Content-Type must be application/json." });
            }
            try {
                const computer = await readJson(request);
                if (!computer || typeof computer !== "object" || Array.isArray(computer) || typeof computer.serialNumber !== "string" || !computer.serialNumber.trim()) {
                    return sendJson(response, 400, { ok: false, error: "A computer record with a serial number is required." });
                }
                if (pending.size >= 20) return sendJson(response, 429, { ok: false, error: "The review inbox is full. Review pending submissions first." });
                const id = randomUUID();
                pending.set(id, { id, computer, receivedAt: new Date().toISOString() });
                const window = getWindow();
                if (window && !window.isDestroyed()) {
                    if (window.isMinimized()) window.restore();
                    window.show();
                    window.focus();
                    window.webContents.send("push:received", { id });
                }
                return sendJson(response, 202, { ok: true, submissionId: id });
            } catch (error) { return sendJson(response, error.statusCode || 400, { ok: false, error: error.message }); }
        }
        const statusMatch = pathname.match(/^\/push\/status\/([0-9a-f-]+)$/i);
        if (statusMatch && request.method === "GET") {
            const result = statusOf(statusMatch[1]);
            return result ? sendJson(response, 200, result) : sendJson(response, 404, { status: "expired" });
        }
        response.setHeader("allow", "GET, POST");
        return sendJson(response, 404, { ok: false, error: "Not found." });
    }

    function listPending() { return [...pending.values()]; }

    function decide(id, action, computer) {
        const item = pending.get(String(id));
        if (!item) throw new Error("This push submission is no longer pending.");
        if (action === "discard") {
            pending.delete(item.id);
            results.set(item.id, { status: "discarded", expiresAt: Date.now() + resultLifetimeMs });
            setTimeout(() => results.delete(item.id), resultLifetimeMs).unref?.();
            return { status: "discarded" };
        }
        if (action !== "save") throw new Error("Choose Save or Discard.");
        const saved = database.saveComputer(computer);
        pending.delete(item.id);
        results.set(item.id, { status: "saved", expiresAt: Date.now() + resultLifetimeMs });
        setTimeout(() => results.delete(item.id), resultLifetimeMs).unref?.();
        return { status: "saved", computer: saved };
    }

    return { getConfig, setConfig, testServer, sendCapture, handleRequest, listPending, decide };
}

module.exports = { createPushService };
