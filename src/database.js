const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

let dataDir;
let dbPath;
let db;
let activeUser = null;

function initDatabase() {
    dataDir = process.env.PCINFO_DATA_DIR || path.join(__dirname, "..", "data");
    dbPath = path.join(dataDir, "pcinfo.db");
    fs.mkdirSync(dataDir, { recursive: true });
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
    migrateSnakeCaseColumns();
    db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version (version)
      SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM schema_version);
    CREATE TABLE IF NOT EXISTS computers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      serialNumber TEXT NOT NULL UNIQUE,
      serialOverride TEXT,
      manufacturer TEXT,
      model TEXT,
      operatingSystem TEXT,
      processor TEXT,
      storage TEXT,
      memory TEXT,
      gpu TEXT,
      macAddress TEXT,
      details TEXT,
      hostname TEXT,
      username TEXT,
      machineType TEXT NOT NULL,
      acquiredOn TEXT,
      office TEXT NOT NULL,
      parHolder TEXT,
      primaryUser TEXT,
      remarks TEXT,
      collectedOn TEXT NOT NULL,
      scriptVersion TEXT,
      createdBy TEXT,
      updatedBy TEXT,
      deletedAt TEXT,
      deletedBy TEXT
    );
    CREATE TABLE IF NOT EXISTS lookup_values (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      value TEXT NOT NULL,
      label TEXT NOT NULL,
      sortOrder INTEGER NOT NULL DEFAULT 0,
      isActive INTEGER NOT NULL DEFAULT 1,
      UNIQUE(source, value)
    );
    CREATE TABLE IF NOT EXISTS migration_log (
      name TEXT PRIMARY KEY,
      completedOn TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_computers_hostname ON computers(hostname);
    CREATE INDEX IF NOT EXISTS idx_computers_office ON computers(office);
    CREATE TABLE IF NOT EXISTS peripherals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      syncId TEXT NOT NULL UNIQUE,
      computerId INTEGER REFERENCES computers(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      manufacturer TEXT,
      model TEXT,
      serialNumber TEXT,
      assetTag TEXT,
      assignedUser TEXT,
      remarks TEXT,
      createdBy TEXT,
      updatedBy TEXT,
      deletedAt TEXT,
      deletedBy TEXT
    );
    CREATE TABLE IF NOT EXISTS collection_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      computerId INTEGER REFERENCES computers(id),
      hostname TEXT,
      operation TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      createdOn TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      entity TEXT NOT NULL,
      entityId INTEGER,
      action TEXT NOT NULL,
      details TEXT,
      createdOn TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL COLLATE NOCASE UNIQUE,
      passwordSalt TEXT NOT NULL,
      passwordHash TEXT NOT NULL,
      createdOn TEXT NOT NULL,
      isActive INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_audit_logs_created_on ON audit_logs(createdOn);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON audit_logs(entity, entityId);
    CREATE INDEX IF NOT EXISTS idx_peripherals_serial ON peripherals(serialNumber);
    CREATE INDEX IF NOT EXISTS idx_peripherals_asset_tag ON peripherals(assetTag);
    CREATE INDEX IF NOT EXISTS idx_peripherals_computer ON peripherals(computerId);
  `);
    migratePeripheralLinking();
    migrateComputerPeripherals();
    removeMigratedPeripheralComputers();
    migrateUserOwnership();
    ensurePeripheralSyncIds();
    seedPeripheralTypes();
    // Office and device-type lookup values are managed manually; startup does not seed them.
    // Legacy CSV import is intentionally disabled. The application must not
    // repopulate inventory from old/test data on startup.
}

function migrateSnakeCaseColumns() {
    const columnRenames = {
        computers: {
            serial_number: "serialNumber",
            serial_override: "serialOverride",
            operating_system: "operatingSystem",
            mac_address: "macAddress",
            machine_type: "machineType",
            acquired_on: "acquiredOn",
            par_holder: "parHolder",
            primary_user: "primaryUser",
            collected_on: "collectedOn",
            script_version: "scriptVersion",
            created_by: "createdBy",
            updated_by: "updatedBy",
            deleted_at: "deletedAt",
            deleted_by: "deletedBy"
        },
        lookup_values: { sort_order: "sortOrder", is_active: "isActive" },
        migration_log: { completed_on: "completedOn" },
        peripherals: {
            sync_id: "syncId",
            computer_id: "computerId",
            serial_number: "serialNumber",
            asset_tag: "assetTag",
            assigned_user: "assignedUser",
            created_by: "createdBy",
            updated_by: "updatedBy",
            deleted_at: "deletedAt",
            deleted_by: "deletedBy"
        },
        collection_logs: { computer_id: "computerId", created_on: "createdOn" },
        audit_logs: { entity_id: "entityId", created_on: "createdOn" },
        users: { password_salt: "passwordSalt", password_hash: "passwordHash", created_on: "createdOn", is_active: "isActive" }
    };

    db.exec("BEGIN");
    try {
        for (const [table, renames] of Object.entries(columnRenames)) {
            const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get("table", table);
            if (!tableExists) continue;
            const columns = new Set(
                db
                    .prepare(`PRAGMA table_info('${table}')`)
                    .all()
                    .map((column) => column.name)
            );
            for (const [oldName, newName] of Object.entries(renames)) {
                if (columns.has(oldName) && !columns.has(newName)) {
                    db.exec(`ALTER TABLE ${table} RENAME COLUMN ${oldName} TO ${newName}`);
                    columns.delete(oldName);
                    columns.add(newName);
                }
            }
        }
        db.exec("COMMIT");
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}

function ensurePeripheralSyncIds() {
    const columns = db.prepare("PRAGMA table_info('peripherals')").all();
    if (!columns.some((column) => column.name === "syncId")) db.exec("ALTER TABLE peripherals ADD COLUMN syncId TEXT");
    const missing = db.prepare("SELECT id FROM peripherals WHERE syncId IS NULL OR trim(syncId) = ''").all();
    const update = db.prepare("UPDATE peripherals SET syncId = ? WHERE id = ?");
    for (const peripheral of missing) update.run(crypto.randomUUID(), peripheral.id);
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_peripherals_sync_id ON peripherals(syncId)");
}

function migrateUserOwnership() {
    const ensureColumn = (table, column) => {
        const exists = db
            .prepare(`PRAGMA table_info('${table}')`)
            .all()
            .some((item) => item.name === column);
        if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
    };
    ensureColumn("computers", "createdBy");
    ensureColumn("computers", "updatedBy");
    ensureColumn("peripherals", "createdBy");
    ensureColumn("peripherals", "updatedBy");
    ensureColumn("peripherals", "remarks");
    ensureColumn("computers", "deletedAt");
    ensureColumn("computers", "deletedBy");
    ensureColumn("peripherals", "deletedAt");
    ensureColumn("peripherals", "deletedBy");
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_computers_deleted_at ON computers(deletedAt);
    CREATE INDEX IF NOT EXISTS idx_peripherals_deleted_at ON peripherals(deletedAt);
  `);
}

