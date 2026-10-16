import { Effect } from "effect";
import { BuiltinFilterError } from "./Diagnostic.js";
import type { DateOptions, Filter, FilterCallContext } from "./Filter.js";
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
  if (typeof timezone === "number" || typeof timezone === "boolean") return Number(timezone);
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
  locale = "en-US",
  allocationLimit = 10_000_000,
  ruby = false,
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
  const localize = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(date);
  const thursday = new Date(Date.UTC(year, month, day));
  thursday.setUTCDate(thursday.getUTCDate() + 4 - (weekday || 7));
  const isoYear = thursday.getUTCFullYear(),
    isoWeek = Math.ceil(((thursday.getTime() - Date.UTC(isoYear, 0, 1)) / 86400000 + 1) / 7);
  const codes: Record<string, string> = {
    a: locale === "en-US" ? weekdays[weekday]!.slice(0, 3) : localize({ weekday: "short" }),
    A: locale === "en-US" ? weekdays[weekday]! : localize({ weekday: "long" }),
    b: locale === "en-US" ? months[month]!.slice(0, 3) : localize({ month: "short" }),
    B: locale === "en-US" ? months[month]! : localize({ month: "long" }),
    h: locale === "en-US" ? months[month]!.slice(0, 3) : localize({ month: "short" }),
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
    Z:
      timezoneName ||
      `${offset <= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(offset) / 60))}${pad(Math.abs(offset) % 60)}`,
    t: "\t",
    n: "\n",
    "%": "%",
    c: ruby
      ? `${weekdays[weekday]!.slice(0, 3)} ${months[month]!.slice(0, 3)} ${pad(day, 2, " ")} ${pad(hour)}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} ${year}`
      : date.toLocaleString("en-US", { timeZone: "UTC" }),
    x: ruby
      ? `${pad(month + 1)}/${pad(day)}/${String(year).slice(-2)}`
      : date.toLocaleDateString("en-US", { timeZone: "UTC" }),
    X: ruby
      ? `${pad(hour)}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
      : date.toLocaleTimeString("en-US", { timeZone: "UTC" }),
    ...(ruby
      ? {
          r: `${pad(hour % 12 || 12)}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} ${hour < 12 ? "AM" : "PM"}`,
          V: pad(isoWeek),
          G: String(isoYear),
          g: String(isoYear).slice(-2),
          R: `${pad(hour)}:${pad(date.getUTCMinutes())}`,
          T: `${pad(hour)}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`,
          F: `${year}-${pad(month + 1)}-${pad(day)}`,
          D: `${pad(month + 1)}/${pad(day)}/${String(year).slice(-2)}`,
          v: `${pad(day, 2, " ")}-${months[month]!.slice(0, 3)}-${year}`,
        }
      : {}),
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
      const requestedWidth = Number(width) || 0;
      if (requestedWidth > allocationLimit || !Number.isSafeInteger(requestedWidth))
        throw new Error("Date allocation limit exceeded");
      if (code === "N" && width) value = value.slice(0, requestedWidth).padEnd(requestedWidth, "0");
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
      if ((code === "z" || (code === "Z" && !timezoneName)) && flags.includes(":"))
        value = `${value.slice(0, 3)}:${value.slice(3)}`;
      return value.padStart(size, fill);
    },
  );
}

function run(
  name: string,
  value: Value,
  args: readonly Value[],
  context?: FilterCallContext,
): Value {
  if (context?.dialect === "ruby" && name === "date" && (args[0] == null || args[0] === ""))
    return value;
  const date = parse(
    context?.dialect === "ruby" && typeof value === "string" && /^(now|today)$/i.test(value)
      ? value.toLowerCase()
      : value,
  );
  if (!date) return value;
  const options: DateOptions = context?.date ?? {};
  const explicit = name === "date" && args.length > 1 && !context?.missingArguments[1];
  let timezone: Value | undefined = explicit
    ? context?.nilArguments?.[1]
      ? 0
      : (args[1] ?? options.timezoneOffset)
    : options.timezoneOffset;
  if (
    (options.preserveTimezones || context?.dialect === "ruby") &&
    !explicit &&
    typeof value === "string" &&
    !/^\d+$/.test(value)
  ) {
    const zone = /(?:([zZ])|([+-])(\d{2}):?(\d{2}))$/.exec(value);
    timezone = zone?.[1]
      ? 0
      : zone
        ? (zone[2] === "+" ? -1 : 1) * (Number(zone[3]) * 60 + Number(zone[4]))
        : undefined;
  }
  const offset = timezoneOffset(date, timezone);
  const display = new Date(date.getTime() - offset * 60_000);
  const timezoneName =
    typeof timezone === "string" ? timezone : timezone === undefined ? "UTC" : "";
  const fmt = (pattern: string) =>
    format(
      display,
      pattern,
      offset,
      timezoneName,
      date,
      options.locale || "en-US",
      context?.allocationLimit,
      context?.dialect === "ruby",
    );
  if (name === "date")
    return fmt(
      args[0] == null
        ? (options.dateFormat ?? "%A, %B %-e, %Y at %-l:%M %P %z")
        : stringify(args[0]),
    );
  if (name === "date_to_xmlschema") return fmt("%Y-%m-%dT%H:%M:%S%:z");
  if (name === "date_to_rfc822") return fmt("%a, %d %b %Y %H:%M:%S %z");
  const monthCode = name === "date_to_string" ? "%b" : "%B";
  const day = display.getUTCDate();
  if (args[0] === "ordinal")
    return args[1] === "US" ? fmt(`${monthCode} ${day}%q, %Y`) : fmt(`${day}%q ${monthCode} %Y`);
  return fmt(`%d ${monthCode} %Y`);
}

function allocation(
  name: string,
  value: Value,
  args: readonly Value[],
  context: FilterCallContext,
): number {
  if (!parse(value)) return typeof value === "string" ? value.length : 0;
  const pattern =
    name === "date"
      ? args[0] == null
        ? (context.date?.dateFormat ?? "%A, %B %-e, %Y at %-l:%M %P %z")
        : stringify(args[0])
      : "%Y-%m-%dT%H:%M:%S%:z";
  let size = pattern.length + (typeof value === "string" ? value.length : 0);
  for (const match of pattern.matchAll(/%([-_0^#:]+)?(\d+)?([EO])?(.)/g)) {
    const width = Number(match[2]) || 0;
    if (!match[1]?.includes("-") || match[4] === "N") size += width;
  }
  return size;
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
    allocation: (value, args, context) => allocation(name, value, args, context),
    run: (value, args, _named, context) =>
      Effect.try({
        try: () => run(name, value, args, context),
        catch: (cause) => new BuiltinFilterError({ message: String(cause) }),
      }),
  },
]);
