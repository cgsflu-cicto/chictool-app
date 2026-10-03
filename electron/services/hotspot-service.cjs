const fs = require("node:fs");
const path = require("node:path");
const { randomInt } = require("node:crypto");

function createHotspotService({ app, safeStorage, execFile, scanPort, powershellResource }) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const randomValue = (length) => Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join("");
    const settingsPath = () => path.join(app.getPath("userData"), "hotspot-settings.json");

    function normalizeName(value) {
        const name = String(value || "").trim();

        if (!name) throw new Error("Hotspot name is required.");
        if (name.length > 32) throw new Error("Hotspot name must be 32 characters or fewer.");

        return name;
    }

    function loadSettings() {
        let saved = {};
        try {
            saved = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
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
                ? normalizeName(saved.networkName)
                : process.env.CHICTOOL_HOTSPOT_NAME ? normalizeName(process.env.CHICTOOL_HOTSPOT_NAME) : `CHICTool-${randomValue(5)}`,
            password: password || randomValue(10)
        };
    }

    let { networkName, password } = loadSettings();

    function saveSettings(name, newPassword) {
        const normalizedName = normalizeName(name);
        const normalizedPassword = String(newPassword || "");

        if (normalizedPassword && !safeStorage.isEncryptionAvailable()) throw new Error("Secure password storage is unavailable on this device.");

        fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
        fs.writeFileSync(settingsPath(), JSON.stringify({
            networkName: normalizedName,
            passwordEncrypted: normalizedPassword ? safeStorage.encryptString(normalizedPassword).toString("base64") : ""
        }, null, 2), "utf8");
        networkName = normalizedName;
        password = normalizedPassword;

        return { networkName, password };
    }

    function run(action, name = "", secret = "") {
        if (process.platform !== "win32") return Promise.reject(new Error("Mobile Hotspot is only available on Windows."));

        const script = powershellResource("hotspot.ps1");

        return new Promise((resolve, reject) => {
            execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Action", action, "-NetworkName", name, "-Passkey", secret, "-ScanPort", String(scanPort)], { windowsHide: true, timeout: action === "Firewall" ? 120000 : 30000 }, (error, stdout, stderr) => {
                let result;
                try { result = JSON.parse(stdout.trim()); } catch { return reject(new Error(stderr.trim() || "Mobile Hotspot did not return a valid response.")); }
                if (error || !result.ok) return reject(new Error(result?.error || stderr.trim() || "Mobile Hotspot operation failed."));
                resolve(result);
            });
        });
    }

    function addFirewallExceptionAfterLogin() {
        if (process.platform !== "win32") return;
        void run("Firewall").catch((error) => console.error(`Could not add the CHICTool scan endpoint to Windows Firewall: ${error.message}`));
    }

    return { getSettings: () => ({ networkName, password }), getNetworkName: () => networkName, normalizeName, saveSettings, run, addFirewallExceptionAfterLogin };
}

module.exports = { createHotspotService };
