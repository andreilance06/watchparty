const API_URL = "https://api.themoviedb.org/3/search/movie";
const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 100;

function normalizeMoviePage(movie) {
  if (!Number.isSafeInteger(movie?.id) || movie.id <= 0 || typeof movie.title !== "string" || !movie.title.trim() || movie.adult === true) return null;
  const year = typeof movie.release_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(movie.release_date) ? movie.release_date.slice(0, 4) : "";
  const title = movie.title.replace(/\s+/g, " ").trim().slice(0, year ? 93 : 100);
  return {
    tmdbId: movie.id,
    title: year ? title + " (" + year + ")" : title,
    description: typeof movie.overview === "string" ? movie.overview.replace(/\s+/g, " ").trim().slice(0, 200) : "",
    pageUrl: "https://www.themoviedb.org/movie/" + movie.id,
    posterUrl: typeof movie.poster_path === "string" && /^\/[a-zA-Z0-9_-]+\.(?:jpg|png|webp)$/.test(movie.poster_path)
      ? "https://image.tmdb.org/t/p/w342" + movie.poster_path : null
  };
}

function createMovieSearch({ fetchImpl = globalThis.fetch, now = Date.now, apiToken = process.env.TMDB_READ_ACCESS_TOKEN || "", apiKey = process.env.TMDB_API_KEY || "" } = {}) {
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

    if (!apiToken && !apiKey) throw Object.assign(new Error("Movie search is temporarily unavailable. You can still suggest the title without a poster."), { status: 503 });
    const url = new URL(API_URL);
    url.search = new URLSearchParams({ query: normalized, include_adult: "false", language: "en-US", page: "1" }).toString();
    if (!apiToken) url.searchParams.set("api_key", apiKey);

    let response;
    try {
      response = await fetchImpl(url, {
        headers: {
          Accept: "application/json",
          ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}),
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
    if (payload?.success === false || !Array.isArray(payload?.results)) {
      throw new Error("Movie search is temporarily unavailable. You can still suggest the title without a poster.");
    }

    const movies = payload.results
      .map(normalizeMoviePage)
      .filter(Boolean).slice(0, 8);
    cache.set(key, { expiresAt: now() + CACHE_TTL_MS, movies });
    for (const movie of movies) selections.set(movie.tmdbId, { movie, expiresAt: now() + CACHE_TTL_MS });
    while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    while (selections.size > MAX_CACHE_ENTRIES * 8) selections.delete(selections.keys().next().value);
    return movies;
  }

  function getSelection(tmdbId) {
    const selection = selections.get(tmdbId);
    if (!selection || selection.expiresAt <= now()) {
      selections.delete(tmdbId);
      return null;
    }
    return selection.movie;
  }

  return { search, getSelection };
}

module.exports = { createMovieSearch, normalizeMoviePage };
