import type { ResearchCadence } from "@/lib/research/policy";

type LocalDate = { year: number; month: number; day: number };

function localDate(date: Date, timeZone: string): LocalDate {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric" }).formatToParts(date);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  if (![year, month, day].every(Number.isInteger)) throw new Error("Research schedule date could not be read");
  return { year, month, day };
}

function localMidnightUtc(date: LocalDate, timeZone: string): Date {
  const target = Date.UTC(date.year, date.month - 1, date.day);
  let guess = target;
  const format = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" });
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const parts = Object.fromEntries(format.formatToParts(new Date(guess)).map((part) => [part.type, part.value]));
    const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second));
    guess += target - represented;
  }
  return new Date(guess);
}

function plusDays(date: LocalDate, days: number): LocalDate {
  const moved = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

function formatDate(date: LocalDate): string {
  return `${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

export function researchCadenceWindow(cadence: ResearchCadence, now: Date, timeZone: string) {
  const current = localDate(now, timeZone);
  let start: LocalDate;
  let end: LocalDate;
  if (cadence === "daily") {
    start = current;
    end = plusDays(start, 1);
  } else if (cadence === "weekly") {
    const weekday = new Date(Date.UTC(current.year, current.month - 1, current.day)).getUTCDay();
    const daysSinceMonday = (weekday + 6) % 7;
    start = plusDays(current, -daysSinceMonday);
    end = plusDays(start, 7);
  } else if (cadence === "monthly") {
    start = { year: current.year, month: current.month, day: 1 };
    end = current.month === 12 ? { year: current.year + 1, month: 1, day: 1 }
      : { year: current.year, month: current.month + 1, day: 1 };
  } else {
    throw new Error("Manual research cadence has no scheduled window");
  }
  return { key: `${cadence}:${formatDate(start)}`, start: localMidnightUtc(start, timeZone), end: localMidnightUtc(end, timeZone) };
}
