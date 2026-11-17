const test = require("node:test");
const assert = require("node:assert/strict");
const { createMovieSearch, normalizeMoviePage } = require("../server/movies");
const { createApplication } = require("../server/application");
const { CPU_ENCODER } = require("../server/encoders");

const inception = { id: 27205, title: "Inception", release_date: "2010-07-16", poster_path: "/poster.jpg", overview: "A science fiction film." };

test("movie search authenticates with TMDB, normalizes results, and caches queries", async () => {
  let calls = 0, now = 1000, requestUrl;
  const service = createMovieSearch({ apiToken: "test-token", apiKey: "", now: () => now, fetchImpl: async (url, options) => {
    calls++; requestUrl = new URL(url);
    assert.equal(options.headers.Authorization, "Bearer test-token");
    assert.equal(options.signal.aborted, false);
    return { ok: true, json: async () => ({ results: [inception] }) };
  } });
  const first = await service.search("  Inception   film ");
  assert.equal(requestUrl.origin + requestUrl.pathname, "https://api.themoviedb.org/3/search/movie");
  assert.equal(requestUrl.searchParams.get("query"), "Inception film");
  assert.equal(requestUrl.searchParams.get("include_adult"), "false");
  assert.equal(requestUrl.searchParams.has("api_key"), false);
  assert.deepEqual(first, [{ tmdbId: 27205, title: "Inception (2010)", description: inception.overview, pageUrl: "https://www.themoviedb.org/movie/27205", posterUrl: "https://image.tmdb.org/t/p/w342/poster.jpg" }]);
  assert.deepEqual(service.getSelection(27205), first[0]);
  assert.deepEqual(await service.search("inception film"), first);
  assert.equal(calls, 1);
  now += 10 * 60 * 1000 + 1;
  assert.equal(service.getSelection(27205), null);
  await service.search("inception film"); assert.equal(calls, 2);
});

test("movie search supports a v3 API key and missing credentials make no request", async () => {
  let calls = 0;
  const fetchImpl = async (url) => { calls++; assert.equal(new URL(url).searchParams.get("api_key"), "test-key"); return { ok: true, json: async () => ({ results: [] }) }; };
  const missing = createMovieSearch({ apiToken: "", apiKey: "", fetchImpl });
  await assert.rejects(missing.search("Arrival"), { status: 503 }); assert.equal(calls, 0);
  await createMovieSearch({ apiToken: "", apiKey: "test-key", fetchImpl }).search("Arrival"); assert.equal(calls, 1);
});

test("movie search rejects short queries, malformed payloads, and provider failures", async () => {
  const service = createMovieSearch({ apiToken: "test", fetchImpl: async () => ({ ok: false }) });
  await assert.rejects(service.search("x"), /at least two characters/);
  await assert.rejects(service.search("Inception"), /temporarily unavailable/);
  for (const json of [async () => { throw new Error("bad JSON"); }, async () => ({ success: false }), async () => ({ unexpected: [] })]) {
    await assert.rejects(createMovieSearch({ apiToken: "test", fetchImpl: async () => ({ ok: true, json }) }).search("Inception"), /invalid response|temporarily unavailable/);
  }
});

test("TMDB normalization rejects invalid IDs and unsafe poster paths", () => {
  assert.equal(normalizeMoviePage({ ...inception, id: -1 }), null);
  assert.equal(normalizeMoviePage({ ...inception, adult: true }), null);
  assert.equal(normalizeMoviePage({ ...inception, title: " " }), null);
  for (const poster_path of [null, "https://evil.example/image.jpg", "/../bad.jpg", "/image.svg"]) assert.equal(normalizeMoviePage({ ...inception, poster_path }).posterUrl, null);
  assert.equal(normalizeMoviePage({ ...inception, release_date: null }).title, "Inception");
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
