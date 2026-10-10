const net = require('node:net');

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function connect(port) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const socket = net.connect(port, '127.0.0.1');
    const connected = await new Promise(resolve => {
      socket.once('connect', () => resolve(true));
      socket.once('error', () => resolve(false));
    });
    if (connected) return socket;
    socket.destroy();
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Firefox remote debugger did not start');
}

async function installTemporaryAddon(port, addonPath) {
  const socket = await connect(port);
  let buffer = Buffer.alloc(0);
  let pending;
  const evaluations = new Map();
  const greeting = new Promise((resolve, reject) => {
    pending = { actor: 'root', resolve, reject };
  });
  socket.on('data', data => {
    buffer = Buffer.concat([buffer, data]);
    while (buffer.length) {
      const colon = buffer.indexOf(':');
      if (colon < 0) return;
      const length = Number(buffer.subarray(0, colon).toString());
      if (!Number.isInteger(length) || length < 0 || length > 1_000_000) {
        pending?.reject(new Error('Invalid Firefox RDP packet'));
        socket.destroy();
        return;
      }
      if (buffer.length < colon + 1 + length) return;
      const packet = JSON.parse(buffer.subarray(colon + 1, colon + 1 + length));
      buffer = buffer.subarray(colon + 1 + length);
      if (packet.type === 'evaluationResult') {
        evaluations.set(packet.resultID, packet);
        continue;
      }
      if (packet.type) continue;
      if (pending && packet.from === pending.actor) {
        const current = pending;
        pending = null;
        if (packet.error) current.reject(new Error(`Firefox RDP: ${packet.error}: ${packet.message}`));
        else current.resolve(packet);
      }
    }
  });
  socket.on('error', error => pending?.reject(error));
  socket.on('close', () => pending?.reject(new Error('Firefox RDP connection closed')));
  const request = (actor, type, extra = {}) => new Promise((resolve, reject) => {
    pending = { actor, resolve, reject };
    const json = JSON.stringify({ to: actor, type, ...extra });
    socket.write(`${Buffer.byteLength(json)}:${json}`);
  });
  const timeout = setTimeout(() => {
    pending?.reject(new Error('Firefox temporary-addon installation timed out'));
    socket.destroy();
  }, 15_000);
  try {
    await greeting;
    console.log('[firefox RDP] greeting received');
    const root = await request('root', 'getRoot');
    console.log('[firefox RDP] root actor received');
    if (!root.addonsActor) throw new Error('Firefox did not expose the addons actor');
    const addon = await request(root.addonsActor, 'installTemporaryAddon', { addonPath });
    console.log('[firefox RDP] addon installed');
    if (!addon.addon?.id) throw new Error('Firefox did not confirm extension installation');
    const listed = await request('root', 'listAddons');
    const descriptor = listed.addons?.find(entry => entry.id === addon.addon.id);
    console.log('[firefox RDP] addon descriptor', JSON.stringify(descriptor));
    if (!descriptor || descriptor.warnings?.length) throw new Error('Firefox addon descriptor missing or has manifest warnings');
    let optionsUrl;
    if (process.env.DOMAGENT_FIREFOX_DIAGNOSTICS === '1' ||
        process.env.DOMAGENT_FIREFOX_NATIVE_OPTIONS === '1') {
      const { processDescriptor } = await request('root', 'getProcess', { id: 0 });
      const { process: processTarget } = await request(processDescriptor.actor, 'getTarget');
      if (!processTarget.consoleActor) throw new Error('Firefox parent console unavailable for diagnostics');
      const { resultID } = await request(processTarget.consoleActor, 'evaluateJSAsync', {
        text: `JSON.stringify((() => {
          const policy = WebExtensionPolicy.getByID("domagent-secure@domagent");
          const { ExtensionParent } = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
          const extension = ExtensionParent.GlobalManager.getExtension("domagent-secure@domagent");
          if (${process.env.DOMAGENT_FIREFOX_NATIVE_OPTIONS === '1'}) {
            const window = Services.wm.getMostRecentWindow("navigator:browser");
            window.gBrowser.selectedTab = window.gBrowser.addTab(extension.manifest.options_ui.page, {
              triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal()
            });
          }
          return {
            hostname: policy?.mozExtensionHostname, active: policy?.active,
            baseURL: extension?.baseURL, options: extension?.manifest?.options_ui,
            backgroundState: extension?.backgroundState,
            errors: Services.console.getMessageArray().map(entry => entry.message)
              .filter(message => /domagent|moz-extension|background|options.html/i.test(message)).slice(-20)
          };
        })())`,
      });
      const deadline = Date.now() + 5000;
      while (!evaluations.has(resultID) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const evaluation = evaluations.get(resultID);
      if (!evaluation || evaluation.hasException || typeof evaluation.result !== 'string') {
        throw new Error(`Firefox parent diagnostic failed: ${evaluation?.exceptionMessage || 'no result'}`);
      }
      console.log('[firefox parent diagnostic]', evaluation.result);
      optionsUrl = JSON.parse(evaluation.result).options.page;
      if (process.env.DOMAGENT_FIREFOX_NATIVE_OPTIONS === '1') {
        await new Promise(resolve => setTimeout(resolve, 1500));
        const next = await request(processTarget.consoleActor, 'evaluateJSAsync', {
          text: `JSON.stringify((() => {
            const window = Services.wm.getMostRecentWindow("navigator:browser");
            return {
              tabs: Array.from(window.gBrowser.tabs, tab => ({
                url: tab.linkedBrowser.currentURI?.spec,
                document: tab.linkedBrowser.browsingContext.currentWindowGlobal?.documentURI?.spec,
                remoteType: tab.linkedBrowser.remoteType
              })),
              errors: Services.console.getMessageArray().map(entry => entry.message)
                .filter(message => /domagent|moz-extension|background|options.html|juggler/i.test(message)).slice(-20)
            };
          })())`,
        });
        const nextDeadline = Date.now() + 5000;
        while (!evaluations.has(next.resultID) && Date.now() < nextDeadline) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        const native = evaluations.get(next.resultID);
        console.log('[firefox native tab/browser errors]', native?.result || native?.exceptionMessage);
      }
    }
    return { ...addon.addon, descriptor, optionsUrl };
  } finally {
    clearTimeout(timeout);
    socket.destroy();
  }
}

module.exports = { freePort, installTemporaryAddon };
