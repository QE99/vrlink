/* VRlink UI 音效播放器 · vrlink-sfx.js
 * ---------------------------------------------------------------
 * 零依赖 ES module，直接用 Web Audio 播 sounds/ 下的 wav。
 *
 *   import { sfx } from './sfx/vrlink-sfx.js';
 *   sfx.play('ui_click');                       // 默认音量
 *   sfx.play('ui_dede', { volume: .8, pan: -.3 }); // 左前方一点
 *   await sfx.preload(['ui_click', 'ui_dede']);  // 开场预解码（可选）
 *
 * 特性：
 *  - 懒创建 AudioContext + 自动解锁浏览器自动播放限制
 *  - 解码缓存、同音 30ms 去重、±3% 随机音高（避免机关枪感）
 *  - 主音量持久化到 localStorage，可静音
 *  - 文件缺失/解码失败时退化为振荡器合成音，永不哑火
 *  - 不依赖 manifest：id 就是文件名，manifest 只提供默认增益
 */
const DEFAULT_GAIN = {
  ui_click: 0.55, ui_click_soft: 0.4, ui_hover: 0.2, ui_dede: 0.6,
  ui_confirm: 0.5, ui_cancel: 0.45, ui_error: 0.5, ui_notify: 0.55,
  ui_msg_in: 0.45, ui_msg_out: 0.32, ui_room_join: 0.55, ui_room_leave: 0.5,
  ui_toggle_on: 0.35, ui_toggle_off: 0.35, ui_warp: 0.45, ui_page: 0.3,
  ui_ready: 0.5,
};

/* 退化合成音：万一 wav 读不到，也能有个像样的提示音 */
const FALLBACK = {
  click: { type: 'triangle', from: 900, to: 500, dur: 0.05, vol: 0.18 },
  blip: { type: 'sine', from: 660, to: 600, dur: 0.09, vol: 0.22 },
  up: { type: 'sine', from: 780, to: 1180, dur: 0.16, vol: 0.18 },
  down: { type: 'sine', from: 700, to: 420, dur: 0.16, vol: 0.18 },
  bell: { type: 'sine', from: 1046, to: 1046, dur: 0.35, vol: 0.16 },
};
const FALLBACK_OF = {
  ui_click: 'click', ui_click_soft: 'click', ui_hover: 'click',
  ui_dede: 'blip', ui_confirm: 'up', ui_cancel: 'down', ui_error: 'down',
  ui_notify: 'bell', ui_msg_in: 'blip', ui_msg_out: 'click',
  ui_room_join: 'up', ui_room_leave: 'down', ui_toggle_on: 'up',
  ui_toggle_off: 'down', ui_warp: 'up', ui_page: 'click', ui_ready: 'up',
};

