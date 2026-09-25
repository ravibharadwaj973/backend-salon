import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import isoWeek from 'dayjs/plugin/isoWeek';
import duration from 'dayjs/plugin/duration';
import relativeTime from 'dayjs/plugin/relativeTime';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore';
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter';
import { env } from '../config/env';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);
dayjs.extend(isoWeek);
dayjs.extend(duration);
dayjs.extend(relativeTime);
dayjs.extend(isSameOrBefore);
dayjs.extend(isSameOrAfter);

export { dayjs };

export const DEFAULT_TZ = env.DEFAULT_TIMEZONE;

export type DateInput = Date | string | number | dayjs.Dayjs;

export function now(): Date {
  return new Date();
}

export function inTz(value: DateInput, tz: string = DEFAULT_TZ) {
  return dayjs(value).tz(tz);
}

/**
 * A DATE AND TIME SOMEBODY TYPED, READ IN THE SALON'S OWN CLOCK.
 *
 * `<input type="datetime-local">` sends "2026-09-25T11:50" with no timezone on
 * it at all, and `new Date(...)` then reads it in the SERVER's timezone. The
 * server is a container running UTC, so a salon in Kolkata scheduling a
 * campaign for 11:50 got one that went out at 17:20 — five and a half hours
 * late, with nothing anywhere reporting a fault, because 11:50 UTC is a
 * perfectly valid instant.
 *
 * The string is the one piece of data in the system that carries no timezone
 * and cannot be read without knowing whose clock it came from. That clock is
 * the salon's, never the server's — a server moved between regions must not
 * change when anybody's campaigns go out.
 *
 * A value that DOES carry an offset or a Z is already unambiguous and is
 * respected as sent, so an API client doing the right thing is not second-
 * guessed.
 */
const HAS_TIMEZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

export function parseLocalDateTime(value: string, tz: string = DEFAULT_TZ): Date {
  const trimmed = value.trim();
  if (HAS_TIMEZONE.test(trimmed)) return new Date(trimmed);
  return dayjs.tz(trimmed, tz).toDate();
}

export function startOfDay(value: DateInput, tz: string = DEFAULT_TZ): Date {
  return dayjs(value).tz(tz).startOf('day').toDate();
}

export function endOfDay(value: DateInput, tz: string = DEFAULT_TZ): Date {
  return dayjs(value).tz(tz).endOf('day').toDate();
}

export function startOfMonth(value: DateInput, tz: string = DEFAULT_TZ): Date {
  return dayjs(value).tz(tz).startOf('month').toDate();
}

export function endOfMonth(value: DateInput, tz: string = DEFAULT_TZ): Date {
  return dayjs(value).tz(tz).endOf('month').toDate();
}

export function addDays(value: DateInput, days: number): Date {
  return dayjs(value).add(days, 'day').toDate();
}

export function addMinutes(value: DateInput, minutes: number): Date {
  return dayjs(value).add(minutes, 'minute').toDate();
}

export function addMonths(value: DateInput, months: number): Date {
  return dayjs(value).add(months, 'month').toDate();
}

export function diffDays(a: DateInput, b: DateInput): number {
  return dayjs(a).diff(dayjs(b), 'day');
}

export function diffMinutes(a: DateInput, b: DateInput): number {
  return dayjs(a).diff(dayjs(b), 'minute');
}

/** "YYYY-MM-DD" in the given timezone — the key used across daily reports. */
export function dateKey(value: DateInput, tz: string = DEFAULT_TZ): string {
  return dayjs(value).tz(tz).format('YYYY-MM-DD');
}

/** A `@db.Date` column value for a calendar day, anchored at UTC midnight. */
export function dateOnly(value: DateInput, tz: string = DEFAULT_TZ): Date {
  return new Date(`${dateKey(value, tz)}T00:00:00.000Z`);
}

export function dayOfWeek(value: DateInput, tz: string = DEFAULT_TZ): number {
  return dayjs(value).tz(tz).day(); // 0 = Sunday
}

/** "10:30" -> 630 */
export function timeToMinutes(time: string): number {
  const [h = '0', m = '0'] = time.split(':');
  return Number(h) * 60 + Number(m);
}

/** 630 -> "10:30" */
export function minutesToTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Combine a calendar day with a wall-clock "HH:mm" in the branch timezone. */
export function atTime(day: DateInput, time: string, tz: string = DEFAULT_TZ): Date {
  return dayjs.tz(`${dateKey(day, tz)} ${time}`, 'YYYY-MM-DD HH:mm', tz).toDate();
}

/** Half-open interval overlap: [aStart, aEnd) ∩ [bStart, bEnd) ≠ ∅ */
export function overlaps(aStart: DateInput, aEnd: DateInput, bStart: DateInput, bEnd: DateInput): boolean {
  return dayjs(aStart).isBefore(bEnd) && dayjs(bStart).isBefore(aEnd);
}

export interface DateRange {
  from: Date;
  to: Date;
}

/**
 * Resolve a report window. Defaults to "today" in the tenant timezone; `from`
 * and `to` are inclusive calendar days.
 */
export function resolveRange(from?: string | Date, to?: string | Date, tz: string = DEFAULT_TZ): DateRange {
  const start = from ? startOfDay(from, tz) : startOfDay(new Date(), tz);
  const end = to ? endOfDay(to, tz) : endOfDay(from ?? new Date(), tz);
  return { from: start, to: end };
}

/** The equally sized window immediately before `range`, for period-on-period deltas. */
export function previousRange(range: DateRange): DateRange {
  const lengthMs = range.to.getTime() - range.from.getTime();
  return {
    from: new Date(range.from.getTime() - lengthMs - 1),
    to: new Date(range.from.getTime() - 1),
  };
}

export function eachDay(range: DateRange, tz: string = DEFAULT_TZ): string[] {
  const days: string[] = [];
  let cursor = dayjs(range.from).tz(tz).startOf('day');
  const last = dayjs(range.to).tz(tz).startOf('day');
  while (cursor.isSameOrBefore(last)) {
    days.push(cursor.format('YYYY-MM-DD'));
    cursor = cursor.add(1, 'day');
  }
  return days;
}

export function humanizeSince(value: DateInput): string {
  return dayjs(value).fromNow();
}
