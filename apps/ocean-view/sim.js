// The fleet simulation: vessels sail their planned routes at their speed,
// burn fuel by the propeller law, drift off track and heat up, and rules turn
// those readings into alerts. Pure state in, state out — no runtime imports —
// so it runs the same in the app and in the node tests.

import { along, destination, distance, pathLength, formatLat, formatLon } from "./geo.js";
import { nodes, plan } from "./ports.js";

export const RULES = {
  /** Cross-track error, in nautical miles, past which a vessel is off course. */
  deviationNm: 4,
  /** Fuel share below which a low-fuel alert is raised, and the ship slows to economy speed. */
  fuelLowPct: 20,
  /** Engine temperature, °C, past which an overheating alert is raised. */
  engineTempC: 95,
};

/** How often, in simulated hours, fuel is sampled for the chart; and how many samples are kept. */
export const SAMPLE_HOURS = 0.5;
export const HISTORY = 144;
const MAX_STEP_HOURS = 0.25;
const MAX_ALERTS = 60;

/**
 * @typedef {{
 *   id: string, name: string, imo: string, mmsi: string,
 *   route: string[], travelled: number, cruise: number, speed: number,
 *   xtd: number, temp: number, fuel: number, capacity: number, burn: number,
 *   state: "underway" | "arrived" | "nofuel",
 * }} Vessel
 * @typedef {{ id: number, vessel: string, kind: string, title: string, level: "error" | "warning" | "info" | "success", time: number, read: boolean }} Alert
 * @typedef {{
 *   version: number, time: number, sampleClock: number, nextAlert: number,
 *   vessels: Vessel[], alerts: Alert[], history: Record<string, number[]>,
 *   flags: Record<string, Record<string, boolean>>,
 * }} Fleet
 */

/** A fleet part-way through five real voyages. @returns {Fleet} */
export function seedFleet(now = Date.now()) {
  const make = (id, name, imo, mmsi, from, to, done, cruise, fuelPct, burn) => {
    const route = plan(from, to);
    const total = pathLength(route.map((n) => nodes[n]));
    const capacity = 3200;
    return {
      id, name, imo, mmsi, route, travelled: total * done, cruise, speed: cruise,
      xtd: 0, temp: 84, fuel: capacity * fuelPct, capacity, burn, state: "underway",
    };
  };
  /** @type {Fleet} */
  const fleet = {
    version: 1, time: now, sampleClock: 0, nextAlert: 1, alerts: [], history: {}, flags: {},
    vessels: [
      make("aurora", "MV Aurora", "9384722", "563247890", "singapore", "rotterdam", 0.62, 14.2, 0.78, 12.4),
      make("horizon", "MV Horizon", "9412056", "563318442", "busan", "losangeles", 0.41, 12.8, 0.64, 10.9),
      make("serenity", "MV Serenity", "9356218", "563104775", "shanghai", "hamburg", 0.37, 11.6, 0.71, 11.2),
      make("polaris", "MV Polaris", "9298113", "563087612", "portklang", "colombo", 0.88, 13.5, 0.24, 9.8),
      make("voyager", "MV Voyager", "9437781", "563402219", "jebelali", "mombasa", 0.74, 15.1, 0.55, 13.6),
    ],
  };
  for (const v of fleet.vessels) fleet.history[v.id] = [fuelPct(v)];
  return fleet;
}

export const fuelPct = (v) => (v.fuel / v.capacity) * 100;

/** Fuel burn in tonnes per day at the vessel's current speed: the cube of speed over cruise. */
export const burnRate = (v) => (v.state === "underway" ? v.burn * (v.speed / v.cruise) ** 3 : 0);

