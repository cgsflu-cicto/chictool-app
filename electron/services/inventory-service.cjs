const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function createInventoryService({ app, dialog, spawn, execFile, getWindow, powershellResource }) {
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
            : path.join(__dirname, "..", "..", "resources", "powershell", "pcinfo-worker.ps1");
        return new Promise((resolve, reject) => {
            const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", workerPath], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
            let stdout = "";
            let stderr = "";
            let settled = false;
            const timeout = setTimeout(() => {
                settled = true;
                child.kill();
                reject(new Error("PowerShell collection timed out after 60 seconds. Check WinRM and target configuration."));
            }, 60000);
            child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
            child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
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
                        serialNumber: data.serial_number || "", manufacturer: data.manufacturer || "", model: data.model || "",
                        operatingSystem: data.operating_system || "", processor: data.processor || "", storage: data.storage || "",
                        memory: data.memory || "", gpu: data.gpu || "", macAddress: data.mac_address || "", details: data.details || "",
                        hostname: mode === "remote" ? hostname : os.hostname(), username: mode === "remote" ? String(request.username || "") : os.userInfo().username,
                        primaryUser: data.primary_user || "", collectedOn: new Date().toISOString().slice(0, 10), scriptVersion: "1.0"
                    });
                } catch { reject(new Error(stderr.trim() || "PowerShell returned invalid JSON.")); }
            });
            child.stdin.end(JSON.stringify({ mode, hostname, username: request.username, password: request.password }));
        });
    }

    async function downloadTargetSetup() {
        const source = powershellResource("target-setup.ps1");
        const result = await dialog.showSaveDialog(getWindow(), {
            title: "Save CHICTool target setup script", defaultPath: "chictool-target-setup.ps1",
            filters: [{ name: "PowerShell script", extensions: ["ps1"] }]
        });
        if (result.canceled || !result.filePath) return "Download cancelled.";
        fs.copyFileSync(source, result.filePath);
        return `Target setup script saved to ${result.filePath}`;
    }

    function trustTarget(hostnameValue) {
        const hostname = String(hostnameValue || "").trim();
        if (!/^[A-Za-z0-9.-]+$/.test(hostname)) return Promise.reject(new Error("Enter a valid hostname or IP address."));
        if (process.platform !== "win32") return Promise.reject(new Error("Trusting a target requires Windows PowerShell."));
        const script = powershellResource("add-trusted-host.ps1");
        const command = `$p = Start-Process -FilePath 'powershell.exe' -Verb RunAs -Wait -PassThru -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File','${script.replace(/'/g, "''")}','-HostName','${hostname}'); exit $p.ExitCode`;
        return new Promise((resolve, reject) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], { windowsHide: true }, (error, _stdout, stderr) => {
            if (error) return reject(new Error(stderr.trim() || "The elevated TrustedHosts operation was cancelled or failed."));
            resolve(`TrustedHosts updated for ${hostname}.`);
        }));
    }

    return { captureComputer, downloadTargetSetup, trustTarget };
}

module.exports = { createInventoryService };
