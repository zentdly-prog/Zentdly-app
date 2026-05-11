export function hoursUntil(date: Date, now = new Date()): number {
  return (date.getTime() - now.getTime()) / 36e5;
}

export function canChangeReservation(
  startsAt: Date,
  minHoursBeforeStart: number,
  now = new Date(),
): { ok: true } | { ok: false; reason: string } {
  const remainingHours = hoursUntil(startsAt, now);

  if (remainingHours < minHoursBeforeStart) {
    return {
      ok: false,
      reason: `Solo se puede hacer con ${minHoursBeforeStart} hora${minHoursBeforeStart === 1 ? "" : "s"} de anticipación.`,
    };
  }

  return { ok: true };
}

export function buildDepositText(policy: {
  requires_deposit?: boolean | null;
  deposit_amount?: number | null;
  deposit_percentage?: number | null;
}) {
  if (!policy.requires_deposit) return "";

  if (policy.deposit_amount != null) return `\n💳 Seña: $${policy.deposit_amount}`;
  if (policy.deposit_percentage != null) return `\n💳 Seña: ${policy.deposit_percentage}%`;
  return "\n💳 Requiere seña.";
}
