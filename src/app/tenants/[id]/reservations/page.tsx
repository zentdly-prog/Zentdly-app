import {
  getAiReservationStats,
  getPanelReservations,
  getTenantCourtOptions,
} from "@/lib/actions/reservationsPanel";
import { syncTenantCalendar } from "@/lib/actions/google";
import ReservationsClient, { type PanelReservation } from "./ReservationsClient";

export const dynamic = "force-dynamic";

export default async function ReservationsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tz = "America/Argentina/Buenos_Aires";
  await syncTenantCalendar(id, tz);
  const [reservations, stats, courts] = await Promise.all([
    getPanelReservations(id),
    getAiReservationStats(id, tz),
    getTenantCourtOptions(id),
  ]);

  return (
    <div>
      <div className="mb-6 grid grid-cols-2 gap-3 sm:max-w-md">
        <div className="rounded-xl border border-green-200 bg-green-50 p-4">
          <div className="text-2xl font-semibold text-green-800">{stats.created}</div>
          <div className="text-xs text-green-700 mt-0.5">Reservas hechas por la IA</div>
          <div className="text-[11px] text-green-600/70 capitalize">{stats.monthLabel}</div>
        </div>
        <div className="rounded-xl border border-red-200 bg-red-50 p-4">
          <div className="text-2xl font-semibold text-red-800">{stats.cancelled}</div>
          <div className="text-xs text-red-700 mt-0.5">Canceladas por la IA</div>
          <div className="text-[11px] text-red-600/70 capitalize">{stats.monthLabel}</div>
        </div>
      </div>

      <ReservationsClient
        tenantId={id}
        timezone={tz}
        reservations={reservations as unknown as PanelReservation[]}
        courts={courts}
      />
    </div>
  );
}
