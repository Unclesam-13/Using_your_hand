import { MotionStrokeTracker } from "./tracker.js";
import { FileAudioEngine, LEVELS } from "./audio.js";

const wave = document.getElementById("wave");
const ctx = wave.getContext("2d");
const hint = document.getElementById("hint");
const liveDot = document.getElementById("liveDot");
const btnStart = document.getElementById("btnStart");
const btnMute = document.getElementById("btnMute");
const speedValue = document.getElementById("speedValue");
const speedBar = document.getElementById("speedBar");
const tierName = document.getElementById("tierName");
const spmValue = document.getElementById("spmValue");
const intensityValue = document.getElementById("intensityValue");
const volume = document.getElementById("volume");
const strokeOn = document.getElementById("strokeOn");
const volumeText = document.getElementById("volumeText");
const clipList = document.getElementById("clipList");

// 降档或停止：加速度要低于当前阈值的 HYST 倍并持续 HOLD_MS，避免在阈值附近来回跳
const HYST = 0.85;
const HOLD_MS = 200;
const STROKE_GAP_MS = 450;
// 一档阈值处音量为 MIN_LEVEL，到三档阈值的 TOP_RATIO 倍时为 1，跨档连续不跳变
const MIN_LEVEL = 0.4;
const TOP_RATIO = 1.5;
const MIN_GAP = 1;
const T_MIN = 0.5;
const T_MAX = 60;
const SETTINGS_KEY = "hand-pulse-settings-v2";
const tracker = new MotionStrokeTracker();
const audio = new FileAudioEngine();
const thresholds = LEVELS.map((slot) => slot.threshold);
let running = false;
let muted = false;
let levelIdx = -1;
let belowSince = 0;
let lastStrokeAt = 0;
let state = { motion: 0, level: 0, result: null };
let wakeLock = null;

audio.onChange = renderClips;
btnStart.addEventListener("click", start);
btnMute.addEventListener("click", toggleMute);
loadSettings();
for (const input of [volume, strokeOn]) input.addEventListener("input", applySettings);
applySettings();

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}

if (!MotionStrokeTracker.supported()) {
  hint.textContent = "当前浏览器不支持运动传感器，请用手机的 Chrome 或 Safari 打开。";
  btnStart.disabled = true;
} else if (!window.isSecureContext) {
  hint.textContent = "读取传感器需要 HTTPS。请在电脑上运行 npm run lan，用手机打开打印出的 https 地址。";
}

renderClips();
audio.start().catch(() => {});
drawLoop();

async function start() {
  btnStart.disabled = true;
  try {
    // iOS 要求在点击里第一时间申请权限，前面不能有其他 await
    // 被拒绝也先照常监听，只有确实收不到数据时才提示权限问题
    const granted = await MotionStrokeTracker.requestPermission().catch(() => false);
    await audio.start();
    audio.setVolume(volume.value);
    window.addEventListener("devicemotion", onMotion);
    running = true;
    liveDot.classList.add("live");
    btnMute.disabled = false;
    btnStart.textContent = "感应中";
    hint.textContent = "握住手机做连续往复，数字应随动作变化。";
    keepAwake();
    window.setTimeout(() => {
      if (tracker.eventCount) return;
      hint.textContent = granted
        ? "没有收到传感器数据：电脑一般没有运动传感器，请用手机打开；手机上请确认是 https 地址。"
        : "没有获得运动传感器权限。iPhone 请在弹窗里点「允许」，如已拒绝需关闭页面重新打开。";
    }, 1500);
  } catch (error) {
    btnStart.disabled = false;
    hint.textContent = `启动失败：${error.message}`;
  }
}

// 甩动时屏幕不熄灭
async function keepAwake() {
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch {
    // 不支持就算了
  }
}

document.addEventListener("visibilitychange", () => {
  if (running && document.visibilityState === "visible" && (!wakeLock || wakeLock.released)) keepAwake();
});

function toggleMute() {
  muted = !muted;
  audio.setMuted(muted);
  btnMute.textContent = muted ? "取消静音" : "静音";
}