export class UISfx {
  /**
   * @param {object} [opts]
   * @param {string|URL} [opts.baseUrl] wav 目录，默认与本文件同级的 sounds/
   * @param {number} [opts.volume] 主音量 0..1
   * @param {boolean} [opts.muted]
   * @param {boolean} [opts.vary] 是否随机音高（默认 true）
   * @param {string} [opts.storageKey]
   */
  constructor(opts = {}) {
    this.baseUrl = opts.baseUrl || new URL('./sounds/', import.meta.url);
    this.storageKey = opts.storageKey || 'vrlink.sfx';
    this.vary = opts.vary !== false;

    this._ctx = null;
    this._master = null;
    this._buffers = new Map();
    this._pending = new Map();
    this._lastAt = new Map();
    this._decoding = null;
    this._failed = new Set();
    this._manifest = null;

    const saved = this._readState();
    this._volume = clamp(opts.volume ?? saved.volume ?? 0.7, 0, 1);
    this._muted = !!opts.muted || !!saved.muted;

    this._unlockBound = () => this.unlock();
    if (typeof window !== 'undefined') {
      // 首次用户手势时解锁（Chrome/WebView2 的自动播放策略）
      for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
        window.addEventListener(ev, this._unlockBound, { once: true, passive: true });
      }
    }
  }

  /* ------------------------------------------------------------- 音量 */
  /** 当前 AudioContext（没有就创建一个；第一次调用时通常还是 suspended） */
  get context() { return this._ensureCtx(); }
  /** "uninitialized" | "suspended" | "running" | "closed" */
  get state() { return this._ctx ? this._ctx.state : "uninitialized"; }

  get volume() { return this._volume; }
  get muted() { return this._muted; }

  setVolume(v) {
    this._volume = clamp(Number(v) || 0, 0, 1);
    this._applyGain(true);
    return this._volume;
  }

  setMuted(m) {
    this._muted = !!m;
    this._applyGain(true);
    return this._muted;
  }

  toggleMute() { return this.setMuted(!this._muted); }

  _applyGain(persist) {
    if (this._master && this._ctx) {
      const g = this._muted ? 0 : this._volume;
      // 10ms 斜坡，避免调音量时“啪”一声
      this._master.gain.setTargetAtTime(g, this._ctx.currentTime, 0.01);
    }
    if (persist) this._saveState();
  }

  _readState() {
    try { return JSON.parse(localStorage.getItem(this.storageKey) || '{}') || {}; }
    catch { return {}; }
  }

  _saveState() {
    try {
      localStorage.setItem(this.storageKey, JSON.stringify({ volume: this._volume, muted: this._muted }));
    } catch { /* 隐私模式忽略 */ }
  }

  /* ------------------------------------------------------------- 上下文 */
  _ensureCtx() {
    if (this._ctx) return this._ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    this._ctx = new AC({ latencyHint: 'interactive' });
    this._master = this._ctx.createGain();
    this._master.gain.value = this._muted ? 0 : this._volume;
    this._master.connect(this._ctx.destination);
    return this._ctx;
  }

  /** 在用户手势里调用一次即可（播放时也会自动尝试） */
  unlock() {
    const ctx = this._ensureCtx();
    if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
    return this;
  }

  /* ------------------------------------------------------------- 资源 */
  /** 预解码若干 id（失败静默，播放时还有退化音） */
  async preload(ids) {
    const list = Array.isArray(ids) ? ids : Object.keys(DEFAULT_GAIN);
    await Promise.all(list.map((id) => this._load(id).catch(() => null)));
    return this;
  }

  async _load(id) {
    if (this._buffers.has(id)) return this._buffers.get(id);
    if (this._failed.has(id)) return null;
    if (this._pending.has(id)) return this._pending.get(id);

    const ctx = this._ensureCtx();
    if (!ctx) { this._failed.add(id); return null; }

    const url = String(this.baseUrl).replace(/\/?$/, '/') + id + '.wav';
    const p = (async () => {
      try {
        const res = await fetch(url, { cache: 'force-cache' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const buf = await res.arrayBuffer();
        const audio = await ctx.decodeAudioData(buf);
        this._buffers.set(id, audio);
        return audio;
      } catch (err) {
        this._failed.add(id);
        console.warn('[sfx] 音频加载失败，使用合成音兜底:', id, err);
        return null;
      } finally {
        this._pending.delete(id);
      }
    })();
    this._pending.set(id, p);
    return p;
  }

  /** manifest 里的默认增益（读不到就用内置表） */
  async _gains() {
    if (this._manifest) return this._manifest;
    this._manifest = Promise.resolve(DEFAULT_GAIN);
    try {
      const res = await fetch(new URL('manifest.json', String(this.baseUrl).replace(/\/?$/, '/')), { cache: 'force-cache' });
      if (res.ok) {
        const m = await res.json();
        const table = { ...DEFAULT_GAIN };
        for (const s of m.sounds || []) if (s && s.id) table[s.id] = Number(s.gain) || table[s.id] || 0.5;
        this._manifest = table;
      }
    } catch { /* 用内置表 */ }
    return this._manifest;
  }

  /* ------------------------------------------------------------- 播放 */
  /**
   * @param {string} id 音效 id（= 文件名）
   * @param {object} [o]
   * @param {number} [o.volume] 相对增益
   * @param {number} [o.pan] -1 左 .. 1 右
   * @param {number} [o.rate] 播放速率
   * @param {number} [o.delay] 秒
   * @param {number} [o.minGap] 同音最小间隔（秒），默认 0.03
   * @returns {Promise<boolean>} 是否真的发声
   */
  async play(id, o = {}) {
    const ctx = this._ensureCtx();
    if (!ctx) return false;
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    if (this._muted || this._volume <= 0) return false;

    const now = ctx.currentTime;
    const minGap = o.minGap ?? 0.03;
    const last = this._lastAt.get(id) ?? -1e9;
    if (now - last < minGap) return false;
    this._lastAt.set(id, now);

    const gains = await this._gains();
    const audio = await this._load(id);
    const gain = (Number(o.volume) || 1) * (gains[id] ?? 0.5);
    const when = ctx.currentTime + Math.max(0, Number(o.delay) || 0) + 0.005;

    if (!audio) return this._synthFallback(id, gain, o, when);

    const src = ctx.createBufferSource();
    src.buffer = audio;
    const vary = this.vary && o.rate == null ? 1 + (Math.random() * 2 - 1) * 0.03 : 1;
    src.playbackRate.value = (Number(o.rate) || 1) * vary;

    const g = ctx.createGain();
    g.gain.value = gain;

    let node = src.connect(g);
    let panNode = null;
    if (o.pan && ctx.createStereoPanner) {
      panNode = ctx.createStereoPanner();
      panNode.pan.value = clamp(o.pan, -1, 1);
      node = node.connect(panNode);
    }
    (panNode || g).connect(this._master);
    src.start(when);
    src.onended = () => { try { src.disconnect(); g.disconnect(); panNode && panNode.disconnect(); } catch {} };
    return true;
  }

  _synthFallback(id, gain, o, when) {
    const ctx = this._ctx;
    const spec = FALLBACK[FALLBACK_OF[id] || 'click'];
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = spec.type;
    osc.frequency.setValueAtTime(spec.from, when);
    osc.frequency.exponentialRampToValueAtTime(Math.max(40, spec.to), when + spec.dur);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(Math.max(0.001, spec.vol * gain * 2), when + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, when + spec.dur);
    osc.connect(g).connect(this._master);
    osc.start(when);
    osc.stop(when + spec.dur + 0.02);
    osc.onended = () => { try { osc.disconnect(); g.disconnect(); } catch {} };
    return true;
  }

  /** 一次性绑定所有 [data-sfx] 元素的点击音，省得手写 */
  bindClicks(root = document) {
    root.addEventListener('pointerdown', (e) => {
      const el = e.target.closest('[data-sfx]');
      if (el) this.play(el.dataset.sfx || 'ui_click');
    }, { passive: true });
    return this;
  }

  dispose() {
    try { window.removeEventListener('pointerdown', this._unlockBound); } catch {}
    try { this._ctx && this._ctx.close(); } catch {}
    this._ctx = null; this._master = null; this._buffers.clear();
  }
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

export const sfx = new UISfx();

if (typeof window !== 'undefined') window.VRLinkSfx = sfx;
