import test from "node:test";
import assert from "node:assert/strict";

import { nextCronRun, parseCronExpression } from "./cron.js";

test("parseCronExpression accepts star, list, range, and step syntax", () => {
  const parsed = parseCronExpression("*/15 9-17 * * 1-5");
  assert.deepEqual([...parsed.minute].sort((a, b) => a - b), [0, 15, 30, 45]);
  assert.deepEqual([...parsed.hour].sort((a, b) => a - b), [9, 10, 11, 12, 13, 14, 15, 16, 17]);
  assert.deepEqual([...parsed.dayOfWeek].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
});

test("parseCronExpression rejects out-of-range values and bad step", () => {
  assert.throws(() => parseCronExpression("60 * * * *"), /out of range/);
  assert.throws(() => parseCronExpression("*/0 * * * *"), /invalid step/);
  assert.throws(() => parseCronExpression("0 0 0 0 0"), /out of range/); // dayOfMonth/month
  assert.throws(() => parseCronExpression("not a cron"), /must have exactly 5 fields/);
});

test("nextCronRun finds the next 09:30 weekday slot", () => {
  // Sunday 14 Apr 2026, 12:00 local — next "09:30 Mon-Fri" is Monday 15th.
  const parsed = parseCronExpression("30 9 * * 1-5");
  const sunday = new Date(2026, 3, 12, 12, 0, 0); // April is month index 3
  // Apr 12 2026 is a Sunday — assert that.
  assert.equal(sunday.getDay(), 0);
  const next = nextCronRun(parsed, sunday);
  assert.ok(next instanceof Date);
  assert.equal(next.getDay(), 1, "should land on a Monday");
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 30);
});

test("nextCronRun returns the next quarter-hour for */15", () => {
  const parsed = parseCronExpression("*/15 * * * *");
  const t = new Date(2026, 3, 16, 14, 7, 30);
  const next = nextCronRun(parsed, t);
  assert.equal(next.getMinutes(), 15);
  assert.equal(next.getHours(), 14);
});

test("nextCronRun: when dom and dow both restricted, match either", () => {
  // 1st of month OR Friday — POSIX OR semantics.
  const parsed = parseCronExpression("0 12 1 * 5");
  const wed = new Date(2026, 3, 15, 13, 0, 0); // Wednesday Apr 15 — next match is Friday Apr 17 at 12:00
  const next = nextCronRun(parsed, wed);
  // Could be Friday Apr 17 at 12:00 or earlier dom match — pick whichever is sooner.
  // Apr 17 is Friday so this is the immediate next match.
  assert.equal(next.getDate(), 17);
  assert.equal(next.getHours(), 12);
  assert.equal(next.getMinutes(), 0);
});
