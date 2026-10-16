const net = require('node:net');
const { randomUUID } = require('node:crypto');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class NativeRdp {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.events = [];
    this.pending = null;
    this.greeting = this.waitReply('root');
    socket.on('data', (data) => this.receive(data));
    socket.on('error', (error) => this.pending?.reject(error));
    socket.on('close', () => this.pending?.reject(new Error('Native Firefox RDP closed')));
  }

  waitReply(actor) {
    if (this.pending) throw new Error('Native RDP requests must be serialized');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error(`Native Firefox RDP reply timed out: ${actor}`));
      }, 5000);
      this.pending = {
        actor,
        resolve: (value) => {
          clearTimeout(timer);
          this.pending = null;
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.pending = null;
          reject(error);
        },
      };
    });
  }

  receive(data) {
    this.buffer = Buffer.concat([this.buffer, data]);
    while (this.buffer.length) {
      const colon = this.buffer.indexOf(':');
      if (colon < 0) return;
      const size = Number(this.buffer.subarray(0, colon).toString());
      if (!Number.isSafeInteger(size) || size < 0 || size > 1_000_000) {
        this.pending?.reject(new Error('Invalid native Firefox RDP packet'));
        this.close();
        return;
      }
      if (this.buffer.length < colon + 1 + size) return;
      const packet = JSON.parse(this.buffer.subarray(colon + 1, colon + 1 + size));
      this.buffer = this.buffer.subarray(colon + 1 + size);
      if (packet.type) {
        this.events.push(packet);
        if (this.events.length > 500) this.events.shift();
      } else if (this.pending?.actor === packet.from) {
        if (packet.error) this.pending.reject(new Error(`Native Firefox RDP: ${packet.error}: ${packet.message}`));
        else this.pending.resolve(packet);
      }
    }
  }

  async request(actor, type, extra = {}) {
    const reply = this.waitReply(actor);
    const json = JSON.stringify({ to: actor, type, ...extra });
    this.socket.write(`${Buffer.byteLength(json)}:${json}`);
    return reply;
  }

  async event(predicate) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const index = this.events.findIndex(predicate);
      if (index >= 0) return this.events.splice(index, 1)[0];
      await delay(25);
    }
    throw new Error('Native Firefox RDP event timed out');
  }

  async evaluateRaw(consoleActor, expression) {
    const { resultID } = await this.request(consoleActor, 'evaluateJSAsync', {
      text: expression,
    });
    const result = await this.event((packet) => packet.type === 'evaluationResult' && packet.resultID === resultID);
    if (result.hasException) {
      throw new Error(`Native Firefox evaluation failed: ${result.exceptionMessage}`);
    }
    if (result.result?.type === 'longString') {
      const grip = result.result;
      if (!Number.isSafeInteger(grip.length) || grip.length > 500_000) {
        throw new Error('Native Firefox console result exceeds fixture budget');
      }
      const { substring } = await this.request(grip.actor, 'substring', { start: 0, end: grip.length });
      if (typeof substring !== 'string' || substring.length !== grip.length) {
        throw new Error('Native Firefox console string was incomplete');
      }
      return substring;
    }
    return result.result;
  }

  async evaluate(consoleActor, expression) {
    // RDP's native console does not enable top-level await. Keep async results
    // in an ephemeral, unique slot of this actual inspected document instead.
    const key = JSON.stringify(`__bananabrowse_rdp_${randomUUID()}`);
    await this.evaluateRaw(
      consoleActor,
      `(() => {
      globalThis[${key}] = { state: "pending" };
      Promise.resolve().then(() => (${expression})).then(
        value => { globalThis[${key}] = { state: "done", json: JSON.stringify(value) }; },
        error => { globalThis[${key}] = { state: "error", error: String(error) }; }
      );
      return true;
    })()`,
    );
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const raw = await this.evaluateRaw(consoleActor, `JSON.stringify(globalThis[${key}])`);
        if (typeof raw !== 'string') throw new Error('Native Firefox async result slot missing');
        const result = JSON.parse(raw);
        if (result.state === 'error') throw new Error(`Native Firefox evaluation failed: ${result.error}`);
        if (result.state === 'done') return result.json === undefined ? undefined : JSON.parse(result.json);
        await delay(25);
      }
      throw new Error('Native Firefox async evaluation timed out');
    } finally {
      await this.evaluateRaw(consoleActor, `delete globalThis[${key}]`);
    }
  }

  close() {
    this.pending?.reject(new Error('Native Firefox RDP closed'));
    this.socket.destroy();
  }
}

async function openNativeRdp(port) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const socket = net.connect(port, '127.0.0.1');
    const connected = await new Promise((resolve) => {
      socket.once('connect', () => resolve(true));
      socket.once('error', () => resolve(false));
    });
    if (connected) {
      const rdp = new NativeRdp(socket);
      try {
        await rdp.greeting;
        return rdp;
      } catch (error) {
        rdp.close();
        throw error;
      }
    }
    socket.destroy();
    await delay(100);
  }
  throw new Error('Native Firefox debugger did not start');
}

module.exports = { openNativeRdp };
