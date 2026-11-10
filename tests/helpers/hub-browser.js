const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventTargetDouble, ElementDouble } = require("./browser");
const root = path.resolve(__dirname, "../..");

function createHubBrowserDouble({ search = "", fetch: request } = {}) {
  const html = fs.readFileSync(path.join(root, "tests/fixtures/legacy-ui/index.html"), "utf8");
  const elements = new Map();
  const document = new EventTargetDouble(), window = new EventTargetDouble();
  document.documentElement = new ElementDouble("html");
  document.body = new ElementDouble("body"); document.body.connected = true;
  document.hidden = false;
  for (const match of html.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const element = new ElementDouble(match[1]); element.id = match[3]; element.hidden = /\bhidden\b/.test(match[2]);
    document.body.appendChild(element); elements.set(element.id, element);
  }
  document.querySelector = selector => elements.get(selector.slice(1));
  document.createElement = tag => new ElementDouble(tag);
  const timers = new Map(), storage = new Map(), requests = [];
  let nextId = 1;
  const context = vm.createContext({
    document, window, console, URL, URLSearchParams, AbortController,
    location: { protocol: "http:", host: "localhost:3000", search, href: undefined, reload() { this.reloaded = true; } },
    history: { replaceState() {} },
    crypto: require("node:crypto").webcrypto,
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    setTimeout: (fn, delay) => { const id = nextId++; timers.set(id, { fn, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, delay) => { const id = nextId++; timers.set(id, { fn, delay, interval: true }); return id; },
    clearInterval: id => timers.delete(id),
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      return request ? request(url, options) : { ok: true, json: async () => ({ rooms: [] }) };
    }
  });
  const modules = new Map();
  function getModule(filename) {
    if (!modules.has(filename)) modules.set(filename, new vm.SourceTextModule(fs.readFileSync(fs.existsSync(filename) ? filename : path.join(root, "tests/fixtures/legacy-ui", path.basename(filename)), "utf8"), { context, identifier: filename }));
    return modules.get(filename);
  }
  async function load() {
    const module = getModule(path.join(root, "js/hub.js"));
    await module.link((specifier, referring) => getModule(path.resolve(path.dirname(referring.identifier), specifier)));
    await module.evaluate();
    return module.namespace.hub;
  }
  function runTimers(delay) {
    for (const [id, timer] of [...timers]) if (timer.delay === delay) {
      if (!timer.interval) timers.delete(id);
      timer.fn();
    }
  }
  return { load, elements, document, window, context, storage, timers, requests, runTimers };
}

module.exports = { createHubBrowserDouble };
