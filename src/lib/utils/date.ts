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
  const end = fromZonedTime(`${date}T${closeTime}:00`, tz);

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
