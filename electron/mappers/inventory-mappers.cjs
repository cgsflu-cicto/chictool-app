function toComputer(row) {
    return {
        id: String(row.id), serialNumber: row.serialNumber, serialOverride: row.serialOverride || "",
        manufacturer: row.manufacturer || "", model: row.model || "", operatingSystem: row.operatingSystem || "",
        processor: row.processor || "", storage: row.storage || "", memory: row.memory || "", gpu: row.gpu || "",
        macAddress: row.macAddress || "", details: row.details || "", hostname: row.hostname || "", username: row.username || "",
        machineType: row.machineType, acquiredOn: row.acquiredOn || "", office: row.office, parHolder: row.parHolder || "",
        primaryUser: row.primaryUser || "", remarks: row.remarks || "", collectedOn: row.collectedOn, scriptVersion: row.scriptVersion || ""
    };
}

function fromComputer(row) {
    return {
        id: row.id ? Number(row.id) : undefined, serialNumber: row.serialNumber, serialOverride: row.serialOverride,
        manufacturer: row.manufacturer, model: row.model, operatingSystem: row.operatingSystem, processor: row.processor,
        storage: row.storage, memory: row.memory, gpu: row.gpu, macAddress: row.macAddress, details: row.details,
        hostname: row.hostname, username: row.username, machineType: row.machineType, acquiredOn: row.acquiredOn,
        office: row.office, parHolder: row.parHolder, primaryUser: row.primaryUser, remarks: row.remarks,
        collectedOn: row.collectedOn, scriptVersion: row.scriptVersion
    };
}

function toPeripheral(row) {
    return {
        id: String(row.id), syncId: row.syncId, computerId: row.computerId ? String(row.computerId) : "", type: row.type,
        manufacturer: row.manufacturer || "", model: row.model || "", serialNumber: row.serialNumber || "",
        assetTag: row.assetTag || "", assignedUser: row.assignedUser || "", remarks: row.remarks || ""
    };
}

function fromPeripheral(row) {
    return {
        id: row.id ? Number(row.id) : undefined, syncId: row.syncId || undefined,
        computerId: row.computerId ? Number(row.computerId) : null, type: row.type, manufacturer: row.manufacturer,
        model: row.model, serialNumber: row.serialNumber, assetTag: row.assetTag, assignedUser: row.assignedUser, remarks: row.remarks
    };
}

module.exports = { toComputer, fromComputer, toPeripheral, fromPeripheral };
