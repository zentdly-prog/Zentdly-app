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

export function buildDepositText(
  policy: {
    requires_deposit?: boolean | null;
    deposit_amount?: number | null;
    deposit_percentage?: number | null;
  },
  courtPrice?: number | null,
) {
  if (!policy.requires_deposit) return "";

  const amount = computeDepositAmount(policy, courtPrice);
  if (amount != null) {
    if (policy.deposit_percentage != null && policy.deposit_amount == null) {
      return `\n💳 Seña: ${formatMoney(amount)} (${policy.deposit_percentage}% del turno)`;
    }
    return `\n💳 Seña: ${formatMoney(amount)}`;
  }
  if (policy.deposit_percentage != null) return `\n💳 Seña: ${policy.deposit_percentage}% del turno`;
  return "\n💳 Requiere seña.";
}

export function computeDepositAmount(
  policy: { deposit_amount?: number | null; deposit_percentage?: number | null },
  courtPrice?: number | null,
): number | null {
  if (policy.deposit_amount != null) return policy.deposit_amount;
  if (policy.deposit_percentage != null && courtPrice != null && courtPrice > 0) {
    return Math.round((courtPrice * policy.deposit_percentage) / 100);
  }
  return null;
}

export function formatMoney(amount: number): string {
  // Argentinian style: $20.000, $4.500
  return `$${amount.toLocaleString("es-AR", { maximumFractionDigits: 0 })}`;
}
