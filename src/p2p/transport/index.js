// The transports of PLAN 3.4. rtc-node is not here: it is planned after 1.0 if a prebuilt
// WebRTC binding proves stable on all three systems.
export { Connection } from './base.js';
export { inprocPair, InprocNetwork } from './inproc.js';
export { listenLan, connectLan, LAN_PATH, LAN_PORT } from './ws-lan.js';
export { BrowserPipeHub } from './browser-pipe.js';
export const TRANSPORTS = Object.freeze(['inproc', 'ws-lan', 'browser-pipe']);