/** Everything the screen shows about one vessel, calculated from its state. */
export function navigation(v, time) {
  const points = v.route.map((n) => nodes[n]);
  const total = pathLength(points);
  const travelled = Math.min(total, v.travelled);
  const track = along(points, travelled);
  // The vessel sits `xtd` miles to starboard (positive) or port of its track,
  // and steers back toward it, so its heading leans off the planned course.
  const position = v.xtd ? destination(track, track.course + 90, v.xtd) : track;
  const correction = Math.max(-25, Math.min(25, -v.xtd * 3));
  const heading = (track.course + correction + 360) % 360;
  const remaining = total - travelled;
  const moving = v.state === "underway" && v.speed > 0.1;
  const etaHours = moving ? remaining / v.speed : v.state === "arrived" ? 0 : Infinity;
  return {
    lat: position.lat, lon: position.lon, course: track.course, heading,
    total, travelled, remaining, progress: total ? (travelled / total) * 100 : 100,
    eta: Number.isFinite(etaHours) ? time + etaHours * 3_600_000 : null,
    from: nodes[v.route[0]].name, to: nodes[v.route[v.route.length - 1]].name,
    nextWaypoint: nodes[v.route[Math.min(v.route.length - 1, track.leg + 1)]].name,
    points, offCourse: Math.abs(v.xtd) > RULES.deviationNm,
  };
}

/** The label and tone for the vessel's status chip. */
export function status(v) {
  if (v.state === "arrived") return { label: "Arrived", tone: "blue" };
  if (v.state === "nofuel") return { label: "Out of Fuel", tone: "red" };
  if (Math.abs(v.xtd) > RULES.deviationNm) return { label: "Off Course", tone: "amber" };
  return { label: "On Course", tone: "green" };
}

/** A unit normal sample, from two uniform draws. */
function gauss(rand) {
  return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
}

/**
 * Advances the fleet by `hours` of simulated time, in steps short enough that
 * the random walks and rules behave the same at any time scale.
 * @param {Fleet} fleet
 */
export function advance(fleet, hours, rand = Math.random) {
  let left = Math.max(0, hours);
  while (left > 1e-9) {
    const dt = Math.min(MAX_STEP_HOURS, left);
    step(fleet, dt, rand);
    left -= dt;
  }
  return fleet;
}

/** @param {Fleet} fleet */
function step(fleet, dt, rand) {
  fleet.time += dt * 3_600_000;
  for (const v of fleet.vessels) {
    if (v.state !== "underway") continue;
    const lowFuel = fuelPct(v) < RULES.fuelLowPct;
    const target = v.cruise * (lowFuel ? 0.8 : 1);
    v.speed = Math.max(0, v.speed + (target - v.speed) * Math.min(1, dt * 0.8) + gauss(rand) * 0.25 * Math.sqrt(dt));
    // Wind and current push the vessel off track; the autopilot pulls it back.
    v.xtd += -v.xtd * Math.min(1, 0.12 * dt) + gauss(rand) * 0.8 * Math.sqrt(dt);
    const load = (v.speed / v.cruise) ** 2;
    v.temp += (78 + 8 * load - v.temp) * Math.min(1, 0.2 * dt) + gauss(rand) * 1.4 * Math.sqrt(dt);
    v.fuel = Math.max(0, v.fuel - (burnRate(v) * dt) / 24);
    v.travelled += v.speed * dt;

    const total = pathLength(v.route.map((n) => nodes[n]));
    if (v.travelled >= total) {
      v.travelled = total;
      v.state = "arrived";
      v.speed = 0;
      v.xtd = 0;
      raise(fleet, v, "arrived", `Arrived at ${nodes[v.route[v.route.length - 1]].name}`, "success");
    } else if (v.fuel <= 0) {
      v.state = "nofuel";
      v.speed = 0;
      raise(fleet, v, "nofuel", "Out of fuel — vessel adrift", "error");
    }
    rule(fleet, v, "deviation", Math.abs(v.xtd) > RULES.deviationNm, Math.abs(v.xtd) < RULES.deviationNm * 0.6,
      () => `Route deviation detected (${Math.abs(v.xtd).toFixed(1)} NM)`, "warning");
    rule(fleet, v, "fuel", lowFuel, fuelPct(v) > RULES.fuelLowPct + 2,
      () => `Fuel low (${fuelPct(v).toFixed(0)}%)`, "warning");
    rule(fleet, v, "temp", v.temp > RULES.engineTempC, v.temp < RULES.engineTempC - 4,
      () => `Engine temperature high (${v.temp.toFixed(0)} °C)`, "error");
  }
  fleet.sampleClock += dt;
  while (fleet.sampleClock >= SAMPLE_HOURS) {
    fleet.sampleClock -= SAMPLE_HOURS;
    for (const v of fleet.vessels) {
      const series = (fleet.history[v.id] ??= []);
      series.push(Math.round(fuelPct(v) * 100) / 100);
      if (series.length > HISTORY) series.splice(0, series.length - HISTORY);
    }
  }
}

