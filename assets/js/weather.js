// weather.js — real weather, made unable to break the page.
//
// Three services, in a chain: Nominatim turns a typed place into coordinates
// (or coordinates back into a name), then api.weather.gov turns coordinates
// into a forecast. Only the last one carries wind, and it only covers the
// United States, so "no usable reading" is the common path for a large share
// of visitors rather than an edge case. Everything here therefore resolves to
// null instead of throwing: the caller's fallback is the default breeze, and a
// rejected promise landing in the render loop would be a worse outcome than no
// weather at all.
//
// This module has no DOM access, no imports, no module-scope work. Nothing in
// it runs until main.js calls it.

// One timeout for every outbound request. Eight seconds is long enough for a
// cold weather.gov grid lookup and short enough that a hung socket does not
// leave the status line saying "checking" forever.
const REQUEST_TIMEOUT_MS = 8000;

// Nominatim's usage policy asks for at most one request per second from a
// single source. A browser cannot set User-Agent, so the one form of politeness
// still available to us is rate limiting, and we take it seriously: every
// Nominatim call in this module goes through a single serialised chain with a
// gap between requests. Two calls fired at once become two calls 1.1 s apart.
const NOMINATIM_MIN_GAP_MS = 1100;

// Even if a caller asks for a faster poll, never hammer weather.gov harder than
// once a minute. The forecast itself only updates on the order of an hour.
const MIN_POLL_INTERVAL_MS = 60000;

// The 16-point compass, as meteorological FROM-bearings: 'N' means the wind is
// coming out of the north. This is the same convention as params.dirDeg.
const COMPASS_DEGREES = {
  N: 0,
  NNE: 22.5,
  NE: 45,
  ENE: 67.5,
  E: 90,
  ESE: 112.5,
  SE: 135,
  SSE: 157.5,
  S: 180,
  SSW: 202.5,
  SW: 225,
  WSW: 247.5,
  W: 270,
  WNW: 292.5,
  NW: 315,
  NNW: 337.5
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The single network primitive. Returns { ok, status, data } and never throws:
// an abort, a DNS failure, a CORS rejection and a body that is not JSON all
// come back the same way, as ok false.
async function fetchJson(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers,
      mode: 'cors',
      credentials: 'omit',
      cache: 'no-store'
    });
    if (!response.ok) return { ok: false, status: response.status, data: null };
    const data = await response.json();
    return { ok: true, status: response.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: null };
  } finally {
    clearTimeout(timer);
  }
}

// Serialised, rate-limited access to Nominatim. Each queued call waits for the
// previous one to settle and then for whatever remains of the minimum gap.
let nominatimChain = Promise.resolve();
let nominatimLastAt = 0;

function nominatimFetch(url) {
  const run = async () => {
    const wait = NOMINATIM_MIN_GAP_MS - (Date.now() - nominatimLastAt);
    if (wait > 0) await sleep(wait);
    nominatimLastAt = Date.now();
    // Accept is CORS-safelisted at this value, so no preflight is triggered.
    return fetchJson(url, { Accept: 'application/json' });
  };
  const call = nominatimChain.then(run, run);
  // The chain tracks completion only; a failed call must not poison the queue.
  nominatimChain = call.then(() => undefined, () => undefined);
  return call;
}

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

function validCoords(lat, lon) {
  return (
    isFiniteNumber(lat) && isFiniteNumber(lon) &&
    lat >= -90 && lat <= 90 &&
    lon >= -180 && lon <= 180
  );
}

// Nominatim's display_name is a full postal chain ("Boulder, Boulder County,
// Colorado, 80301, United States"), which is too long for a one-line status.
// When the structured address is present we compose a short label from it and
// fall back to the raw display_name otherwise. This is a presentation choice,
// not a data one; nothing downstream parses the string.
function shortPlaceLabel(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const a = entry.address;
  if (a && typeof a === 'object') {
    const locality = a.city || a.town || a.village || a.hamlet || a.suburb || a.municipality || a.county;
    const region = a.state || a.province || a.region;
    const parts = [locality, region, a.country].filter((p) => typeof p === 'string' && p.length);
    if (parts.length) return parts.slice(0, 3).join(', ');
  }
  return typeof entry.display_name === 'string' && entry.display_name.length ? entry.display_name : null;
}

