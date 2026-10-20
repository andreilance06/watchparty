const API_URL = "https://en.wikipedia.org/w/api.php";
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;

function normalizeMoviePage(page) {
  if (!Number.isSafeInteger(page?.pageid) || typeof page.title !== "string" ||
      typeof page.fullurl !== "string") return null;

  let pageUrl;
  try { pageUrl = new URL(page.fullurl); } catch { return null; }
  if (pageUrl.protocol !== "https:" || pageUrl.hostname !== "en.wikipedia.org" ||
      !pageUrl.pathname.startsWith("/wiki/")) return null;

  let posterUrl = null;
  if (typeof page.thumbnail?.source === "string") {
    try {
      const imageUrl = new URL(page.thumbnail.source);
      if (imageUrl.protocol === "https:" &&
          ["upload.wikimedia.org", "thumb.wikimedia.org"].includes(imageUrl.hostname) &&
          imageUrl.pathname.startsWith("/wikipedia/")) posterUrl = imageUrl.href;
    } catch {}
  }

  const description = typeof page.extract === "string"
    ? page.extract.replace(/\s+/g, " ").trim().slice(0, 200)
    : "";
  return {
    pageId: page.pageid,
    title: page.title.slice(0, 100),
    description,
    pageUrl: pageUrl.href,
    posterUrl
  };
}

function createMovieSearch({ fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  const cache = new Map();
  const selections = new Map();

  async function search(query) {
    const normalized = typeof query === "string"
      ? query.replace(/\s+/g, " ").trim().slice(0, 80)
      : "";
    if (normalized.length < 2) throw new Error("Enter at least two characters to search.");

    const key = normalized.toLocaleLowerCase();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) return cached.movies;
    if (cached) cache.delete(key);

    const url = new URL(API_URL);
    url.search = new URLSearchParams({
      action: "query",
      generator: "search",
      gsrsearch: normalized,
      gsrnamespace: "0",
      gsrlimit: "8",
      prop: "pageimages|extracts|info",
      inprop: "url",
      exintro: "1",
      explaintext: "1",
      piprop: "thumbnail",
      pithumbsize: "360",
      pilicense: "any",
      format: "json",
      formatversion: "2"
    }).toString();

    let response;
    try {
      response = await fetchImpl(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "WatchParty/1.0 (https://github.com/andreilance06/watchparty)"
        },
        signal: AbortSignal.timeout(8000)
      });
    } catch {
      throw new Error("Movie search is temporarily unavailable. You can still suggest the title without a poster.");
    }
    if (!response.ok) {
      throw new Error("Movie search is temporarily unavailable. You can still suggest the title without a poster.");
    }

    let payload;
    try { payload = await response.json(); } catch {
      throw new Error("Movie search returned an invalid response. You can still suggest the title without a poster.");
    }
    if (payload?.error) {
      throw new Error("Movie search is temporarily unavailable. You can still suggest the title without a poster.");
    }

    const movies = (Array.isArray(payload?.query?.pages) ? payload.query.pages : [])
      .map(normalizeMoviePage)
      .filter(Boolean);
    cache.set(key, { expiresAt: now() + CACHE_TTL_MS, movies });
    for (const movie of movies) selections.set(movie.pageId, { movie, expiresAt: now() + CACHE_TTL_MS });
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    while (selections.size > MAX_CACHE_ENTRIES * 8) selections.delete(selections.keys().next().value);
    return movies;
  }

  function getSelection(pageId) {
    const selection = selections.get(pageId);
    if (!selection || selection.expiresAt <= now()) {
      selections.delete(pageId);
      return null;
    }
    return selection.movie;
  }

  return { search, getSelection };
}

module.exports = { createMovieSearch, normalizeMoviePage };
