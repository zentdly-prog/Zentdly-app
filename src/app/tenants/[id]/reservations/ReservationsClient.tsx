"use client";

import { useActionState, useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import {
  createManualReservation,
  rescheduleReservationFromPanel,
  updateReservationStatus,
} from "@/lib/actions/reservationsPanel";
import { Alert } from "@/components/Alert";

type Relation<T> = T | T[] | null;

function one<T>(value: Relation<T>): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export type PanelReservation = {
  id: string;
  starts_at: string;
  ends_at: string;
  status: string;
  notes: string | null;
  court_type_id: string;
  customers?: Relation<{ name: string | null; phone_e164: string | null }>;
  court_types?: Relation<{ sport_name: string | null }>;
};

type CourtOption = { id: string; sport_name: string };

const STATUS_LABEL: Record<string, string> = {
  pending: "Pendiente",
  confirmed: "Confirmada",
  cancelled: "Cancelada",
  completed: "Realizada",
};

const STATUS_TONE: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  confirmed: "bg-green-100 text-green-800",
  cancelled: "bg-red-100 text-red-800",
  completed: "bg-blue-100 text-blue-800",
};

export default function ReservationsClient({
  tenantId,
  timezone,
  reservations,
  courts,
}: {
  tenantId: string;
  timezone: string;
  reservations: PanelReservation[];
  courts: CourtOption[];
}) {
  const [createState, createAction] = useActionState(createManualReservation, null);
  const [editState, editAction] = useActionState(rescheduleReservationFromPanel, null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Unique sport names — a business can have several court types per sport.
  const sports = Array.from(new Set(courts.map((c) => c.sport_name))).filter(Boolean);
  const today = formatInTimeZone(new Date(), timezone, "yyyy-MM-dd");

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-gray-900">Reservas próximas</h2>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="px-4 py-2 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700"
        >
          {showForm ? "Cerrar" : "+ Nueva reserva"}
        </button>
      </div>

      {createState?.error && <Alert type="error" message={createState.error} />}
      {createState?.ok && <Alert type="success" message="Reserva creada." />}
      {editState?.error && <Alert type="error" message={editState.error} />}
      {editState?.ok && <Alert type="success" message="Reserva actualizada." />}

      {showForm && (
        <form action={createAction} className="mb-6 bg-white rounded-xl border border-gray-200 p-4 space-y-3">
          <input type="hidden" name="tenant_id" value={tenantId} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Cliente" name="customer_name" placeholder="Nombre y apellido" required />
            <Field label="Teléfono (opcional)" name="customer_phone" placeholder="5491122334455" />
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Cancha</label>
              <select name="sport_name" required className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900">
                {sports.length === 0 && <option value="">(sin canchas cargadas)</option>}
                {sports.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Estado</label>
              <select name="status" defaultValue="confirmed" className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900">
                <option value="confirmed">Confirmada</option>
                <option value="pending">Pendiente (esperando seña)</option>
              </select>
            </div>
            <Field label="Fecha" name="date" type="date" defaultValue={today} required />
            <Field label="Hora" name="time" type="time" required />
          </div>
          <div className="flex justify-end">
            <button className="px-4 py-2 rounded-lg bg-green-600 text-white text-sm font-medium hover:bg-green-700">
              Crear reserva
            </button>
          </div>
        </form>
      )}

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {reservations.length === 0 ? (
          <div className="p-8 text-sm text-gray-500">No hay reservas próximas.</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {reservations.map((reservation) => {
              const customer = one(reservation.customers);
              const court = one(reservation.court_types);
              const isEditing = editingId === reservation.id;
              const startDate = formatInTimeZone(new Date(reservation.starts_at), timezone, "yyyy-MM-dd");
              const startTime = formatInTimeZone(new Date(reservation.starts_at), timezone, "HH:mm");

              return (
                <div key={reservation.id} className="p-4">
                  <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                    <div>
                      <div className="font-medium text-gray-900">
                        {formatInTimeZone(new Date(reservation.starts_at), timezone, "EEE dd/MM HH:mm")} -{" "}
                        {formatInTimeZone(new Date(reservation.ends_at), timezone, "HH:mm")}
                      </div>
                      <div className="text-sm text-gray-500">
                        {court?.sport_name ?? "Cancha"}
                        {reservation.notes ? ` · ${reservation.notes}` : ""} ·{" "}
                        {customer?.name || customer?.phone_e164 || "Cliente"}
                      </div>
                      <span className={`mt-1 inline-block px-2 py-0.5 rounded-full text-xs ${STATUS_TONE[reservation.status] ?? "bg-gray-100 text-gray-600"}`}>
                        {STATUS_LABEL[reservation.status] ?? reservation.status}
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <form action={updateReservationStatus} className="flex gap-2">
                        <input type="hidden" name="tenant_id" value={tenantId} />
                        <input type="hidden" name="reservation_id" value={reservation.id} />
                        <select name="status" defaultValue={reservation.status} className="px-2 py-1.5 rounded-lg border border-gray-300 text-xs text-gray-700">
                          <option value="pending">Pendiente</option>
                          <option value="confirmed">Confirmada</option>
                          <option value="cancelled">Cancelada</option>
                          <option value="completed">Realizada</option>
                        </select>
                        <button className="px-3 py-1.5 rounded-lg bg-green-600 text-white text-xs">Guardar</button>
                      </form>
                      <button
                        onClick={() => setEditingId(isEditing ? null : reservation.id)}
                        className="px-3 py-1.5 rounded-lg border border-gray-300 text-xs text-gray-700 hover:bg-gray-50"
                      >
                        {isEditing ? "Cerrar" : "Mover"}
                      </button>
                    </div>
                  </div>

                  {isEditing && (
                    <form action={editAction} className="mt-3 rounded-lg bg-gray-50 border border-gray-200 p-3 flex flex-wrap items-end gap-3">
                      <input type="hidden" name="tenant_id" value={tenantId} />
                      <input type="hidden" name="reservation_id" value={reservation.id} />
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Fecha</label>
                        <input type="date" name="date" defaultValue={startDate} className="px-2 py-1.5 rounded-lg border border-gray-300 text-xs text-gray-900" />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Hora</label>
                        <input type="time" name="time" defaultValue={startTime} className="px-2 py-1.5 rounded-lg border border-gray-300 text-xs text-gray-900" />
                      </div>
                      <div>
                        <label className="block text-xs text-gray-500 mb-1">Cancha</label>
                        <select name="sport_name" defaultValue={court?.sport_name ?? ""} className="px-2 py-1.5 rounded-lg border border-gray-300 text-xs text-gray-900">
                          {sports.map((s) => (
                            <option key={s} value={s}>{s}</option>
                          ))}
                        </select>
                      </div>
                      <button className="px-3 py-1.5 rounded-lg bg-gray-900 text-white text-xs">Mover reserva</button>
                    </form>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function Field({
  label, name, type = "text", placeholder, defaultValue, required,
}: {
  label: string; name: string; type?: string; placeholder?: string; defaultValue?: string; required?: boolean;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input
        type={type} name={name} placeholder={placeholder} defaultValue={defaultValue} required={required}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-500"
      />
    </div>
  );
}
