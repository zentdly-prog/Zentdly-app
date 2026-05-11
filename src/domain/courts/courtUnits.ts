export interface CourtUnit {
  id?: string;
  name: string;
  has_roof?: boolean;
  synthetic_grass?: boolean;
  acrylic?: boolean;
  description?: string | null;
  active?: boolean;
}

export interface CourtUnitConfig {
  quantity: number;
  court_units?: CourtUnit[] | null;
}

export function getActiveCourtUnits(config: CourtUnitConfig): CourtUnit[] {
  const units = Array.isArray(config.court_units)
    ? config.court_units.filter((unit) => unit && unit.active !== false && unit.name?.trim())
    : [];

  if (units.length > 0) {
    return units.map((unit, index) => ({
      ...unit,
      id: unit.id || `court-${index + 1}`,
      name: unit.name.trim(),
      description: unit.description?.trim() || null,
    }));
  }

  return Array.from({ length: Math.max(1, config.quantity) }, (_, index) => ({
    id: `court-${index + 1}`,
    name: `Cancha ${index + 1}`,
    active: true,
  }));
}

export function getCourtCapacity(config: CourtUnitConfig): number {
  return getActiveCourtUnits(config).length;
}

export function describeCourtUnit(unit: CourtUnit): string {
  const features: string[] = [];

  if (unit.has_roof === true) features.push("techada");
  if (unit.has_roof === false) features.push("sin techo");
  if (unit.synthetic_grass === true) features.push("sintético");
  if (unit.synthetic_grass === false) features.push("no sintético");
  if (unit.acrylic === true) features.push("acrílico");
  if (unit.acrylic === false) features.push("no acrílico");

  const detail = [features.join(", "), unit.description?.trim()].filter(Boolean).join(" · ");

  return detail ? `${unit.name} (${detail})` : unit.name;
}

export function normalizeCourtLabel(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

export function pickAvailableCourtUnit(
  config: CourtUnitConfig,
  overlappingReservations: { notes?: string | null }[],
): CourtUnit {
  const units = getActiveCourtUnits(config);
  const takenLabels = new Set(
    overlappingReservations
      .map((reservation) => normalizeCourtLabel(reservation.notes))
      .filter(Boolean),
  );

  const takenNumbers = new Set(
    overlappingReservations
      .map((reservation) => reservation.notes?.match(/cancha\s+(\d+)/i)?.[1])
      .filter(Boolean)
      .map(Number),
  );

  return (
    units.find((unit, index) => {
      const label = normalizeCourtLabel(unit.name);
      return !takenLabels.has(label) && !takenNumbers.has(index + 1);
    }) ?? units[0]
  );
}
