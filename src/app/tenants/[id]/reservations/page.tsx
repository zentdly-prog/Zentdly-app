import { formatInTimeZone } from "date-fns-tz";
import { getPanelReservations, updateReservationStatus } from "@/lib/actions/reservationsPanel";

export const dynamic = "force-dynamic";

type Relation<T> = T | T[] | null;

function one<T>(value: Relation<T>): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export default async function ReservationsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const reservations = await getPanelReservations(id);
  const tz = "America/Argentina/Buenos_Aires";

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 mb-4">Reservas próximas</h2>
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {reservations.length === 0 ? (
          <div className="p-8 text-sm text-gray-500">No hay reservas próximas.</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {reservations.map((reservation) => {
              const customer = one(reservation.customers as Relation<{ name: string | null; phone_e164: string | null }>);
              const court = one(reservation.court_types as Relation<{ sport_name: string | null }>);
              return (
                <div key={reservation.id} className="p-4 flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                  <div>
                    <div className="font-medium text-gray-900">
                      {formatInTimeZone(new Date(reservation.starts_at), tz, "EEE dd/MM HH:mm")} - {formatInTimeZone(new Date(reservation.ends_at), tz, "HH:mm")}
                    </div>
                    <div className="text-sm text-gray-500">
                      {court?.sport_name ?? "Cancha"}{reservation.notes ? ` · ${reservation.notes}` : ""} · {customer?.name || customer?.phone_e164 || "Cliente"}
                    </div>
                    <div className="text-xs text-gray-400">{reservation.status}</div>
                  </div>
                  <form action={updateReservationStatus} className="flex gap-2">
                    <input type="hidden" name="tenant_id" value={id} />
                    <input type="hidden" name="reservation_id" value={reservation.id} />
                    <select name="status" defaultValue={reservation.status} className="px-2 py-1.5 rounded-lg border border-gray-300 text-xs text-gray-700">
                      <option value="pending">Pendiente</option>
                      <option value="confirmed">Confirmada</option>
                      <option value="cancelled">Cancelada</option>
                      <option value="completed">Completada</option>
                    </select>
                    <button className="px-3 py-1.5 rounded-lg bg-green-600 text-white text-xs">Guardar</button>
                  </form>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
