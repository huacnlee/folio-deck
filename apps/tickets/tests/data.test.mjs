import { test } from "node:test";
import assert from "node:assert/strict";
import { seedTickets, slaOf, toCsv, isActive, code, relative } from "../data.js";

const now = Date.UTC(2026, 9, 15, 12);
const hour = 3_600_000;
const tickets = seedTickets(now);
const count = (fn) => tickets.filter(fn).length;

test("seed matches the reference screen", () => {
  assert.equal(tickets.length, 20);
  assert.deepEqual(["open", "pending", "resolved", "closed"].map((s) => count((t) => t.status === s)), [8, 5, 4, 3]);
  assert.equal(count((t) => t.assignee === "jl"), 6);
  assert.equal(count((t) => t.assignee === null && isActive(t)), 3);
  assert.equal(count((t) => slaOf(t, now) === "breached"), 7);
  assert.equal(count((t) => t.escalated && isActive(t)), 5);
});

test("SLA follows the due date and stops once a ticket is done", () => {
  const t = { ...tickets[0], status: "open", dueAt: now + 30 * hour };
  assert.equal(slaOf(t, now), "on_track");
  assert.equal(slaOf({ ...t, dueAt: now + 2 * hour }, now), "warning");
  assert.equal(slaOf({ ...t, dueAt: now - hour }, now), "breached");
  assert.equal(slaOf({ ...t, status: "resolved", dueAt: now - hour }, now), "on_track");
});

test("CSV quotes commas and quotes", () => {
  const csv = toCsv([{ ...tickets[0], subject: 'Say "hi", please' }], now);
  assert.match(csv.split("\n")[1], /^#-001,"Say ""hi"", please",Pine & Peak,Open,/);
});

test("formatting", () => {
  assert.equal(code(7), "#-007");
  assert.equal(relative(now + 5 * hour, now), "in 5h");
  assert.equal(relative(now - 72 * hour, now), "3d ago");
});