/**
 * Turn a typed place into coordinates.
 * @param {string} query e.g. "Asheville, NC"
 * @returns {Promise<{lat:number, lon:number, label:string}|null>}
 */
export async function geocode(query) {
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q) return null;

  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&q=${encodeURIComponent(q)}`;
  const res = await nominatimFetch(url);
  if (!res.ok || !Array.isArray(res.data) || res.data.length === 0) return null;

  const entry = res.data[0];
  const lat = parseFloat(entry.lat);
  const lon = parseFloat(entry.lon);
  if (!validCoords(lat, lon)) return null;

  return { lat, lon, label: shortPlaceLabel(entry) || q };
}

/**
 * Turn coordinates back into something a person recognises.
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<string|null>}
 */
export async function reverseGeocode(lat, lon) {
  if (!validCoords(lat, lon)) return null;

  // zoom=10 asks for city-level detail, which is the right granularity for a
  // wind reading: the forecast grid is coarser than a street anyway.
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&zoom=10&addressdetails=1&lat=${lat}&lon=${lon}`;
  const res = await nominatimFetch(url);
  if (!res.ok || !res.data || res.data.error) return null;

  return shortPlaceLabel(res.data);
}

/**
 * Ask the browser where it is. Resolves null on denial, on an unsupported
 * browser, on an insecure context and on timeout. It never rejects, because
 * "the visitor said no" is an ordinary outcome, not a failure.
 * @param {number} [timeoutMs=8000]
 * @returns {Promise<{lat:number, lon:number}|null>}
 */
export async function browserLocation(timeoutMs = 8000) {
  const limit = isFiniteNumber(timeoutMs) && timeoutMs > 0 ? timeoutMs : 8000;

  if (typeof navigator === 'undefined' || !navigator.geolocation) return null;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(guard);
      resolve(value);
    };

    // Belt and braces: some browsers have historically ignored the options
    // timeout when a permission prompt is left sitting on screen, so we run our
    // own guard as well and simply stop waiting.
    const guard = setTimeout(() => finish(null), limit);

    try {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const lat = position && position.coords ? position.coords.latitude : NaN;
          const lon = position && position.coords ? position.coords.longitude : NaN;
          finish(validCoords(lat, lon) ? { lat, lon } : null);
        },
        () => finish(null),
        // A five-minute-old fix is plenty for a wind reading and saves the
        // visitor a GPS warm-up on mobile.
        { enableHighAccuracy: false, timeout: limit, maximumAge: 300000 }
      );
    } catch (err) {
      finish(null);
    }
  });
}

/**
 * Pull the largest number out of a forecast wind string.
 * "5 to 10 mph" -> 10, "10 mph" -> 10, "Calm" -> null.
 * The maximum is the right choice: weather.gov writes a range when the wind is
 * variable, and the top of the range is the number that actually rings a chime.
 * @param {string} text
 * @returns {number|null}
 */
export function parseWindSpeedMph(text) {
  if (typeof text !== 'string') return null;
  const matches = text.match(/(\d+(?:\.\d+)?)/g);
  if (!matches || matches.length === 0) return null;

  let best = null;
  for (const m of matches) {
    const n = parseFloat(m);
    if (!Number.isFinite(n)) continue;
    if (best === null || n > best) best = n;
  }
  return best;
}

/**
 * Compass letters to a meteorological FROM-bearing in degrees.
 * @param {string} text e.g. "WNW"
 * @returns {number|null}
 */
export function windDirectionToDegrees(text) {
  if (typeof text !== 'string') return null;
  const key = text.trim().toUpperCase();
  // Object.prototype.hasOwnProperty, not a truthiness test: north is 0 degrees,
  // and the old code's `dirMap[dir] || null` silently turned every northerly
  // wind into "no reading".
  if (!Object.prototype.hasOwnProperty.call(COMPASS_DEGREES, key)) return null;
  return COMPASS_DEGREES[key];
}

/**
 * Coordinates to a wind reading, or null.
 * Two hops: /points resolves the coordinates to a forecast office grid and
 * hands back the plain-language forecast URL, then that URL carries the wind.
 * A 404 from /points means the point is outside the National Weather Service's
 * coverage, which is to say outside the USA, and is not an error worth
 * reporting as one.
 * @param {number} lat
 * @param {number} lon
 * @returns {Promise<{speedMph:number, dirDeg:number, gustMph:number|null, place:string|null, source:string, at:number}|null>}
 */
