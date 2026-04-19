import { format, parseISO, addMinutes, isWithinInterval, areIntervalsOverlapping } from "date-fns";
import { toZonedTime, fromZonedTime, formatInTimeZone } from "date-fns-tz";

export function toUtc(localDateStr: string, localTimeStr: string, tz: string): Date {
  const localIso = `${localDateStr}T${localTimeStr}:00`;
  return fromZonedTime(localIso, tz);
}

export function toLocalTime(utcDate: Date, tz: string): Date {
  return toZonedTime(utcDate, tz);
}

export function formatLocal(utcDate: Date, tz: string, fmt = "dd/MM/yyyy HH:mm"): string {
  return formatInTimeZone(utcDate, tz, fmt);
}

export function generateSlots(
  openTime: string,
  closeTime: string,
  slotDurationMinutes: number,
  date: string,
  tz: string,
): Array<{ start: Date; end: Date }> {
  const slots: Array<{ start: Date; end: Date }> = [];
  const start = fromZonedTime(`${date}T${openTime}:00`, tz);

  // Overnight support: if close ≤ open, close is on the next calendar day
  const isOvernight = closeTime <= openTime;
  const closeDate = isOvernight
    ? new Date(new Date(`${date}T12:00:00Z`).getTime() + 86400000)
        .toISOString()
        .slice(0, 10)
    : date;
  const end = fromZonedTime(`${closeDate}T${closeTime}:00`, tz);

  let cursor = start;
  while (addMinutes(cursor, slotDurationMinutes) <= end) {
    slots.push({ start: cursor, end: addMinutes(cursor, slotDurationMinutes) });
    cursor = addMinutes(cursor, slotDurationMinutes);
  }

  return slots;
}

export function slotsOverlap(
  a: { start: Date; end: Date },
  b: { start: Date; end: Date },
): boolean {
  return areIntervalsOverlapping(
    { start: a.start, end: a.end },
    { start: b.start, end: b.end },
    { inclusive: false },
  );
}

export { parseISO, format, addMinutes, isWithinInterval };
