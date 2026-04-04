import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const electron = require("electron");
console.log('type', typeof electron);
console.log('value', electron);