// 达到第几档（-1 表示一档都没到），ratio 用于降档时的迟滞
function highestLevel(motion, ratio = 1) {
  for (let i = thresholds.length - 1; i >= 0; i -= 1) {
    if (motion >= thresholds[i] * ratio) return i;
  }
  return -1;
}

function loudness(motion) {
  const lo = thresholds[0];
  const hi = thresholds.at(-1) * TOP_RATIO;
  return MIN_LEVEL + (1 - MIN_LEVEL) * Math.min(1, Math.max(0, (motion - lo) / (hi - lo)));
}

function onMotion(event) {
  const now = performance.now();
  const result = tracker.handle(event, now);
  if (result.pulsed) lastStrokeAt = now;
  // 换向峰值衰减较慢，只在最近还有换向时参考；停手后只看实时加速度，暂停更及时
  const live = result.speed * 1.4;
  const motion = now - lastStrokeAt < STROKE_GAP_MS ? Math.max(result.accel, live) : live;
  const up = highestLevel(motion);
  const keep = highestLevel(motion, HYST);
  if (up > levelIdx) {
    levelIdx = up;
    belowSince = 0;
  } else if (keep < levelIdx) {
    if (!belowSince) belowSince = now;
    if (now - belowSince >= HOLD_MS) {
      levelIdx = keep;
      belowSince = 0;
    }
  } else {
    belowSince = 0;
  }

  const level = levelIdx >= 0 ? loudness(motion) : 0;
  audio.update(levelIdx, level);
  if (result.pulsed && levelIdx >= 0) audio.pulse(level);
  state = { motion, level, result };
}

function applySettings() {
  volumeText.textContent = `${Math.round(volume.value * 100)}%`;
  audio.setVolume(volume.value);
  audio.strokeOn = strokeOn.checked;
  saveSettings();
}

// 调某一档时把相邻档位推开，保证 一档 < 二档 < 三档
function setThreshold(idx, value) {
  thresholds[idx] = Math.min(T_MAX, Math.max(T_MIN, value));
  for (let i = idx + 1; i < thresholds.length; i += 1) {
    thresholds[i] = Math.min(T_MAX, Math.max(thresholds[i], thresholds[i - 1] + MIN_GAP));
  }
  for (let i = thresholds.length - 1; i > 0; i -= 1) {
    thresholds[i - 1] = Math.max(T_MIN, Math.min(thresholds[i - 1], thresholds[i] - MIN_GAP));
  }
  syncThresholdInputs();
  saveSettings();
}

function syncThresholdInputs() {
  for (const input of clipList.querySelectorAll("input[data-threshold]")) {
    const idx = Number(input.dataset.threshold);
    input.value = thresholds[idx];
    input.nextElementSibling.textContent = `${thresholds[idx].toFixed(1)} m/s²`;
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({ thresholds, volume: volume.value, strokeOn: strokeOn.checked }));
  } catch {
    // 隐私模式下存不了，不影响使用
  }
}

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    if (!saved) return;
    if (Array.isArray(saved.thresholds) && saved.thresholds.length === thresholds.length) {
      saved.thresholds.forEach((value, i) => (thresholds[i] = Number(value)));
    }
    if (saved.volume != null) volume.value = saved.volume;
    if (typeof saved.strokeOn === "boolean") strokeOn.checked = saved.strokeOn;
  } catch {
    // 读不到就用默认值
  }
}

function drawLoop() {
  const { motion, level, result } = state;
  if (running && result) {
    const slot = LEVELS[levelIdx];
    speedValue.textContent = motion.toFixed(1);
    hint.textContent = slot ? `往复 ${result.confirmed} 次` : "手机静止，音频已暂停";
    speedBar.style.width = `${Math.round(Math.min(1, motion / (thresholds.at(-1) * TOP_RATIO)) * 100)}%`;
    tierName.textContent = slot ? slot.name : "静止";
    tierName.style.color = slot ? slot.color : "";
    spmValue.textContent = Math.round(result.spm);
    intensityValue.textContent = `${Math.round(level * 100)}%`;
    highlightActive(slot?.id);
  }
  drawWave();
  requestAnimationFrame(drawLoop);
}

