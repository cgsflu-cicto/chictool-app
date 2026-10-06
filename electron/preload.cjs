const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chictoolDesktop', {
  platform: process.platform,
  isDesktop: true,
  authState: () => ipcRenderer.invoke('sqlite:authState'),
  login: (username, password) => ipcRenderer.invoke('sqlite:login', username, password),
  register: (username, password) => ipcRenderer.invoke('sqlite:register', username, password),
  logout: () => ipcRenderer.invoke('sqlite:logout'),
  lookups: () => ipcRenderer.invoke('sqlite:lookups'),
  listComputers: () => ipcRenderer.invoke('sqlite:computers:list'),
  saveComputer: (computer) => ipcRenderer.invoke('sqlite:computers:save', computer),
  deleteComputer: (id) => ipcRenderer.invoke('sqlite:computers:delete', id),
  captureComputer: (request) => ipcRenderer.invoke('inventory:capture', request),
  getPushConfig: () => ipcRenderer.invoke('push:config'),
  testPushServer: (serverUrl) => ipcRenderer.invoke('push:testServer', serverUrl),
  setPushServer: (serverUrl) => ipcRenderer.invoke('push:setServer', serverUrl),
  pushLocalCapture: () => ipcRenderer.invoke('push:captureAndSend'),
  getPushInbox: () => ipcRenderer.invoke('push:inbox'),
  decidePush: (id, action, computer) => ipcRenderer.invoke('push:decide', id, action, computer),
  onPushReceived: (listener) => {
    const handler = (_event, submission) => listener(submission);
    ipcRenderer.on('push:received', handler);
    return () => ipcRenderer.removeListener('push:received', handler);
  },
  downloadTargetSetup: () => ipcRenderer.invoke('inventory:downloadTargetSetup'),
  trustTarget: (hostname) => ipcRenderer.invoke('inventory:trustTarget', hostname),
  listPeripherals: () => ipcRenderer.invoke('sqlite:peripherals:list'),
  savePeripheral: (peripheral) => ipcRenderer.invoke('sqlite:peripherals:save', peripheral),
  deletePeripheral: (id) => ipcRenderer.invoke('sqlite:peripherals:delete', id),
  getSyncSettings: () => ipcRenderer.invoke('database:syncSettings'),
  setSyncServer: (serverUrl) => ipcRenderer.invoke('database:setSyncServer', serverUrl),
  syncDatabase: () => ipcRenderer.invoke('database:sync'),
  resetDatabase: () => ipcRenderer.invoke('database:reset'),
  getHotspotSettings: () => ipcRenderer.invoke('hotspot:settings'),
  setHotspotName: (networkName, password) => ipcRenderer.invoke('hotspot:setNetworkName', networkName, password),
  openWindowsHotspotSettings: () => ipcRenderer.invoke('hotspot:openWindowsSettings'),
  getHotspotStatus: () => ipcRenderer.invoke('hotspot:status'),
  startHotspot: (networkName, password) => ipcRenderer.invoke('hotspot:start', networkName, password),
  stopHotspot: () => ipcRenderer.invoke('hotspot:stop'),
  getScanEndpointInfo: () => ipcRenderer.invoke('scan:endpointInfo'),
  onScanReceived: (listener) => {
    const handler = (_event, scan) => listener(scan);
    ipcRenderer.on('scan:fill', handler);
    return () => ipcRenderer.removeListener('scan:fill', handler);
  },
  completeScan: (requestId, result) => ipcRenderer.invoke('scan:complete', requestId, result),
});