function migratePeripheralLinking() {
    const column = db
        .prepare("PRAGMA table_info('peripherals')")
        .all()
        .find((item) => item.name === "computerId");
    if (!column || column.notnull !== 1) return;
    db.exec(`
    CREATE TABLE peripherals_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      computerId INTEGER REFERENCES computers(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      manufacturer TEXT,
      model TEXT,
      serialNumber TEXT,
      assetTag TEXT,
      assignedUser TEXT,
      remarks TEXT
    );
    INSERT INTO peripherals_new SELECT * FROM peripherals;
    DROP TABLE peripherals;
    ALTER TABLE peripherals_new RENAME TO peripherals;
  `);
}

function migrateComputerPeripherals() {
    const migrationName = "computer-peripherals-v1";
    if (db.prepare("SELECT 1 FROM migration_log WHERE name = ?").get(migrationName)) return;

    const peripheralTypes = ["MONITOR", "MULTI PURPOSE PRINTER", "UPS"];
    const candidates = db
        .prepare(
            `SELECT * FROM computers
    WHERE upper(trim(machineType)) IN (?, ?, ?)`
        )
        .all(...peripheralTypes);
    const computers = db
        .prepare(
            `SELECT * FROM computers
    WHERE upper(trim(machineType)) NOT IN (?, ?, ?)`
        )
        .all(...peripheralTypes);
    const exists = db.prepare("SELECT 1 FROM peripherals WHERE serialNumber = ? LIMIT 1");
    const insert = db.prepare(`INSERT INTO peripherals
    (computerId, type, manufacturer, model, serialNumber, assetTag, assignedUser, remarks)
    VALUES (@computerId, @type, @manufacturer, @model, @serialNumber, @assetTag, @assignedUser, @remarks)`);

    db.exec("BEGIN");
    try {
        candidates.forEach((device) => {
            if (exists.get(device.serialNumber)) return;
            const userNames = [device.primaryUser, device.parHolder]
                .map((value) =>
                    String(value || "")
                        .trim()
                        .toUpperCase()
                )
                .filter(Boolean);
            const matches = computers.filter((computer) => {
                const sameOffice =
                    String(computer.office || "")
                        .trim()
                        .toUpperCase() ===
                    String(device.office || "")
                        .trim()
                        .toUpperCase();
                const computerUser = String(computer.primaryUser || "")
                    .trim()
                    .toUpperCase();
                return sameOffice && computerUser && userNames.includes(computerUser);
            });
            const type = device.machineType.toUpperCase() === "MULTI PURPOSE PRINTER" ? "Printer" : device.machineType.toUpperCase() === "MONITOR" ? "Monitor" : "UPS";
            insert.run({
                computerId: matches.length === 1 ? matches[0].id : null,
                type,
                manufacturer: device.manufacturer || "",
                model: device.model || "",
                serialNumber: device.serialNumber || "",
                assetTag: "",
                assignedUser: device.primaryUser || device.parHolder || "",
                remarks: device.remarks || ""
            });
        });
        db.prepare("INSERT INTO migration_log (name, completedOn) VALUES (?, ?)").run(migrationName, new Date().toISOString());
        db.exec("COMMIT");
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}

function removeMigratedPeripheralComputers() {
    const migrationName = "computer-peripherals-v2-remove-source";
    if (db.prepare("SELECT 1 FROM migration_log WHERE name = ?").get(migrationName)) return;
    const types = ["MONITOR", "MULTI PURPOSE PRINTER", "UPS"];
    const sourceCount = db
        .prepare(
            `SELECT COUNT(*) AS count FROM computers
    WHERE upper(trim(machineType)) IN (?, ?, ?)`
        )
        .get(...types).count;
    if (sourceCount === 0) return;
    db.exec("BEGIN");
    try {
        db.prepare(
            `UPDATE peripherals SET computerId = NULL WHERE computerId IN
      (SELECT id FROM computers WHERE upper(trim(machineType)) IN (?, ?, ?))`
        ).run(...types);
        db.prepare(`DELETE FROM computers WHERE upper(trim(machineType)) IN (?, ?, ?)`).run(...types);
        db.prepare("INSERT INTO migration_log (name, completedOn) VALUES (?, ?)").run(migrationName, new Date().toISOString());
        db.exec("COMMIT");
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}

function seedPeripheralTypes() {
    const migrationName = "peripheral-type-lookups-v1";
    if (db.prepare("SELECT 1 FROM migration_log WHERE name = ?").get(migrationName)) return;
    const defaults = [
        ["Monitor", 10],
        ["Printer", 20],
        ["UPS", 30],
        ["Keyboard", 40],
        ["Mouse", 50],
        ["Docking Station", 60],
        ["Webcam", 70],
        ["Headset", 80],
        ["Speakers", 90],
        ["Scanner", 100],
        ["Projector", 110],
        ["Other", 120]
    ];
    const existing = db
        .prepare(
            `SELECT DISTINCT trim(type) AS type FROM peripherals
    WHERE trim(type) <> ''`
        )
        .all()
        .map((row) => row.type);
    const insert = db.prepare(`INSERT OR IGNORE INTO lookup_values
    (source, value, label, sortOrder) VALUES ('peripheral_type', ?, ?, ?)`);
    db.exec("BEGIN");
    try {
        defaults.forEach(([value, sortOrder]) => insert.run(value, value, sortOrder));
        existing.forEach((value, index) => insert.run(value, value, 200 + index));
        db.prepare("INSERT INTO migration_log (name, completedOn) VALUES (?, ?)").run(migrationName, new Date().toISOString());
        db.exec("COMMIT");
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}

function seedLookupValues() {
    const insert = db.prepare(`INSERT OR IGNORE INTO lookup_values
    (source, value, label, sortOrder) VALUES (@source, @value, @label, @sortOrder)`);
    const defaults = [
        { source: "device_type", value: "Desktop", label: "Desktop", sortOrder: 10 },
        { source: "device_type", value: "Laptop", label: "Laptop", sortOrder: 20 },
        { source: "device_type", value: "All-in-One", label: "All-in-One", sortOrder: 30 },
        { source: "device_type", value: "Workstation", label: "Workstation", sortOrder: 40 },
        { source: "device_type", value: "Server", label: "Server", sortOrder: 50 },
        { source: "device_type", value: "Tablet", label: "Tablet", sortOrder: 60 },
        { source: "device_type", value: "Thin Client", label: "Thin Client", sortOrder: 70 },
        { source: "device_type", value: "Other", label: "Other", sortOrder: 90 },
        { source: "office", value: "Main Office", label: "Main Office", sortOrder: 10 },
        { source: "office", value: "Branch Office", label: "Branch Office", sortOrder: 20 },
        { source: "office", value: "Remote", label: "Remote", sortOrder: 30 },
        { source: "office", value: "Other", label: "Other", sortOrder: 90 }
    ];
    db.exec("BEGIN");
    try {
        defaults.forEach((item) => insert.run(item));
        db.exec("COMMIT");
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}

function parseCsvLine(line) {
    const values = [];
    let value = "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
        const character = line[i];
        if (character === '"') {
            if (quoted && line[i + 1] === '"') {
                value += '"';
                i += 1;
            } else {
                quoted = !quoted;
            }
        } else if (character === "," && !quoted) {
            values.push(value);
            value = "";
        } else {
            value += character;
        }
    }
    values.push(value);
    return values;
}

function migrateLegacyCsv() {
    const migrationName = "legacy-pcinfo-csv-v1";
    if (db.prepare("SELECT 1 FROM migration_log WHERE name = ?").get(migrationName)) return;
    const legacyPath = path.join(__dirname, "..", "!", "pcinfo.csv");
    if (!fs.existsSync(legacyPath)) return;

    const lines = fs.readFileSync(legacyPath, "utf8").split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return;
    const headers = parseCsvLine(lines[0]);
    const rows = lines.slice(1).map((line) => Object.fromEntries(parseCsvLine(line).map((value, index) => [headers[index], value])));
    const columns = {
        SerialNumber: "serialNumber",
        SerialOverride: "serialOverride",
        Manufacturer: "manufacturer",
        Model: "model",
        OS: "operatingSystem",
        Processor: "processor",
        Storage: "storage",
        Memory: "memory",
        GPU: "gpu",
        MAC: "macAddress",
        Details: "details",
        Hostname: "hostname",
        Username: "username",
        MachineType: "machineType",
        AcquiredOn: "acquiredOn",
        Office: "office",
        PAR: "parHolder",
        User: "primaryUser",
        Remarks: "remarks",
        CollectedOn: "collectedOn",
        ScriptVersion: "scriptVersion"
    };
    const insert = db.prepare(`INSERT OR IGNORE INTO computers
    (serialNumber, serialOverride, manufacturer, model, operatingSystem, processor, storage, memory, gpu,
     macAddress, details, hostname, username, machineType, acquiredOn, office, parHolder, primaryUser,
     remarks, collectedOn, scriptVersion)
    VALUES (@serialNumber, @serialOverride, @manufacturer, @model, @operatingSystem, @processor, @storage,
     @memory, @gpu, @macAddress, @details, @hostname, @username, @machineType, @acquiredOn, @office,
     @parHolder, @primaryUser, @remarks, @collectedOn, @scriptVersion)`);
    db.exec("BEGIN");
    try {
        rows.forEach((row) => {
            const record = Object.fromEntries(Object.values(columns).map((column) => [column, ""]));
            Object.entries(columns).forEach(([legacy, current]) => {
                record[current] = row[legacy] || "";
            });
            if (record.serialNumber) insert.run(record);
        });
        db.prepare("INSERT INTO migration_log (name, completedOn) VALUES (?, ?)").run(migrationName, new Date().toISOString());
        db.exec("COMMIT");
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}

function listComputers() {
    return db.prepare("SELECT * FROM computers WHERE deletedAt IS NULL ORDER BY collectedOn DESC").all();
}

function normalizeUsername(username) {
    return String(username || "").trim();
}

function validateCredentials(username, password) {
    const normalizedUsername = normalizeUsername(username);
    if (!/^[A-Za-z0-9._-]{3,64}$/.test(normalizedUsername)) {
        throw new Error("Username must be 3-64 characters and may contain letters, numbers, dots, underscores, or hyphens.");
    }
    if (typeof password !== "string" || password.length < 8) {
        throw new Error("Password must be at least 8 characters.");
    }
    return normalizedUsername;
}

function hashPassword(password, salt = crypto.randomBytes(16)) {
    return {
        salt: salt.toString("hex"),
        hash: crypto.scryptSync(password, salt, 64).toString("hex")
    };
}

function getUserCount() {
    return db.prepare("SELECT COUNT(*) AS count FROM users WHERE isActive = 1").get().count;
}

function getAuthState() {
    return { hasUsers: getUserCount() > 0, currentUser: activeUser };
}

function registerUser(username, password) {
    const normalizedUsername = validateCredentials(username, password);
    if (getUserCount() > 0 && !activeUser) throw new Error("Sign in before registering an additional user.");
    if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(normalizedUsername)) {
        throw new Error("That username is already registered.");
    }
    const credentials = hashPassword(password);
    db.prepare(
        `INSERT INTO users (username, passwordSalt, passwordHash, createdOn)
    VALUES (?, ?, ?, ?)`
    ).run(normalizedUsername, credentials.salt, credentials.hash, new Date().toISOString());
    return db.prepare("SELECT id, username FROM users WHERE username = ?").get(normalizedUsername);
}

function authenticateUser(username, password) {
    const normalizedUsername = normalizeUsername(username);
    const user = db.prepare("SELECT id, username, passwordSalt, passwordHash FROM users WHERE username = ? AND isActive = 1").get(normalizedUsername);
    if (!user || typeof password !== "string") throw new Error("Invalid username or password.");
    const actual = crypto.scryptSync(password, Buffer.from(user.passwordSalt, "hex"), 64);
    const expected = Buffer.from(user.passwordHash, "hex");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
        throw new Error("Invalid username or password.");
    }
    return { id: user.id, username: user.username };
}

function setActiveUser(user) {
    activeUser = user ? { id: Number(user.id), username: String(user.username) } : null;
}

function requireActiveUser() {
    if (!activeUser) throw new Error("Please sign in before changing inventory.");
    return activeUser;
}

function writeAudit(entity, entityId, action, details = {}) {
    db.prepare(
        `INSERT INTO audit_logs
    (actor, entity, entityId, action, details, createdOn)
    VALUES (?, ?, ?, ?, ?, ?)`
    ).run(activeUser?.username || os.userInfo().username || "local-user", entity, entityId || null, action, JSON.stringify(details), new Date().toISOString());
}

function listAuditLogs(limit = 200) {
    const rows = db
        .prepare(
            `SELECT id, actor, entity, entityId, action, details, createdOn
    FROM audit_logs ORDER BY id DESC LIMIT ?`
        )
        .all(Math.max(1, Math.min(Number(limit) || 200, 1000)));
    return rows.map((row) => {
        try {
            row.details = JSON.parse(row.details || "{}");
        } catch {
            row.details = {};
        }
        return row;
    });
}

function listPeripherals(computerId, filter = "all") {
    if (filter === "all") {
        return db.prepare("SELECT * FROM peripherals WHERE deletedAt IS NULL ORDER BY id").all();
    }
    if (filter === "unassigned") {
        return db.prepare("SELECT * FROM peripherals WHERE deletedAt IS NULL AND computerId IS NULL ORDER BY id").all();
    }
    if (computerId === null || typeof computerId === "undefined") {
        return db.prepare("SELECT * FROM peripherals WHERE deletedAt IS NULL AND computerId IS NOT NULL ORDER BY id").all();
    }
    return db.prepare("SELECT * FROM peripherals WHERE deletedAt IS NULL AND computerId = ? ORDER BY id").all(computerId);
}

function listPeripheralsForSync() {
    return db
        .prepare(
            `SELECT p.*, c.serialNumber AS computerSerialNumber
    FROM peripherals p LEFT JOIN computers c ON c.id = p.computerId ORDER BY p.id`
        )
        .all();
}

function savePeripheral(input) {
    const user = requireActiveUser();
    if (!String(input.type || "").trim()) throw new Error("Peripheral type is required.");
    const values = {
        syncId: input.syncId || crypto.randomUUID(),
        computerId: input.computerId ? Number(input.computerId) : null,
        type: String(input.type).trim(),
        manufacturer: String(input.manufacturer || "").trim(),
        model: String(input.model || "").trim(),
        serialNumber: String(input.serialNumber || "").trim(),
        assetTag: String(input.assetTag || "").trim(),
        assignedUser: String(input.assignedUser || "").trim(),
        remarks: String(input.remarks || "").trim(),
        createdBy: user.username,
        updatedBy: user.username
    };
    if (!db.prepare(`SELECT 1 FROM lookup_values WHERE source = 'peripheral_type' AND value = ? AND isActive = 1`).get(values.type)) {
        throw new Error(`Peripheral Type "${values.type}" is not an active lookup value.`);
    }
    if (values.computerId && !db.prepare("SELECT 1 FROM computers WHERE id = ? AND deletedAt IS NULL").get(values.computerId)) {
        throw new Error("The selected computer does not exist.");
    }
    const existingId = input.id ? Number(input.id) : null;
    if (values.assetTag) {
        const duplicateAsset = db
            .prepare(
                `SELECT id FROM peripherals
      WHERE deletedAt IS NULL AND lower(trim(assetTag)) = lower(trim(?)) AND id <> ? LIMIT 1`
            )
            .get(values.assetTag, existingId || -1);
        if (duplicateAsset) throw new Error(`Asset tag "${values.assetTag}" is already used by another peripheral.`);
    }
    if (values.serialNumber) {
        const duplicateSerial = db
            .prepare(
                `SELECT id FROM peripherals
      WHERE deletedAt IS NULL AND lower(trim(serialNumber)) = lower(trim(?)) AND id <> ? LIMIT 1`
            )
            .get(values.serialNumber, existingId || -1);
        if (duplicateSerial) throw new Error(`Serial number "${values.serialNumber}" is already used by another peripheral.`);
    }
    if (existingId) {
        const updateValues = { ...values, id: existingId };
        delete updateValues.syncId;
        delete updateValues.createdBy;
        db.prepare(
            `UPDATE peripherals SET computerId=@computerId, type=@type, manufacturer=@manufacturer,
      model=@model, serialNumber=@serialNumber, assetTag=@assetTag, assignedUser=@assignedUser,
      remarks=@remarks, updatedBy=@updatedBy, deletedAt=NULL, deletedBy=NULL WHERE id=@id`
        ).run(updateValues);
        const updated = db.prepare("SELECT * FROM peripherals WHERE id = ?").get(existingId);
        if (!updated) throw new Error("Peripheral record was not found.");
        writeAudit("peripheral", existingId, "update", updated);
        return updated;
    }
    db.prepare(
        `INSERT INTO peripherals
    (syncId, computerId, type, manufacturer, model, serialNumber, assetTag, assignedUser, remarks, createdBy, updatedBy)
    VALUES (@syncId, @computerId, @type, @manufacturer, @model, @serialNumber, @assetTag, @assignedUser, @remarks, @createdBy, @updatedBy)`
    ).run(values);
    const created = db.prepare("SELECT * FROM peripherals WHERE id = last_insert_rowid()").get();
    writeAudit("peripheral", created.id, "create", created);
    return created;
}

function deletePeripheral(id) {
    const user = requireActiveUser();
    const recordId = Number(id);
    const existing = db.prepare("SELECT * FROM peripherals WHERE id = ? AND deletedAt IS NULL").get(recordId);
    if (!existing) throw new Error("Peripheral record was not found.");
    const deletedAt = new Date().toISOString();
    db.prepare("UPDATE peripherals SET deletedAt = ?, deletedBy = ?, updatedBy = ? WHERE id = ?").run(deletedAt, user.username, user.username, recordId);
    const deleted = db.prepare("SELECT * FROM peripherals WHERE id = ?").get(recordId);
    writeAudit("peripheral", recordId, "delete", deleted);
}

function deleteComputer(id) {
    const user = requireActiveUser();
    const recordId = Number(id);
    const existing = db.prepare("SELECT * FROM computers WHERE id = ? AND deletedAt IS NULL").get(recordId);
    if (!existing) throw new Error("Inventory record was not found.");
    db.exec("BEGIN");
    try {
        db.prepare("UPDATE peripherals SET computerId = NULL WHERE computerId = ?").run(recordId);
        const deletedAt = new Date().toISOString();
        db.prepare("UPDATE computers SET deletedAt = ?, deletedBy = ?, updatedBy = ? WHERE id = ?").run(deletedAt, user.username, user.username, recordId);
        const deleted = db.prepare("SELECT * FROM computers WHERE id = ?").get(recordId);
        writeAudit("computer", recordId, "delete", deleted);
        db.exec("COMMIT");
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}

function getLookupValues() {
    const rows = db
        .prepare(
            `SELECT source, value, label FROM lookup_values
    WHERE isActive = 1 ORDER BY source, sortOrder, label`
        )
        .all();
    return rows.reduce((result, row) => {
        (result[row.source] ||= []).push({ value: row.value, label: row.label });
        return result;
    }, {});
}

function replaceLookupValues(rows) {
    if (!Array.isArray(rows) || rows.length === 0) throw new Error("The server did not provide any lookup values.");
    const values = rows.map((row) => {
        const source = String(row?.source || "").trim();
        const value = String(row?.value || "").trim();
        const label = String(row?.label || "").trim();
        const sortOrder = Number(row?.sortOrder);
        if (!source || !value || !label || source.length > 100 || value.length > 255 || label.length > 255 || !Number.isInteger(sortOrder)) {
            throw new Error("The server returned an invalid lookup value.");
        }
        return { source, value, label, sortOrder, isActive: row.isActive ? 1 : 0 };
    });
    const sources = new Set(values.map((row) => row.source));
    for (const source of ["device_type", "office", "peripheral_type"]) {
        if (!sources.has(source)) throw new Error(`The server lookup snapshot is missing ${source}.`);
    }
    db.exec("BEGIN");
    try {
        db.exec("DELETE FROM lookup_values");
        const insert = db.prepare(`INSERT INTO lookup_values (source, value, label, sortOrder, isActive)
      VALUES (@source, @value, @label, @sortOrder, @isActive)`);
        values.forEach((value) => insert.run(value));
        db.exec("COMMIT");
        return values.length;
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}

function saveComputer(input) {
    const user = requireActiveUser();
    const required = ["serialNumber", "machineType", "office"];
    for (const field of required) {
        if (!String(input[field] || "").trim()) throw new Error(`${field} is required.`);
    }
    const serialNumber = String(input.serialNumber).trim();
    const machineType = String(input.machineType).trim();
    const office = String(input.office).trim();
    if (!db.prepare(`SELECT 1 FROM lookup_values WHERE source = 'device_type' AND value = ? AND isActive = 1`).get(machineType)) {
        throw new Error(`Machine Type "${machineType}" is not an active lookup value.`);
    }
    if (!db.prepare(`SELECT 1 FROM lookup_values WHERE source = 'office' AND value = ? AND isActive = 1`).get(office)) {
        throw new Error(`Office "${office}" is not an active lookup value.`);
    }
    const columns = [
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
        "scriptVersion",
        "createdBy",
        "updatedBy"
    ];
    const values = Object.fromEntries(columns.map((column) => [column, String(input[column] ?? "").trim()]));
    values.serialNumber = serialNumber;
    values.machineType = machineType;
    values.office = office;
    values.collectedOn = new Date().toISOString();
    values.createdBy = user.username;
    values.updatedBy = user.username;
    values.deletedAt = null;
    values.deletedBy = null;
    columns.push("deletedAt", "deletedBy");
    const existing = db.prepare("SELECT id FROM computers WHERE serialNumber = ?").get(values.serialNumber);
    const placeholders = columns.map((column) => `@${column}`).join(", ");
    const updates = columns
        .filter((column) => !["serialNumber", "createdBy"].includes(column))
        .map((column) => `${column}=excluded.${column}`)
        .join(", ");
    db.prepare(
        `INSERT INTO computers (${columns.join(", ")}) VALUES (${placeholders})
    ON CONFLICT(serialNumber) DO UPDATE SET ${updates}`
    ).run(values);
    const saved = db.prepare("SELECT * FROM computers WHERE serialNumber = ?").get(values.serialNumber);
    writeAudit("computer", saved.id, existing ? "update" : "create", saved);
    return saved;
}

function backupDatabase(destination) {
    const target = path.resolve(destination);
    if (target === path.resolve(dbPath)) throw new Error("Backup destination cannot be the active database.");
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) fs.unlinkSync(target);
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    writeAudit("database", null, "backup", { destination: target });
    return target;
}

function resetDatabase() {
    const counts = {
        computers: db.prepare("SELECT COUNT(*) AS count FROM computers").get().count,
        peripherals: db.prepare("SELECT COUNT(*) AS count FROM peripherals").get().count,
        collectionLogs: db.prepare("SELECT COUNT(*) AS count FROM collection_logs").get().count,
        auditLogs: db.prepare("SELECT COUNT(*) AS count FROM audit_logs").get().count
    };

    db.exec("BEGIN");
    try {
        // Keep lookup_values, schema_version, and migration_log intact.
        db.exec(`
      DELETE FROM peripherals;
      DELETE FROM collection_logs;
      DELETE FROM computers;
      DELETE FROM audit_logs;
      DELETE FROM sqlite_sequence
        WHERE name IN ('computers', 'peripherals', 'collection_logs', 'audit_logs');
    `);
        db.exec("COMMIT");
        return counts;
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
}

function csvValue(value) {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function exportInventoryCsv(destination) {
    requireActiveUser();
    const columns = [
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
        "scriptVersion",
        "createdBy",
        "updatedBy"
    ];
    const rows = db.prepare(`SELECT ${columns.join(", ")} FROM computers WHERE deletedAt IS NULL ORDER BY collectedOn DESC`).all();
    const csv = [columns.join(","), ...rows.map((row) => columns.map((column) => csvValue(row[column])).join(","))].join("\r\n") + "\r\n";
    fs.writeFileSync(destination, csv, "utf8");
    writeAudit("database", null, "export-csv", { destination, count: rows.length });
    return { destination, count: rows.length };
}

module.exports = {
    initDatabase,
    listComputers,
    listPeripherals,
    listPeripheralsForSync,
    listAuditLogs,
    getLookupValues,
    replaceLookupValues,
    getAuthState,
    registerUser,
    authenticateUser,
    setActiveUser,
    saveComputer,
    deleteComputer,
    savePeripheral,
    deletePeripheral,
    backupDatabase,
    resetDatabase,
    exportInventoryCsv
};
