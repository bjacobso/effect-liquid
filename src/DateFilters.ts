import { Effect } from "effect";
import { BuiltinFilterError } from "./Diagnostic.js";
import type { Filter } from "./Filter.js";
import { stringify, type Value } from "./Value.js";

const months = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad = (value: number | string, width = 2, fill = "0") => String(value).padStart(width, fill);

function parse(value: Value): Date | undefined {
  if (value === null) return undefined;
  let milliseconds: number;
  if (typeof value === "number") milliseconds = value * 1000;
  else if (typeof value === "string") {
    if (value === "now" || value === "today") milliseconds = Date.now();
    else if (/^\d+$/.test(value)) milliseconds = Number(value) * 1000;
    else milliseconds = Date.parse(value);
  } else milliseconds = Number.NaN;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function timezoneOffset(date: Date, timezone: Value | undefined): number {
  if (typeof timezone === "number") return timezone;
  if (typeof timezone !== "string") return 0;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const local = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
    date.getUTCMilliseconds(),
  );
  return Math.round((date.getTime() - local) / 60_000);
}

function format(
  date: Date,
  pattern: string,
  offset = 0,
  timezoneName = "UTC",
  instant = date,
): string {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const hour = date.getUTCHours();
  const weekday = date.getUTCDay();
  const dayOfYear =
    Math.floor((Date.UTC(year, month, day) - Date.UTC(year, 0, 1)) / 86_400_000) + 1;
  const week = (start: number) =>
    Math.floor(
      (dayOfYear + start - weekday - (7 - new Date(Date.UTC(year, 0, 1)).getUTCDay() + start)) / 7,
    ) + 1;
  const suffix =
    day >= 11 && day <= 13
      ? "th"
      : day % 10 === 1
        ? "st"
        : day % 10 === 2
          ? "nd"
          : day % 10 === 3
            ? "rd"
            : "th";
  const codes: Record<string, string> = {
    a: weekdays[weekday]!.slice(0, 3),
    A: weekdays[weekday]!,
    b: months[month]!.slice(0, 3),
    B: months[month]!,
    h: months[month]!.slice(0, 3),
    C: String(Math.floor(year / 100)),
    d: String(day),
    e: String(day),
    H: String(hour),
    I: String(hour % 12 || 12),
    j: String(dayOfYear),
    k: String(hour),
    l: String(hour % 12 || 12),
    L: String(date.getUTCMilliseconds()),
    m: String(month + 1),
    M: String(date.getUTCMinutes()),
    N: pad(date.getUTCMilliseconds(), 3).padEnd(9, "0"),
    p: hour < 12 ? "AM" : "PM",
    P: hour < 12 ? "am" : "pm",
    q: suffix,
    s: String(Math.floor(instant.getTime() / 1000)),
    S: String(date.getUTCSeconds()),
    u: String(weekday || 7),
    U: String(week(0)),
    w: String(weekday),
    W: String(week(1)),
    y: String(year).slice(-2),
    Y: String(year),
    z: `${offset <= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offset) / 60))}${pad(Math.abs(offset) % 60)}`,
    Z: timezoneName,
    t: "\t",
    n: "\n",
    "%": "%",
    c: date.toLocaleString("en-US", { timeZone: "UTC" }),
    x: date.toLocaleDateString("en-US", { timeZone: "UTC" }),
    X: date.toLocaleTimeString("en-US", { timeZone: "UTC" }),
  };
  return pattern.replace(
    /%([-_0^#:]+)?(\d+)?([EO])?(.)/g,
    (
      matched,
      flags: string = "",
      width: string | undefined,
      _modifier: string | undefined,
      code: string,
    ) => {
      let value = codes[code];
      if (value === undefined) return matched;
      if (code === "N" && width) value = value.slice(0, Number(width)).padEnd(Number(width), "0");
      if (flags.includes("^")) value = value.toUpperCase();
      else if (flags.includes("#"))
        value = /[a-z]/.test(value) ? value.toUpperCase() : value.toLowerCase();
      const defaultWidth: Record<string, number> = {
        d: 2,
        e: 2,
        H: 2,
        I: 2,
        j: 3,
        k: 2,
        l: 2,
        L: 3,
        m: 2,
        M: 2,
        S: 2,
        U: 2,
        W: 2,
      };
      const size = flags.includes("-") ? 0 : Number(width) || defaultWidth[code] || 0;
      const fill =
        flags.includes("_") || ("e k l".split(" ").includes(code) && !flags.includes("0"))
          ? " "
          : "0";
      if (code === "z" && flags.includes(":")) value = `${value.slice(0, 3)}:${value.slice(3)}`;
      return value.padStart(Math.min(size, 1000), fill);
    },
  );
}

function run(name: string, value: Value, args: readonly Value[]): Value {
  const date = parse(value);
  if (!date) return value;
  if (name === "date") {
    const timezone = args[1];
    const offset = timezoneOffset(date, timezone);
    const display = new Date(date.getTime() - offset * 60_000);
    return format(
      display,
      args[0] == null ? "%A, %B %-e, %Y at %-l:%M %P %z" : stringify(args[0]),
      offset,
      typeof timezone === "string" ? timezone : timezone === undefined ? "UTC" : "",
      date,
    );
  }
  if (name === "date_to_xmlschema") return format(date, "%Y-%m-%dT%H:%M:%S%:z");
  if (name === "date_to_rfc822") return format(date, "%a, %d %b %Y %H:%M:%S %z");
  const monthCode = name === "date_to_string" ? "%b" : "%B";
  const day = date.getUTCDate();
  if (args[0] === "ordinal")
    return args[1] === "US"
      ? format(date, `${monthCode} ${day}%q, %Y`)
      : format(date, `${day}%q ${monthCode} %Y`);
  return format(date, `%d ${monthCode} %Y`);
}
export const filters: readonly [string, Filter<BuiltinFilterError>][] = [
  "date",
  "date_to_xmlschema",
  "date_to_rfc822",
  "date_to_string",
  "date_to_long_string",
].map((name) => [
  name,
  {
    signature: {
      input: "any",
      output: "unknown",
      minArgs: 0,
      maxArgs: name === "date" ? 2 : name.endsWith("string") ? 2 : 0,
    },
    run: (value, args) =>
      Effect.try({
        try: () => run(name, value, args),
        catch: (cause) => new BuiltinFilterError({ message: String(cause) }),
      }),
  },
]);
