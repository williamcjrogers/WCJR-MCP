/**
 * Minimal 5-field POSIX-style cron parser.
 *
 * Field order: minute hour dayOfMonth month dayOfWeek
 *
 * Supported syntax per field:
 *   *           any value
 *   n           specific value
 *   a,b,c       comma-separated list
 *   a-b         range (inclusive)
 *   *​/n         step (every n)
 *   a-b/n       stepped range
 *
 * Day-of-week: 0..6 with 0 == Sunday (and 7 also accepted as Sunday).
 *
 * Anything fancier (named months, `L`, `W`, weekday/last-of-month) is
 * rejected so callers fall back to interval scheduling. Keep this small —
 * the goal is to cover "every weekday at 09:30" without dragging in a
 * 1.5MB cron-parser dep.
 */

const FIELD_LIMITS = [
  { min: 0, max: 59 }, // minute
  { min: 0, max: 23 }, // hour
  { min: 1, max: 31 }, // dayOfMonth
  { min: 1, max: 12 }, // month
  { min: 0, max: 6 }   // dayOfWeek (0=Sunday, 7 also accepted -> 0)
];

function parseField(token, fieldIndex) {
  const { min, max } = FIELD_LIMITS[fieldIndex];
  const allow = new Set();
  for (const part of String(token).split(",")) {
    const piece = part.trim();
    if (!piece) throw new Error(`empty cron sub-expression in field ${fieldIndex + 1}`);
    if (piece === "*") {
      for (let v = min; v <= max; v += 1) allow.add(v);
      continue;
    }

    const [body, stepStr] = piece.split("/");
    const step = stepStr === undefined ? 1 : Number(stepStr);
    if (!Number.isInteger(step) || step <= 0) {
      throw new Error(`invalid step in cron field ${fieldIndex + 1}: ${piece}`);
    }

    let from;
    let to;
    if (body === "*") {
      from = min;
      to = max;
    } else if (body.includes("-")) {
      const [a, b] = body.split("-").map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) {
        throw new Error(`invalid cron range in field ${fieldIndex + 1}: ${piece}`);
      }
      from = a;
      to = b;
    } else {
      const v = Number(body);
      if (!Number.isInteger(v)) {
        throw new Error(`invalid cron value in field ${fieldIndex + 1}: ${piece}`);
      }
      from = v;
      to = v;
    }

    // Normalise the dayOfWeek 7 (Sunday alias) into 0 before bound checks.
    if (fieldIndex === 4) {
      if (from === 7) from = 0;
      if (to === 7) to = 0;
    }

    if (from < min || from > max || to < min || to > max || from > to) {
      throw new Error(
        `cron value out of range for field ${fieldIndex + 1}: ${piece} (allowed ${min}..${max})`
      );
    }
    for (let v = from; v <= to; v += step) {
      allow.add(v);
    }
  }
  return allow;
}

export function parseCronExpression(expression) {
  if (typeof expression !== "string") {
    throw new Error("cron expression must be a string");
  }
  const tokens = expression.trim().split(/\s+/);
  if (tokens.length !== 5) {
    throw new Error("cron expression must have exactly 5 fields (minute hour day month dow)");
  }
  return {
    minute: parseField(tokens[0], 0),
    hour: parseField(tokens[1], 1),
    dayOfMonth: parseField(tokens[2], 2),
    month: parseField(tokens[3], 3),
    dayOfWeek: parseField(tokens[4], 4)
  };
}

const MAX_LOOKAHEAD_MINUTES = 366 * 24 * 60 * 4; // ~4 years

/**
 * Find the next Date strictly after `from` that matches the parsed cron
 * fields. Increments minute-by-minute — fast enough for our scale (one
 * lookup per scheduler tick) and trivially correct.
 *
 * Per POSIX cron semantics: when both dayOfMonth and dayOfWeek are
 * restricted (i.e. neither matches the full set), the entry matches when
 * EITHER constraint matches, not both.
 */
export function nextCronRun(parsed, from = new Date()) {
  const fullDom = FIELD_LIMITS[2].max - FIELD_LIMITS[2].min + 1;
  const fullDow = FIELD_LIMITS[4].max - FIELD_LIMITS[4].min + 1;
  const domRestricted = parsed.dayOfMonth.size < fullDom;
  const dowRestricted = parsed.dayOfWeek.size < fullDow;

  // Start at the next whole minute strictly after `from`.
  const candidate = new Date(from);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  for (let i = 0; i < MAX_LOOKAHEAD_MINUTES; i += 1) {
    const minute = candidate.getMinutes();
    const hour = candidate.getHours();
    const dom = candidate.getDate();
    const month = candidate.getMonth() + 1;
    const dow = candidate.getDay();

    const monthOk = parsed.month.has(month);
    const minuteOk = parsed.minute.has(minute);
    const hourOk = parsed.hour.has(hour);
    let dayOk;
    if (domRestricted && dowRestricted) {
      dayOk = parsed.dayOfMonth.has(dom) || parsed.dayOfWeek.has(dow);
    } else if (domRestricted) {
      dayOk = parsed.dayOfMonth.has(dom);
    } else if (dowRestricted) {
      dayOk = parsed.dayOfWeek.has(dow);
    } else {
      dayOk = true;
    }

    if (monthOk && dayOk && hourOk && minuteOk) {
      return candidate;
    }

    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return null;
}