// 画最近 4 秒沿运动方向的加速度，金点是识别到的换向，虚线是三个档位阈值
function drawWave() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(wave.clientWidth * dpr);
  const h = Math.round(wave.clientHeight * dpr);
  if (wave.width !== w) wave.width = w;
  if (wave.height !== h) wave.height = h;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(255, 180, 210, 0.15)";
  ctx.lineWidth = dpr;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  const points = tracker.history;
  if (points.length < 2) return;
  const now = points.at(-1).t;
  const range = Math.max(10, thresholds[0] * 1.5, ...points.map((p) => Math.abs(p.s))) * 1.1;
  const x = (t) => w - ((now - t) / 4000) * w;
  const y = (s) => h / 2 - (s / range) * (h * 0.45);
  ctx.setLineDash([6 * dpr, 6 * dpr]);
  LEVELS.forEach((slot, i) => {
    if (thresholds[i] > range) return;
    ctx.strokeStyle = slot.color;
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    for (const s of [thresholds[i], -thresholds[i]]) {
      ctx.moveTo(0, y(s));
      ctx.lineTo(w, y(s));
    }
    ctx.stroke();
  });
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  ctx.strokeStyle = LEVELS[levelIdx]?.color || "#8d7380";
  ctx.lineWidth = 2 * dpr;
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p.s)) : ctx.moveTo(x(p.t), y(p.s))));
  ctx.stroke();
  ctx.fillStyle = "rgba(255, 211, 154, 0.95)";
  for (const p of points) {
    if (!p.pulsed) continue;
    ctx.beginPath();
    ctx.arc(x(p.t), y(p.s), 4 * dpr, 0, Math.PI * 2);
    ctx.fill();
  }
}

function renderClips() {
  clipList.innerHTML = "";
  for (const slot of audio.list()) {
    const idx = LEVELS.findIndex((item) => item.id === slot.id);
    const row = document.createElement("div");
    row.className = "clip-row";
    row.dataset.slot = slot.id;
    row.innerHTML = `
      <div class="clip-meta">
        <strong style="color: ${slot.color}">${slot.name}</strong>
        <em title="${escapeHtml(slot.fileName)}">${escapeHtml(slot.fileName)}</em>
      </div>
      ${idx >= 0 ? `
      <label class="threshold">
        阈值
        <input type="range" min="${T_MIN}" max="${T_MAX}" step="0.5" data-threshold="${idx}" />
        <b></b>
      </label>` : ""}
      <div class="clip-actions">
        <label class="btn slim">
          选择
          <input type="file" accept="audio/*" hidden data-assign="${slot.id}" />
        </label>
        <button class="btn slim" data-preview="${slot.id}">试听</button>
        <button class="btn slim" data-clear="${slot.id}" ${slot.ready ? "" : "disabled"}>清除</button>
      </div>
    `;
    clipList.appendChild(row);
  }
  syncThresholdInputs();
}

// 拖动阈值时只更新数值，不重建列表，否则正在拖的滑块会被替换掉
clipList.addEventListener("input", (event) => {
  const input = event.target;
  if (input instanceof HTMLInputElement && input.dataset.threshold) {
    setThreshold(Number(input.dataset.threshold), Number(input.value));
  }
});

clipList.addEventListener("change", async (event) => {
  const input = event.target;
  if (!(input instanceof HTMLInputElement) || !input.dataset.assign || !input.files?.[0]) return;
  await audio.start();
  try {
    await audio.assignFile(input.dataset.assign, input.files[0]);
  } catch {
    hint.textContent = `无法读取「${input.files[0].name}」，请换成 mp3 / m4a / wav 格式。`;
  }
  input.value = "";
});

clipList.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  await audio.start();
  if (button.dataset.preview) audio.preview(button.dataset.preview);
  if (button.dataset.clear) await audio.clear(button.dataset.clear);
});

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function highlightActive(id) {
  for (const row of clipList.querySelectorAll(".clip-row")) {
    row.classList.toggle("active", row.dataset.slot === id);
  }
}
