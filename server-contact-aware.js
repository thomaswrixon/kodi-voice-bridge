const fs = require("fs");
const path = require("path");

const originalReadFileSync = fs.readFileSync;

fs.readFileSync = function patchedReadFileSync(filename, ...args) {
  const result = originalReadFileSync.call(fs, filename, ...args);
  const isText = typeof result === "string";
  if (!isText || path.basename(String(filename)) !== "server-repeat-aware.js") {
    return result;
  }

  const marker = "const patchedModule = new Module(filename, module);";
  const first = result.indexOf(marker);
  if (first < 0 || result.indexOf(marker, first + marker.length) >= 0) {
    throw new Error("Contact-aware wrapper could not find repeat-aware compile marker");
  }

  const injection = `source = require("./contact-patch-helper").applyContactPatches(source, replaceOnce);\n\n`;
  return result.replace(marker, injection + marker);
};

try {
  require("./server-repeat-aware-v2");
} finally {
  fs.readFileSync = originalReadFileSync;
}
