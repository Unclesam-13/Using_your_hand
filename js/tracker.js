// 用手机运动传感器识别往复动作。系统给出的 acceleration 已融合陀螺仪去除重力，
// 单位 m/s²；往复运动时加速度沿运动方向正负交替，每出现一个反向的峰就是一次换向。
const WINDOW_MS = 1000;
const PEAK_ON = 1.5;
const PEAK_OFF = 0.6;
const MIN_HALF = 0.08;
const MAX_HALF = 1.1;
const GRAVITY_TAU = 0.15;
const SIGNAL_TAU = 0.033;
const SPEED_TAU = 0.1;

export class MotionStrokeTracker {
  constructor() {
    this.samples = [];
    this.axis = [0, 1, 0];
    this.gravity = null;
    this.prevTime = 0;
    this.signal = 0;
    this.speed = 0;
    this.accel = 0;
    this.lobeSign = 0;
    this.lobePeak = 0;
    this.lastSign = 0;
    this.lastTurn = 0;
    this.strokes = [];
    this.spm = 0;
    this.confirmed = 0;
    this.history = [];
    this.eventCount = 0;
    this.lastPeak = 0;
  }

  static supported() {
    return typeof window !== "undefined" && "DeviceMotionEvent" in window;
  }

  // iOS 13+ 必须在点击事件里直接调用
  static async requestPermission() {
    const api = window.DeviceMotionEvent;
    if (typeof api?.requestPermission !== "function") return true;
    return (await api.requestPermission()) === "granted";
  }

  handle(event, timeMs) {
    const dt = Math.min(0.1, this.prevTime ? (timeMs - this.prevTime) / 1000 : 0.016);
    const vec = this._linear(event, dt);
    if (!vec) return this._out(false);
    this.eventCount += 1;
    this.prevTime = timeMs;

    this.samples.push({ t: timeMs, v: vec });
    while (this.samples.length && timeMs - this.samples[0].t > WINDOW_MS) this.samples.shift();
    this._updateAxis();

    const raw = vec[0] * this.axis[0] + vec[1] * this.axis[1] + vec[2] * this.axis[2];
    // 按时间常数平滑，不同手机的传感器频率（60–200Hz）读数一致
    this.signal += (raw - this.signal) * (1 - Math.exp(-dt / SIGNAL_TAU));
    const mag = Math.abs(this.signal);
    this.speed += (mag - this.speed) * (1 - Math.exp(-dt / SPEED_TAU));
    this.accel *= Math.exp(-dt / 0.45);

    let pulsed = false;
    const sign = Math.sign(this.signal);
    if (mag >= PEAK_ON && sign !== this.lobeSign) {
      // 进入新的加速度峰，先把上一个峰结算掉
      if (this.lobeSign) pulsed = this._finishLobe(timeMs);
      this.lobeSign = sign;
      this.lobePeak = mag;
    } else if (this.lobeSign && sign === this.lobeSign) {
      this.lobePeak = Math.max(this.lobePeak, mag);
    }
    if (this.lobeSign && (mag < PEAK_OFF || sign !== this.lobeSign)) {
      pulsed = this._finishLobe(timeMs) || pulsed;
      this.lobeSign = 0;
    }
    if (this.lastTurn && (timeMs - this.lastTurn) / 1000 > MAX_HALF) this.confirmed = 0;

    this.strokes = this.strokes.filter((t) => timeMs - t < 4000);
    this.spm = this.strokes.length * 15;
    this.history.push({ t: timeMs, s: this.signal, pulsed });
    while (this.history.length && timeMs - this.history[0].t > 4000) this.history.shift();
    return this._out(pulsed);
  }

  _finishLobe(timeMs) {
    const peak = this.lobePeak;
    const sign = this.lobeSign;
    this.lobePeak = 0;
    if (sign === this.lastSign) return false;
    const halfT = this.lastTurn ? (timeMs - this.lastTurn) / 1000 : MAX_HALF;
    if (halfT < MIN_HALF) return false;
    this.lastSign = sign;
    this.lastTurn = timeMs;
    this.accel = this.accel * 0.4 + peak * 0.6;
    this.lastPeak = peak;
    // 停了很久后的第一个峰只是起步，不算换向
    if (halfT > MAX_HALF) {
      this.confirmed = 0;
      return false;
    }
    this.confirmed += 1;
    this.strokes.push(timeMs);
    return true;
  }

  _linear(event, dt) {
    const a = event.acceleration;
    if (a && a.x != null) return [a.x, a.y, a.z];
    // 部分安卓机没有去重力的数据，用低通滤波估计重力再减掉
    const g = event.accelerationIncludingGravity;
    if (!g || g.x == null) return null;
    const v = [g.x, g.y, g.z];
    if (!this.gravity) this.gravity = v.slice();
    const k = 1 - Math.exp(-dt / GRAVITY_TAU);
    this.gravity = this.gravity.map((value, i) => value + (v[i] - value) * k);
    return v.map((value, i) => value - this.gravity[i]);
  }

  // 主成分方向 = 往复运动方向，手机怎么拿都能用
  _updateAxis() {
    const n = this.samples.length;
    if (n < 10) return;
    const mean = [0, 0, 0];
    for (const { v } of this.samples) for (let i = 0; i < 3; i += 1) mean[i] += v[i] / n;
    const cov = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (const { v } of this.samples) {
      const d = v.map((value, i) => value - mean[i]);
      for (let i = 0; i < 3; i += 1) for (let j = 0; j < 3; j += 1) cov[i][j] += (d[i] * d[j]) / n;
    }
    if (cov[0][0] + cov[1][1] + cov[2][2] < 0.5) return;
    let axis = this.axis.slice();
    for (let k = 0; k < 8; k += 1) {
      const next = cov.map((row) => row[0] * axis[0] + row[1] * axis[1] + row[2] * axis[2]);
      const len = Math.hypot(...next) || 1;
      axis = next.map((value) => value / len);
    }
    // 保持方向符号稳定，否则正负峰会被打乱
    const dot = axis[0] * this.axis[0] + axis[1] * this.axis[1] + axis[2] * this.axis[2];
    this.axis = dot < 0 ? axis.map((value) => -value) : axis;
  }

  _out(pulsed) {
    return {
      accel: this.accel,
      speed: this.speed,
      peak: this.lastPeak,
      confirmed: this.confirmed,
      spm: this.spm,
      pulsed,
    };
  }
}
