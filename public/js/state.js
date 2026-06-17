const state = {
  config: {},
  coders: {},
  order: [],
  editingId: null,
  checkingAll: false,
  serverConnected: false,
  lastServerEventAt: Date.now(),
  realPrinter: { ip: '192.168.100.2', port: 3100 }
};

export { state };