export async function fetchWeather(lat, lon) {
  if (!validCoords(lat, lon)) return null;

  // The points endpoint rejects more than four decimal places outright, which
  // is about 11 m of precision — far finer than a 2.5 km forecast grid cell.
  const latR = Number(lat).toFixed(4);
  const lonR = Number(lon).toFixed(4);
  const headers = { Accept: 'application/geo+json' };

  const points = await fetchJson(`https://api.weather.gov/points/${latR},${lonR}`, headers);
  if (!points.ok || !points.data || !points.data.properties) return null;

  const props = points.data.properties;
  // properties.forecast is the plain twelve-hour-period forecast. The old code
  // used properties.forecastGridData + '/forecast', which happened to work but
  // asked the wrong resource for it.
  const forecastUrl = typeof props.forecast === 'string' ? props.forecast : null;
  if (!forecastUrl) return null;

  // The points response already knows the nearest named place, so in the common
  // case we get a status-line label without spending a Nominatim request on it.
  let place = null;
  const rel = props.relativeLocation && props.relativeLocation.properties;
  if (rel && typeof rel.city === 'string') {
    place = typeof rel.state === 'string' ? `${rel.city}, ${rel.state}` : rel.city;
  }

  const forecast = await fetchJson(forecastUrl, headers);
  if (!forecast.ok || !forecast.data || !forecast.data.properties) return null;

  const periods = forecast.data.properties.periods;
  if (!Array.isArray(periods) || periods.length === 0) return null;

  const now = periods[0];
  const speedMph = parseWindSpeedMph(now.windSpeed);
  const dirDeg = windDirectionToDegrees(now.windDirection);

  // Both or nothing. A speed without a bearing cannot drive a directional wind
  // field, and guessing a direction would be worse than keeping the default.
  if (speedMph === null || dirDeg === null) return null;

  // windGust is present in some office's products and absent in others.
  const gustMph = parseWindSpeedMph(now.windGust);

  return {
    speedMph,
    dirDeg,
    gustMph,
    place,
    source: 'weather.gov',
    at: Date.now()
  };
}

/**
 * Poll for fresh readings until the weather stops answering.
 * Chained setTimeout rather than setInterval, so a slow request can never stack
 * a second one behind it.
 * @param {() => {lat:number, lon:number}|null} getCoords
 * @param {(reading: object|null) => void} onReading
 * @param {number} [intervalMs=900000] fifteen minutes
 * @returns {() => void} idempotent stop function
 */
export function startPolling(getCoords, onReading, intervalMs = 900000) {
  let stopped = false;
  let timer = null;
  let failures = 0;

  const period = Math.max(
    MIN_POLL_INTERVAL_MS,
    isFiniteNumber(intervalMs) && intervalMs > 0 ? intervalMs : 900000
  );

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(tick, period);
  };

  const report = (reading) => {
    if (typeof onReading !== 'function') return;
    try {
      onReading(reading);
    } catch (err) {
      // A throwing consumer must not take the timer down with it.
    }
  };

  async function tick() {
    timer = null;
    if (stopped) return;

    let coords = null;
    try {
      coords = typeof getCoords === 'function' ? getCoords() : null;
    } catch (err) {
      coords = null;
    }

    // No coordinates yet is not a weather failure — the visitor may simply not
    // have told us where they are. Wait and look again without spending a
    // request or burning one of the three lives.
    if (!coords || !validCoords(coords.lat, coords.lon)) {
      schedule();
      return;
    }

    const reading = await fetchWeather(coords.lat, coords.lon);
    if (stopped) return;

    if (reading) {
      failures = 0;
      report(reading);
      schedule();
      return;
    }

    failures += 1;
    if (failures >= 3) {
      // Three misses in a row means this location is not covered or the service
      // is down. Tell the caller once so it can settle its status line, then go
      // quiet for good rather than retrying forever in a tab left open all day.
      stop();
      report(null);
      return;
    }
    schedule();
  }

  schedule();
  return stop;
}
