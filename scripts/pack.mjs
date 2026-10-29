import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "HandPulse-手机版.zip");
const items = ["index.html", "css", "js", "icons", "manifest.webmanifest", "sw.js"];
const missing = items.filter((item) => !fs.existsSync(path.join(root, item)));
if (missing.length) {
  console.error("缺少文件:", missing.join(", "));
  process.exit(1);
}
// audio 文件夹可选：放了默认音频就一起打包
if (fs.existsSync(path.join(root, "audio"))) items.push("audio");
if (fs.existsSync(out)) fs.unlinkSync(out);
execFileSync("powershell", [
  "-NoProfile",
  "-Command",
  `Compress-Archive -Path ${items.map((item) => `'${path.join(root, item)}'`).join(",")} -DestinationPath '${out}' -Force`,
]);
console.log("已生成: " + out);
