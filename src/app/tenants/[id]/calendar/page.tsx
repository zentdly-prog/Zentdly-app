import { formatInTimeZone } from "date-fns-tz";
import { addDays, parseISO } from "date-fns";
import Link from "next/link";
import { getCourtTypes } from "@/lib/actions/courts";
import { getPanelReservations } from "@/lib/actions/reservationsPanel";
import { getActiveCourtUnits } from "@/domain/courts/courtUnits";

export const dynamic = "force-dynamic";

type Relation<T> = T | T[] | null;

function one<T>(value: Relation<T>): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export default async function CalendarPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const tz = "America/Argentina/Buenos_Aires";
  const today = formatInTimeZone(new Date(), tz, "yyyy-MM-dd");
  const selectedDate = isDateParam(query.date) ? query.date : today;
  const selectedDay = parseISO(`${selectedDate}T12:00:00`);
  const previousDate = formatInTimeZone(addDays(selectedDay, -1), tz, "yyyy-MM-dd");
  const nextDate = formatInTimeZone(addDays(selectedDay, 1), tz, "yyyy-MM-dd");
  const [courts, reservations] = await Promise.all([
    getCourtTypes(id),
    getPanelReservations(id, { date: selectedDate, timezone: tz }),
  ]);
  const selectedReservations = reservations.filter((reservation) =>
    formatInTimeZone(new Date(reservation.starts_at), tz, "yyyy-MM-dd") === selectedDate,
  );
  const title = selectedDate === today
    ? "Calendario de hoy"
    : `Calendario del ${formatInTimeZone(selectedDay, tz, "dd/MM/yyyy")}`;

  return (
    <div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
          <p className="text-sm text-gray-500">
            {formatInTimeZone(selectedDay, tz, "EEEE dd/MM/yyyy")}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/tenants/${id}/calendar?date=${previousDate}`}
            className="rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            Anterior
          </Link>
          <form action={`/tenants/${id}/calendar`} className="flex items-center gap-2">
            <input
              type="date"
              name="date"
              defaultValue={selectedDate}
              className="rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800"
            />
            <button
              type="submit"
              className="rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800"
            >
              Ver
            </button>
          </form>
          <Link
            href={`/tenants/${id}/calendar?date=${nextDate}`}
            className="rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
          >
            Siguiente
          </Link>
          {selectedDate !== today && (
            <Link
              href={`/tenants/${id}/calendar`}
              className="rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              Hoy
            </Link>
          )}
        </div>
      </div>
      <div className="space-y-4">
        {courts.map((court) => {
          const units = getActiveCourtUnits(court);
          const reservationsForCourt = selectedReservations.filter((reservation) => reservation.court_type_id === court.id);

          return (
            <section key={court.id} className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="mb-3">
                <h3 className="font-semibold text-gray-900">{court.sport_name}</h3>
                <p className="text-xs text-gray-400">
                  {court.open_time.slice(0, 5)} a {court.close_time.slice(0, 5)} · {court.slot_duration_minutes} min
                </p>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {units.map((unit) => {
                  const unitReservations = reservationsForCourt.filter((reservation) =>
                    !reservation.notes || reservation.notes === unit.name,
                  );

                  return (
                    <div key={unit.id ?? unit.name} className="rounded-lg border border-gray-100 bg-gray-50 p-3">
                      <div className="font-medium text-sm text-gray-800 mb-2">{unit.name}</div>
                      {unitReservations.length === 0 ? (
                        <div className="text-xs text-gray-400">Sin reservas este día.</div>
                      ) : (
                        <div className="space-y-2">
                          {unitReservations.map((reservation) => {
                            const customer = one(reservation.customers as Relation<{ name: string | null; phone_e164: string | null }>);
                            return (
                              <div key={reservation.id} className="rounded-md bg-green-100 px-2 py-1 text-xs text-green-800">
                                {formatInTimeZone(new Date(reservation.starts_at), tz, "HH:mm")} · {customer?.name || customer?.phone_e164 || "Cliente"}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function isDateParam(value: string | undefined): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value));
}
