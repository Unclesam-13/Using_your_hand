import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 8765;
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".wasm": "application/wasm",
  ".task": "application/octet-stream",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
};

function serve(req, res) {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((nic) => nic && nic.family === "IPv4" && !nic.internal)
    .map((nic) => nic.address);
}

const OPENSSL_CANDIDATES = [
  "openssl",
  "C:/Program Files/Git/usr/bin/openssl.exe",
  "C:/Program Files/Git/mingw64/bin/openssl.exe",
];

// 用自带的最小配置，避免依赖 openssl 安装目录里的 openssl.cnf（Miniconda 等版本可能缺失）
function opensslConfig() {
  const alt = ["DNS.1 = localhost", "IP.1 = 127.0.0.1", ...lanAddresses().map((ip, i) => `IP.${i + 2} = ${ip}`)];
  return [
    "[req]",
    "prompt = no",
    "distinguished_name = dn",
    "x509_extensions = ext",
    "[dn]",
    "CN = HandPulse",
    "[ext]",
    "subjectAltName = @alt",
    "basicConstraints = CA:FALSE",
    "keyUsage = digitalSignature, keyEncipherment",
    "extendedKeyUsage = serverAuth",
    "[alt]",
    ...alt,
    "",
  ].join("\n");
}

// 手机浏览器只允许在 HTTPS 下读取运动传感器，局域网模式用自签名证书
function ensureCert() {
  const dir = path.join(root, "certs");
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  if (!fs.existsSync(key) || !fs.existsSync(cert)) {
    // 先在纯英文的临时目录生成，避免部分 Windows 版 openssl 处理中文路径出错
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "handpulse-"));
    const cnf = path.join(work, "openssl.cnf");
    fs.writeFileSync(cnf, opensslConfig());
    const errors = [];
    let ok = false;
    for (const bin of OPENSSL_CANDIDATES) {
      try {
        execFileSync(bin, [
          "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "825",
          "-config", cnf, "-keyout", path.join(work, "key.pem"), "-out", path.join(work, "cert.pem"),
        ], { stdio: "pipe", env: { ...process.env, OPENSSL_CONF: cnf } });
        ok = true;
        break;
      } catch (error) {
        errors.push(`${bin}: ${error.stderr?.toString().trim().split("\n")[0] || error.message}`);
      }
    }
    if (!ok) {
      fs.rmSync(work, { recursive: true, force: true });
      console.error("无法生成 HTTPS 证书，尝试过的 openssl：");
      for (const line of errors) console.error("  " + line);
      console.error("Windows 请安装 Git for Windows，Mac 自带 openssl。");
      process.exit(1);
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(work, "key.pem"), key);
    fs.copyFileSync(path.join(work, "cert.pem"), cert);
    fs.rmSync(work, { recursive: true, force: true });
    console.log("已生成自签名证书: " + dir);
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

if (process.argv.includes("--lan")) {
  const lanPort = 8443;
  const server = https.createServer(ensureCert(), serve);
  server.on("error", (error) => onListenError(error, lanPort));
  server.listen(lanPort, "0.0.0.0", () => {
    console.log("");
    console.log("========================================");
    console.log("局域网 HTTPS 已启动，手机连同一个 WiFi 后打开：");
    for (const ip of lanAddresses()) console.log("  https://" + ip + ":" + lanPort + "/");
    console.log("");
    console.log("首次打开会提示「不安全/证书无效」，这是自签名证书，正常：");
    console.log("  安卓 Chrome：点「高级」→「继续前往」");
    console.log("  iPhone Safari：点「显示详细信息」→「访问此网站」");
    console.log("打不开时检查：电脑防火墙是否放行 Node、WiFi 是否开启了设备隔离");
    console.log("========================================");
    console.log("");
  });
} else {
  startTunnel();
}

function onListenError(error, busyPort) {
  if (error.code !== "EADDRINUSE") throw error;
  console.error("");
  console.error(`端口 ${busyPort} 已被占用，多半是之前启动的服务还开着。`);
  console.error("它会自动提供最新文件，直接继续用之前的地址即可；");
  console.error("想重启的话，先关掉之前那个终端窗口（或在里面按 Ctrl+C），再重新运行。");
  process.exit(1);
}

function startTunnel() {
const server = http.createServer(serve);
server.on("error", (error) => onListenError(error, port));
server.listen(port, "0.0.0.0", () => {
  console.log("");
  console.log("电脑打开:  http://127.0.0.1:" + port + "/");
  for (const ip of lanAddresses()) {
    console.log("同WiFi提示: http://" + ip + ":" + port + "/  （HTTP 无法读取传感器，局域网请用 npm run lan）");
  }
  console.log("");
  console.log("正在创建手机可用的 HTTPS 链接…");
  const child = spawn("npx", ["--yes", "cloudflared", "tunnel", "--url", "http://127.0.0.1:" + port], {
    stdio: ["ignore", "pipe", "pipe"],
    shell: true,
  });
  const onData = (buf) => {
    const text = buf.toString();
    process.stdout.write(text);
    const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (match) {
      console.log("");
      console.log("========================================");
      console.log("手机请用 Chrome / Safari 打开：");
      console.log(match[0]);
      console.log("点「开始感应」，安卓可「添加到主屏幕」");
      console.log("========================================");
      console.log("");
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("exit", (code) => {
    if (code) console.log("HTTPS 隧道退出，代码 " + code);
  });
});
}
