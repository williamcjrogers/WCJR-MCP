import * as electronMainNs from "electron/main";
import electronMainDefault from "electron/main";
console.log('ns_keys', Object.keys(electronMainNs));
console.log('default_type', typeof electronMainDefault);
console.log('default_value', electronMainDefault);