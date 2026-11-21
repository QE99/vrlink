import crypto from "node:crypto";
import net from "node:net";

const MAX_FRAME = 1024 * 1024;

/**
 * Length-prefixed JSON frames over a TCP socket.
 * Used for the federation handshake and as the carrier for the encrypted channel.
 */
export class FrameStream {
  constructor(socket, { maxFrame = MAX_FRAME, timeoutMs = 15000 } = {}) {
    this.socket = socket;
    this.maxFrame = maxFrame;
    this.timeoutMs = timeoutMs;
    this.buffer = Buffer.alloc(0);
    this.queue = [];
    this.waiter = null;
    this.closed = false;
    this.error = null;

    socket.setNoDelay(true);
    socket.on("data", (chunk) => this.#onData(chunk));
    socket.on("error", (error) => this.#close(error));
    socket.on("close", () => this.#close(new Error("socket closed")));
    socket.on("end", () => this.#close(new Error("socket ended")));
  }

  static async connect({ host, port, timeoutMs = 10000, maxFrame = MAX_FRAME } = {}) {
    const socket = await new Promise((resolve, reject) => {
      const socket = net.connect({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`connect timeout: ${host}:${port}`));
      }, timeoutMs);
      timer.unref?.();
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    return new FrameStream(socket, { maxFrame, timeoutMs });
  }

  static fromSocket(socket, options = {}) {
    return new FrameStream(socket, options);
  }

  #onData(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length > this.maxFrame) {
        this.#close(new Error(`frame too large: ${length}`));
        return;
      }
      if (this.buffer.length < 4 + length) return;
      const payload = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      let value;
      try {
        value = JSON.parse(payload.toString("utf8"));
      } catch (error) {
        this.#close(new Error(`invalid frame json: ${error?.message ?? error}`));
        return;
      }
      if (this.waiter) {
        const waiter = this.waiter;
        this.waiter = null;
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.resolve(value);
      } else {
        this.queue.push(value);
      }
    }
  }

  send(value) {
    if (this.closed) throw this.error ?? new Error("frame stream closed");
    const payload = Buffer.from(JSON.stringify(value), "utf8");
    if (payload.length > this.maxFrame) throw new Error(`frame too large: ${payload.length}`);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    this.socket.write(Buffer.concat([header, payload]));
  }

  next({ timeoutMs = this.timeoutMs } = {}) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.closed) return Promise.reject(this.error ?? new Error("frame stream closed"));
    if (this.waiter) return Promise.reject(new Error("concurrent next() is not supported"));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      if (timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          if (this.waiter === waiter) this.waiter = null;
          reject(new Error("frame read timeout"));
        }, timeoutMs);
        waiter.timer.unref?.();
      }
      this.waiter = waiter;
    });
  }

  #close(error) {
    if (this.closed) return;
    this.closed = true;
    this.error = error;
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = null;
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
  }

  close(error = new Error("closed")) {
    this.#close(error);
  }
}

function nonceFor(counter) {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(BigInt(counter), 4);
  return nonce;
}

/**
 * AES-256-GCM channel on top of FrameStream.
 * Each direction has its own key and monotonically increasing nonce.
 */
export class SecureChannel {
  constructor(frame, sendKey, recvKey) {
    this.frame = frame;
    this.sendKey = Buffer.from(sendKey);
    this.recvKey = Buffer.from(recvKey);
    this.sendCounter = 0n;
    this.recvCounter = 0n;
    this.closed = false;
  }

  send(value) {
    if (this.closed) throw new Error("secure channel closed");
    const nonce = nonceFor(this.sendCounter);
    this.sendCounter += 1n;
    const cipher = crypto.createCipheriv("aes-256-gcm", this.sendKey, nonce);
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(value), "utf8")), cipher.final()]);
    const tag = cipher.getAuthTag();
    this.frame.send({
      n: this.sendCounter - 1n > 9007199254740991n ? String(this.sendCounter - 1n) : Number(this.sendCounter - 1n),
      d: ciphertext.toString("base64url"),
      t: tag.toString("base64url"),
    });
  }

  async next({ timeoutMs } = {}) {
    const envelope = await this.frame.next({ timeoutMs });
    const n = typeof envelope?.n === "string" ? BigInt(envelope.n) : BigInt(envelope?.n ?? -1);
    if (n !== this.recvCounter) {
      this.close();
      throw new Error(`secure channel replay/out-of-order frame: expected ${this.recvCounter}, got ${n}`);
    }
    this.recvCounter += 1n;
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.recvKey, nonceFor(n));
      decipher.setAuthTag(Buffer.from(String(envelope.t ?? ""), "base64url"));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(String(envelope.d ?? ""), "base64url")),
        decipher.final(),
      ]);
      return JSON.parse(plaintext.toString("utf8"));
    } catch (error) {
      this.close();
      throw new Error(`secure channel decrypt failed: ${error?.message ?? error}`);
    }
  }

  close() {
    this.closed = true;
    this.frame.close();
  }
}
