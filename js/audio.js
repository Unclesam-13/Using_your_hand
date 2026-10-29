// 三个档位：加速度达到各自阈值（m/s²，可在页面上调）时切换到对应音频
export const LEVELS = [
  { id: "level1", name: "一档", color: "#ff9bb8", threshold: 3, file: "audio/level1.mp3" },
  { id: "level2", name: "二档", color: "#ff3d7f", threshold: 10, file: "audio/level2.mp3" },
  { id: "level3", name: "三档", color: "#ffd39a", threshold: 20, file: "audio/level3.mp3" },
];

export const STROKE_SLOT = {
  id: "stroke",
  name: "每次换向",
  color: "#f3dce6",
  file: "audio/stroke.mp3",
};

export const ALL_SLOTS = [...LEVELS, STROKE_SLOT];

const DB_NAME = "hand-pulse-audio";
const STORE = "clips";
// 档位之间交叉淡化、暂停/继续时淡入淡出的时间常数（秒）
const CROSSFADE_TAU = 0.15;
const PAUSE_TAU = 0.08;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function dbPut(record) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function dbDelete(id) {
  const db = await openDb();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function dbGetAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

// 全部用 Web Audio 播放：音频解码成缓冲区，经独立增益节点输出，
// 这样音量能随加速度连续变化（iPhone 上 <audio> 的 volume 无法用代码调节）。
// 三个档位的音频同时循环、只调各自音量，切换是交叉淡化，节奏不会断；
// 暂停时记住播放位置，继续时从原处接着放。没有上传音频的档位用内置合成音。
export class FileAudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.clips = new Map();
    this.voices = new Map();
    this.offsets = new Map();
    this.playing = false;
    this.levelIdx = -1;
    this.level = 0;
    this.volume = 0.72;
    this.muted = false;
    this.strokeOn = true;
    this._started = false;
    this._strokeAt = 0;
    this.onChange = () => {};
  }

  async start() {
    if (!this.ctx) {
      // iPhone 静音开关默认会让网页音频没声，声明为播放类音频可绕开（Safari 17+）
      if (navigator.audioSession) navigator.audioSession.type = "playback";
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state !== "running") await this.ctx.resume().catch(() => {});
    if (this._started) return;
    this._started = true;
    await this.restore();
  }

  async restore() {
    const saved = await dbGetAll().catch(() => []);
    const ids = new Set(ALL_SLOTS.map((slot) => slot.id));
    for (const item of saved) {
      // 旧版本（五档）留下的记录直接清掉
      if (!ids.has(item.id)) {
        dbDelete(item.id).catch(() => {});
        continue;
      }
      await this._mount(item.id, item.blob, item.name, { persist: false, source: "upload" }).catch(() => {});
    }
    for (const slot of ALL_SLOTS) {
      if (this.clips.has(slot.id)) continue;
      try {
        const res = await fetch(slot.file, { cache: "no-store" });
        if (!res.ok) continue;
        const blob = await res.blob();
        if (!blob.size || !blob.type.startsWith("audio")) continue;
        await this._mount(slot.id, blob, slot.file.split("/").pop(), { persist: false, source: "folder" });
      } catch {
        // 文件夹里没有对应文件时用内置合成音
      }
    }
    this.onChange();
  }

  list() {
    return ALL_SLOTS.map((slot) => {
      const clip = this.clips.get(slot.id);
      return {
        ...slot,
        ready: Boolean(clip),
        fileName: clip?.name || (slot.id === "stroke" ? "内置提示音" : "内置合成音"),
        source: clip?.source || "builtin",
      };
    });
  }

  async assignFile(id, file) {
    await this._mount(id, file, file.name, { persist: true, source: "upload" });
    this.onChange();
  }

  async clear(id) {
    this.clips.delete(id);
    await dbDelete(id);
    this._rebuild(id);
    this.onChange();
  }

  setVolume(value) {
    this.volume = Number(value);
    if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.02);
  }

  setMuted(muted) {
    this.muted = muted;
    this.setVolume(this.volume);
  }

  // levelIdx：-1 表示没到一档（暂停），0–2 为档位；level 0–1 为当前档位的音量
  update(levelIdx, level) {
    if (!this.ctx) return;
    if (levelIdx < 0) {
      this.pause();
      return;
    }
    if (!this.playing) this._resume();
    this.levelIdx = levelIdx;
    this.level = level;
    const now = this.ctx.currentTime;
    LEVELS.forEach((slot, i) => {
      const voice = this.voices.get(slot.id);
      if (voice) voice.gain.gain.setTargetAtTime(i === levelIdx ? level : 0, now, CROSSFADE_TAU);
    });
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.levelIdx = -1;
    const now = this.ctx.currentTime;
    for (const [id, voice] of this.voices) {
      this.offsets.set(id, voice.position(now));
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setTargetAtTime(0, now, PAUSE_TAU);
      voice.stop(now + PAUSE_TAU * 6);
    }
    this.voices.clear();
  }

  _resume() {
    this.playing = true;
    for (const slot of LEVELS) this.voices.set(slot.id, this._voice(slot.id));
  }

  // 上传或清除音频时，若正在播放就替换这一档的声音
  _rebuild(id) {
    if (!this.playing || !LEVELS.some((slot) => slot.id === id)) {
      this.offsets.delete(id);
      return;
    }
    const now = this.ctx.currentTime;
    const old = this.voices.get(id);
    if (old) {
      old.gain.gain.setTargetAtTime(0, now, PAUSE_TAU);
      old.stop(now + PAUSE_TAU * 6);
    }
    this.offsets.delete(id);
    const voice = this._voice(id);
    this.voices.set(id, voice);
    const idx = LEVELS.findIndex((slot) => slot.id === id);
    voice.gain.gain.setTargetAtTime(idx === this.levelIdx ? this.level : 0, now, CROSSFADE_TAU);
  }

  _voice(id) {
    const clip = this.clips.get(id);
    return clip ? this._clipVoice(clip, this.offsets.get(id) || 0) : this._synthVoice(LEVELS.findIndex((slot) => slot.id === id));
  }

  pulse(strength = 1, force = false) {
    if ((!this.strokeOn && !force) || !this.ctx || this.ctx.state !== "running") return;
    const now = this.ctx.currentTime;
    if (now - this._strokeAt < 0.08) return;
    this._strokeAt = now;
    const gain = this.ctx.createGain();
    gain.connect(this.master);
    const clip = this.clips.get("stroke");
    if (clip) {
      const src = this.ctx.createBufferSource();
      src.buffer = clip.buffer;
      gain.gain.value = strength;
      src.connect(gain);
      src.start(now);
      return;
    }
    // 内置提示音：短促的“嗒”，越用力越亮
    const osc = this.ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(700 + 900 * strength, now);
    osc.frequency.exponentialRampToValueAtTime(200, now + 0.08);
    gain.gain.setValueAtTime(0.15 + 0.45 * strength, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
    osc.connect(gain);
    osc.start(now);
    osc.stop(now + 0.12);
  }

  preview(id) {
    if (!this.ctx) return;
    if (id === "stroke") {
      [0, 0.25, 0.5].forEach((t) => window.setTimeout(() => this.pulse(1, true), t * 1000));
      return;
    }
    const clip = this.clips.get(id);
    const voice = clip ? this._clipVoice(clip, 0) : this._synthVoice(LEVELS.findIndex((slot) => slot.id === id));
    const now = this.ctx.currentTime;
    voice.gain.gain.setTargetAtTime(0.9, now, 0.05);
    voice.gain.gain.setTargetAtTime(0, now + 1.8, 0.1);
    voice.stop(now + 2.4);
  }

  _clipVoice(clip, offset) {
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    gain.connect(this.master);
    const src = this.ctx.createBufferSource();
    src.buffer = clip.buffer;
    src.loop = true;
    src.connect(gain);
    const duration = clip.buffer.duration;
    const from = offset % duration;
    const startedAt = this.ctx.currentTime;
    src.start(startedAt, from);
    return {
      gain,
      stop: (t) => src.stop(t),
      position: (t) => (from + t - startedAt) % duration,
    };
  }

  // 内置合成音：每档一个音高，档位越高越亮
  _synthVoice(idx) {
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    gain.connect(this.master);
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.Q.value = 4;
    filter.frequency.value = [600, 1400, 2800][idx] || 1000;
    filter.connect(gain);
    const base = [110, 165, 220][idx] || 110;
    const oscs = [["sawtooth", base], ["sine", base * 2]].map(([type, freq]) => {
      const osc = this.ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = freq;
      osc.connect(filter);
      osc.start();
      return osc;
    });
    return { gain, synth: true, stop: (t) => oscs.forEach((osc) => osc.stop(t)), position: () => 0 };
  }

  async _mount(id, blob, name, { persist, source }) {
    const buffer = await this.ctx.decodeAudioData(await blob.arrayBuffer());
    this.clips.set(id, { buffer, name, source });
    if (persist) await dbPut({ id, name, type: blob.type, blob });
    this._rebuild(id);
  }
}
