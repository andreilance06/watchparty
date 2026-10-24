const test = require("node:test");
const assert = require("node:assert/strict");
const { createHubBrowserDouble } = require("./helpers/hub-browser");
const flush = () => new Promise(resolve => setImmediate(resolve));
const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const publicRoom = { id: "default", name: "Default room", passwordRequired: false, participantCount: 0, fileName: null,
  thumbnailUrl: null, watchPath: "/watch", invitePath: "/?room=default" };
const protectedRoom = { ...publicRoom, id: "friday", name: "Friday films", passwordRequired: true, participantCount: 3,
  fileName: "movie.mkv", thumbnailUrl: "/api/rooms/friday/thumbnail?v=1&r=1", watchPath: "/watch?roomId=friday" };

test("hub shows room previews without opening playback, and joins open rooms with the initial name", async () => {
  const browser = createHubBrowserDouble({ fetch: async url => url === "/api/rooms" ? response({ rooms: [publicRoom, protectedRoom] }) : response({ room: publicRoom }) });
  await browser.load(); await flush();
  const el = id => browser.elements.get(id), grid = el("roomGrid");
  assert.equal(browser.elements.has("video"), false);
  assert.deepEqual(browser.requests.map(item => item.url), ["/api/rooms"]);
  assert.equal(el("roomCount").textContent, "2");
  assert.equal(grid.children.length, 2);
  const card = grid.children[1];
  assert.equal(card.children[0].children[0].src, protectedRoom.thumbnailUrl);
  assert.equal(card.children[0].children[0].hidden, false, "lazy images must be visible to start loading");
  card.children[0].children[0].dispatch("load");
  assert.equal(card.children[0].children[1].hidden, true);
  assert.equal(card.children[1].children[1].textContent, "movie.mkv");
  assert.equal(card.children[1].children[2].children[0].textContent, "3 online");
  el("initialDisplayName").value = "  Alex  ";
  grid.children[0].children[1].children[2].children[1].click();
  await flush();
  assert.equal(browser.context.location.href, "/watch");
  const join = browser.requests.find(item => item.url === "/api/rooms/join");
  assert.deepEqual(JSON.parse(join.options.body), { roomId: "default", displayName: "Alex" });
  assert.equal(browser.storage.get("watchparty-display-name"), "Alex");
});

test("password invitations preserve entered values across updates, report incorrect passwords, and enter on success", async () => {
  let passwordAccepted = false, thumbnailRevision = 1;
  const browser = createHubBrowserDouble({ search: "?room=friday", fetch: async (url, options) => {
    if (url === "/api/rooms" && !options.method) return response({ rooms: [{ ...protectedRoom, thumbnailUrl: `/preview?r=${thumbnailRevision}` }] });
    if (url.endsWith("/api/session")) return response({ error: "Join first." }, 401);
    if (url === "/api/rooms/join") return passwordAccepted ? response({ room: protectedRoom }) : response({ error: "Incorrect room password." }, 401);
    return response({ ready: true });
  } });
  const hub = await browser.load(); await flush();
  const el = id => browser.elements.get(id);
  assert.equal(el("joinRoomDialog").open, true);
  assert.equal(el("joinRoomTitle").textContent, "Join Friday films");
  el("joinRoomPassword").value = "secret";
  el("initialDisplayName").value = "Sam";
  const originalCard = el("roomGrid").children[0];
  thumbnailRevision++;
  await hub.refresh();
  assert.equal(el("joinRoomPassword").value, "secret");
  assert.equal(el("roomGrid").children[0], originalCard);
  assert.equal(originalCard.children[0].children[0].src, "/preview?r=2");
  el("joinRoomForm").dispatch("submit"); await flush();
  assert.equal(el("joinRoomStatus").textContent, "Incorrect room password.");
  assert.equal(el("submitJoinRoom").disabled, false);
  assert.equal(browser.context.location.href, undefined);
  passwordAccepted = true;
  el("joinRoomForm").dispatch("submit"); await flush();
  assert.equal(browser.context.location.href, "/watch?roomId=friday");
  assert.deepEqual(JSON.parse(browser.requests.findLast(item => item.url === "/api/rooms/join").options.body), { roomId: "friday", password: "secret", displayName: "Sam" });
});