/** Raises an alert once when `on` becomes true, and re-arms after `off`. */
function rule(fleet, v, kind, on, off, title, level) {
  const flags = (fleet.flags[v.id] ??= {});
  if (on && !flags[kind]) {
    flags[kind] = true;
    raise(fleet, v, kind, title(), level);
  } else if (off && flags[kind]) {
    flags[kind] = false;
  }
}

/** @param {Fleet} fleet @param {Alert["level"]} level */
export function raise(fleet, v, kind, title, level) {
  fleet.alerts.unshift({ id: fleet.nextAlert++, vessel: v.id, kind, title, level, time: fleet.time, read: false });
  if (fleet.alerts.length > MAX_ALERTS) fleet.alerts.length = MAX_ALERTS;
}

export const unread = (fleet) => fleet.alerts.filter((a) => !a.read).length;

/**
 * Sends a vessel on a new voyage from its current port. It bunkers to full
 * before leaving. Returns the planned distance, or null when no route exists.
 * @param {Fleet} fleet
 */
export function assignRoute(fleet, vesselId, from, to) {
  const v = fleet.vessels.find((x) => x.id === vesselId);
  const route = plan(from, to);
  if (!v || !route) return null;
  Object.assign(v, { route, travelled: 0, speed: v.cruise * 0.6, xtd: 0, temp: 80, fuel: v.capacity, state: "underway" });
  (fleet.flags[v.id] ??= {}).deviation = false;
  fleet.flags[v.id].fuel = false;
  const nm = pathLength(route.map((n) => nodes[n]));
  raise(fleet, v, "route", `New route: ${nodes[from].name} → ${nodes[to].name} (${Math.round(nm).toLocaleString("en-US")} NM)`, "info");
  return nm;
}

/** Where the vessel is now, as a port id: its destination once arrived, else its origin. */
export function currentPort(v) {
  return v.state === "arrived" ? v.route[v.route.length - 1] : v.route[0];
}

export function utc(time, withDate = true) {
  const d = new Date(time);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const hm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
  return withDate ? `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} ${hm}` : hm;
}

/** The fleet's state as a Markdown report. @param {Fleet} fleet */
export function report(fleet) {
  const lines = [
    `# OceanView fleet report`,
    ``,
    `Generated ${utc(fleet.time)} (simulated time). Unread alerts: ${unread(fleet)}.`,
    ``,
    `| Vessel | Status | Position | Speed | Course | From → To | Progress | Remaining | ETA | Fuel |`,
    `| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |`,
  ];
  for (const v of fleet.vessels) {
    const n = navigation(v, fleet.time);
    lines.push(`| ${v.name} | ${status(v).label} | ${formatLat(n.lat)}, ${formatLon(n.lon)} | ${v.speed.toFixed(1)} kn | ${Math.round(n.course)}° | ${n.from} → ${n.to} | ${n.progress.toFixed(1)}% | ${Math.round(n.remaining).toLocaleString("en-US")} NM | ${n.eta ? utc(n.eta) : "—"} | ${fuelPct(v).toFixed(0)}% (${burnRate(v).toFixed(1)} t/day) |`);
  }
  lines.push(``, `## Recent alerts`, ``);
  for (const a of fleet.alerts.slice(0, 20)) {
    const v = fleet.vessels.find((x) => x.id === a.vessel);
    lines.push(`- ${utc(a.time)} — **${v?.name ?? a.vessel}**: ${a.title}${a.read ? "" : " (unread)"}`);
  }
  return lines.join("\n") + "\n";
}

export { distance };
