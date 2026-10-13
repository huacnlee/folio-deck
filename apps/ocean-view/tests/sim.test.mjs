import test from "node:test";
import assert from "node:assert/strict";
import { distance, bearing, along, formatLat } from "../geo.js";
import { nodes, plan } from "../ports.js";
import { seedFleet, advance, navigation, assignRoute, unread, report, RULES, fuelPct } from "../sim.js";

const seeded = (seed = 1) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

test("great-circle distance and bearing match known values", () => {
  // Singapore to Rotterdam as the crow flies is about 10,560 km, or 5,700 NM.
  assert.ok(Math.abs(distance(nodes.singapore, nodes.rotterdam) - 5700) < 30);
  assert.ok(Math.abs(bearing({ lat: 0, lon: 0 }, { lat: 0, lon: 10 }) - 90) < 1e-9);
  assert.equal(formatLat(3.7536), "3° 45.216' N");
});

test("routes follow sea lanes through Suez", () => {
  const route = plan("singapore", "rotterdam");
  assert.ok(route.includes("suez") && route.includes("gibraltar"));
  assert.equal(plan("singapore", "singapore"), null);
});

test("a vessel advances by speed × time and its ETA follows", () => {
  const fleet = seedFleet(0);
  const v = fleet.vessels[0];
  const before = navigation(v, fleet.time).remaining;
  advance(fleet, 10, seeded());
  const after = navigation(v, fleet.time).remaining;
  assert.ok(before - after > 10 * v.cruise * 0.8 && before - after < 10 * v.cruise * 1.2);
  const nav = navigation(v, fleet.time);
  assert.ok(Math.abs((nav.eta - fleet.time) / 3_600_000 - nav.remaining / v.speed) < 1e-6);
});

test("fuel burns and is sampled for the chart", () => {
  const fleet = seedFleet(0);
  const start = fuelPct(fleet.vessels[0]);
  advance(fleet, 24, seeded(7));
  assert.ok(fuelPct(fleet.vessels[0]) < start);
  assert.equal(fleet.history.aurora.length, 1 + 48);
});

test("rules raise alerts once and new routes are planned and bunkered", () => {
  const fleet = seedFleet(0);
  const polaris = fleet.vessels.find((v) => v.id === "polaris");
  polaris.xtd = RULES.deviationNm + 3;
  polaris.fuel = polaris.capacity * 0.15;
  advance(fleet, 0.25, () => 0.5);
  assert.ok(fleet.alerts.some((a) => a.vessel === "polaris" && a.kind === "deviation"));
  assert.ok(fleet.alerts.some((a) => a.vessel === "polaris" && a.kind === "fuel"));
  const count = fleet.alerts.length;
  advance(fleet, 0.25, () => 0.5);
  assert.equal(fleet.alerts.filter((a) => a.kind === "deviation").length, 1);
  assert.ok(fleet.alerts.length >= count);

  advance(fleet, 400, seeded(3));
  assert.equal(polaris.state, "arrived");
  const nm = assignRoute(fleet, "polaris", "colombo", "jebelali");
  assert.ok(nm > 1500 && nm < 2300);
  assert.equal(fuelPct(polaris), 100);
  fleet.alerts.forEach((a) => (a.read = true));
  assert.equal(unread(fleet), 0);
  assert.match(report(fleet), /\| MV Polaris \| On Course \|/);
});

test("along() lands exactly on the destination at the end", () => {
  const points = [nodes.colombo, nodes.dondra, nodes.oman];
  const end = along(points, 1e9);
  assert.ok(distance(end, nodes.oman) < 1e-6);
});