test("hub creates password-optional rooms directly and respects native dialog cancellation", async () => {
  const browser = createHubBrowserDouble({ fetch: async (url, options) => url === "/api/rooms" && !options.method ? response({ rooms: [] }) : response({ room: protectedRoom }) });
  await browser.load(); await flush();
  const el = id => browser.elements.get(id);
  assert.match(el("hubStatus").textContent, /No rooms/);
  el("createRoomButton").click();
  assert.equal(el("createRoomDialog").open, true);
  el("createRoomName").value = "Friday films";
  el("createRoomForm").dispatch("submit"); await flush();
  const create = browser.requests.find(item => item.url === "/api/rooms" && item.options.method);
  const body = JSON.parse(create.options.body);
  assert.equal(body.name, "Friday films");
  assert.match(body.displayName, /^Guest-/);
  assert.equal("password" in body, false);
  assert.equal("accessCode" in body, false);
  assert.equal(browser.context.location.href, "/watch?roomId=friday");
  el("cancelCreateRoom").click();
  assert.equal(el("createRoomDialog").open, false);
});

test("existing protected-room members resume without a password prompt", async () => {
  const browser = createHubBrowserDouble({ search: "?room=friday", fetch: async url => response(url === "/api/rooms" ? { rooms: [protectedRoom] } : {}) });
  await browser.load(); await flush();
  assert.equal(browser.context.location.href, "/watch?roomId=friday");
  assert.equal(browser.elements.get("joinRoomDialog").open, undefined);
  assert.equal(browser.requests.some(item => item.options.method === "POST"), false);
});

test("directory polling pauses when hidden, coalesces requests, and preserves cards on errors", async () => {
  let nextRequest, failure = false;
  const browser = createHubBrowserDouble({ fetch: async () => {
    if (failure) throw new Error("Offline");
    if (nextRequest) return nextRequest;
    return response({ rooms: [publicRoom] });
  } });
  const hub = await browser.load(); await flush();
  browser.document.hidden = true; browser.runTimers(5000); await flush();
  assert.equal(browser.requests.length, 1);
  browser.document.hidden = false;
  let release;
  nextRequest = new Promise(resolve => { release = resolve; });
  browser.runTimers(5000); browser.runTimers(5000);
  assert.equal(browser.requests.length, 2);
  release(response({ rooms: [publicRoom] })); await flush(); nextRequest = null;
  failure = true; await hub.refresh();
  assert.equal(browser.elements.get("retryRooms").hidden, false);
  assert.equal(browser.elements.get("roomGrid").children.length, 1);
  failure = false; browser.elements.get("retryRooms").click(); await flush();
  assert.equal(browser.elements.get("retryRooms").hidden, true);
  browser.window.dispatch("pagehide");
  assert.equal(browser.timers.size, 0);
});

test("missing invitations and expired selected rooms show feedback without clearing the password", async () => {
  let listed = [protectedRoom];
  const browser = createHubBrowserDouble({ search: "?room=friday", fetch: async url => url === "/api/rooms" ? response({ rooms: listed }) : response({}, 401) });
  const hub = await browser.load(); await flush();
  browser.elements.get("joinRoomPassword").value = "draft";
  listed = []; await hub.refresh();
  assert.equal(browser.elements.get("joinRoomPassword").value, "draft");
  assert.equal(browser.elements.get("submitJoinRoom").disabled, true);
  assert.match(browser.elements.get("joinRoomStatus").textContent, /no longer available/);
  assert.equal(browser.elements.get("roomGrid").children.length, 0);
  const missing = createHubBrowserDouble({ search: "?room=missing" });
  await missing.load(); await flush();
  assert.match(missing.elements.get("hubNotice").textContent, /no longer available/);
});
