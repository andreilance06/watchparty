const test = require("node:test");
const assert = require("node:assert/strict");
const { createMovieSearch, normalizeMoviePage } = require("../server/movies");
const { createApplication } = require("../server/application");
const { CPU_ENCODER } = require("../server/encoders");

const inception = {
  pageid: 23270459,
  title: "Inception",
  fullurl: "https://en.wikipedia.org/wiki/Inception",
  thumbnail: {
    source: "https://upload.wikimedia.org/wikipedia/en/poster.jpg",
    width: 220,
    height: 326
  },
  extract: "A science fiction film."
};

test("movie search uses the keyless MediaWiki API, normalizes results, and caches queries", async () => {
  let calls = 0;
  let now = 1000;
  let requestUrl;
  const service = createMovieSearch({
    now: () => now,
    fetchImpl: async (url, options) => {
      calls++;
      requestUrl = new URL(url);
      assert.match(options.headers["User-Agent"], /^WatchParty\//);
      assert.equal(options.signal.aborted, false);
      return { ok: true, json: async () => ({ query: { pages: [inception] } }) };
    }
  });

  const first = await service.search("  Inception   film ");
  assert.equal(calls, 1);
  assert.equal(requestUrl.searchParams.get("gsrsearch"), "Inception film");
  assert.equal(requestUrl.searchParams.get("generator"), "search");
  assert.equal(requestUrl.searchParams.has("api_key"), false);
  assert.deepEqual(first, [{
    pageId: 23270459,
    title: "Inception",
    description: "A science fiction film.",
    pageUrl: "https://en.wikipedia.org/wiki/Inception",
    posterUrl: "https://upload.wikimedia.org/wikipedia/en/poster.jpg"
  }]);
  assert.deepEqual(service.getSelection(23270459), first[0]);
  assert.deepEqual(await service.search("inception film"), first);
  assert.equal(calls, 1);
  now += 10 * 60 * 1000 + 1;
  await service.search("inception film");
  assert.equal(calls, 2);
});

test("movie search rejects short queries and surfaces provider failures", async () => {
  const service = createMovieSearch({ fetchImpl: async () => ({ ok: false }) });
  await assert.rejects(service.search("x"), /at least two characters/);
  await assert.rejects(service.search("Inception"), /temporarily unavailable/);
  const invalidJson = createMovieSearch({ fetchImpl: async () => ({ ok: true, json: async () => { throw new Error("bad JSON"); } }) });
  await assert.rejects(invalidJson.search("Inception"), /invalid response/);
});

test("movie results reject unsafe article URLs and ignore non-Wikimedia poster URLs", () => {
  assert.equal(normalizeMoviePage({ ...inception, fullurl: "https://evil.example/wiki/Inception" }), null);
  const result = normalizeMoviePage({
    ...inception,
    thumbnail: { source: "https://attacker.example/poster.jpg" }
  });
  assert.equal(result.posterUrl, null);
  assert.equal(result.pageUrl, inception.fullurl);
});

test("movie search route returns results and validates method and query length", async (t) => {
  const app = createApplication({
    config: { port: 0 },
    encoderPromise: Promise.resolve(CPU_ENCODER),
    movieSearch: { search: async (query) => query.length < 2 ? Promise.reject(new Error("Enter at least two characters to search.")) : [{ title: query }] }
  });
  const address = await app.listen();
  t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;

  const response = await fetch(`${base}/api/movies/search?q=Arrival`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { movies: [{ title: "Arrival" }] });
  const short = await fetch(`${base}/api/movies/search?q=x`);
  assert.equal(short.status, 400);
  assert.match((await short.json()).error, /at least two characters/);
  const wrongMethod = await fetch(`${base}/api/movies/search?q=Arrival`, { method: "POST" });
  assert.equal(wrongMethod.status, 405);
});
