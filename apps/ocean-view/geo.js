// Spherical navigation on a mean-radius Earth, in nautical miles and degrees.
// Pure functions: no runtime imports, so the node tests can load this file.

const R = 3440.065; // Earth's mean radius in nautical miles
const rad = (deg) => (deg * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** @typedef {{ lat: number, lon: number }} LatLon */

/** Great-circle distance in nautical miles. @param {LatLon} a @param {LatLon} b */
export function distance(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial great-circle bearing from `a` to `b`, 0–360° true. @param {LatLon} a @param {LatLon} b */
export function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

/** The point a fraction `t` of the way along the great circle from `a` to `b`. */
export function interpolate(a, b, t) {
  const d = distance(a, b) / R;
  if (d < 1e-9) return { lat: a.lat, lon: a.lon };
  const s = Math.sin(d);
  const k1 = Math.sin((1 - t) * d) / s;
  const k2 = Math.sin(t * d) / s;
  const [la1, lo1, la2, lo2] = [rad(a.lat), rad(a.lon), rad(b.lat), rad(b.lon)];
  const x = k1 * Math.cos(la1) * Math.cos(lo1) + k2 * Math.cos(la2) * Math.cos(lo2);
  const y = k1 * Math.cos(la1) * Math.sin(lo1) + k2 * Math.cos(la2) * Math.sin(lo2);
  const z = k1 * Math.sin(la1) + k2 * Math.sin(la2);
  return { lat: deg(Math.atan2(z, Math.hypot(x, y))), lon: deg(Math.atan2(y, x)) };
}

/** The point `nm` nautical miles from `from` on bearing `brg`. */
export function destination(from, brg, nm) {
  const d = nm / R;
  const la1 = rad(from.lat);
  const la2 = Math.asin(Math.sin(la1) * Math.cos(d) + Math.cos(la1) * Math.sin(d) * Math.cos(rad(brg)));
  const lo2 = rad(from.lon) + Math.atan2(Math.sin(rad(brg)) * Math.sin(d) * Math.cos(la1), Math.cos(d) - Math.sin(la1) * Math.sin(la2));
  return { lat: deg(la2), lon: ((deg(lo2) + 540) % 360) - 180 };
}

/** Total length of a polyline of waypoints. @param {LatLon[]} points */
export function pathLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distance(points[i - 1], points[i]);
  return total;
}

/**
 * Where a vessel is after `travelled` miles along `points`, with the course
 * it is steering and the index of the leg it is on.
 * @param {LatLon[]} points
 */
export function along(points, travelled) {
  let left = Math.max(0, travelled);
  for (let i = 1; i < points.length; i++) {
    const leg = distance(points[i - 1], points[i]);
    if (left <= leg || i === points.length - 1) {
      const t = leg > 0 ? Math.min(1, left / leg) : 1;
      const at = interpolate(points[i - 1], points[i], t);
      // Near the end of a leg the bearing to its end point is unstable; use the leg's own.
      const course = leg - left > 0.05 ? bearing(at, points[i]) : bearing(points[i - 1], points[i]);
      return { ...at, course, leg: i - 1 };
    }
    left -= leg;
  }
  return { ...points[0], course: 0, leg: 0 };
}

/** Samples each leg along its great circle so the map draws curves, not chords. */
export function densify(points, stepNm = 120) {
  const out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const n = Math.max(1, Math.ceil(distance(points[i - 1], points[i]) / stepNm));
    for (let k = 1; k <= n; k++) out.push(interpolate(points[i - 1], points[i], k / n));
  }
  return out;
}

/** `3° 45.218' N`. */
export function formatLat(lat) {
  return dm(Math.abs(lat)) + (lat >= 0 ? " N" : " S");
}
/** `122° 24.631' W`. */
export function formatLon(lon) {
  return dm(Math.abs(lon)) + (lon >= 0 ? " E" : " W");
}
function dm(value) {
  const d = Math.floor(value);
  const m = (value - d) * 60;
  return `${d}° ${m.toFixed(3).padStart(6, "0")}'`;
}
