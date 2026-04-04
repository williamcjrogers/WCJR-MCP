import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const main = require("electron/main");
const renderer = require("electron/renderer");
console.log('main_keys', Object.keys(main));
console.log('renderer_keys', Object.keys(renderer));
console.log('has_app', typeof main.app);
console.log('has_contextBridge', typeof renderer.contextBridge);