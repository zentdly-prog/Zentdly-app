"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { createCourtType, deleteCourtType } from "@/lib/actions/courts";
import { SubmitButton } from "@/components/SubmitButton";
import { Alert } from "@/components/Alert";

const SPORTS = [
  "Fútbol 5",
  "Fútbol 7",
  "Fútbol 11",
  "Pádel",
  "Tenis",
  "Básquet",
  "Volleyball",
  "Hockey",
  "Rugby",
  "Otro",
];

const DAYS = [
  { label: "Dom", value: 0 },
  { label: "Lun", value: 1 },
  { label: "Mar", value: 2 },
  { label: "Mié", value: 3 },
  { label: "Jue", value: 4 },
  { label: "Vie", value: 5 },
  { label: "Sáb", value: 6 },
];

type Court = {
  id: string;
  tenant_id: string;
  sport_name: string;
  slot_duration_minutes: number;
  open_time: string;
  close_time: string;
  quantity: number;
  price_per_slot: number | null;
  days_of_week: number[];
  active: boolean;
};

export default function CourtsClient({
  tenantId,
  initialCourts,
}: {
  tenantId: string;
  initialCourts: Court[];
}) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [createState, createAction] = useActionState(
    async (prev: unknown, fd: FormData) => {
      const res = await createCourtType(prev, fd);
      if (res?.ok) {
        setShowForm(false);
        router.refresh();
      }
      return res;
    },
    null,
  );
  const [deleteState, deleteAction] = useActionState(
    async (prev: unknown, fd: FormData) => {
      const res = await deleteCourtType(prev, fd);
      if (res?.ok) router.refresh();
      return res;
    },
    null,
  );

  const slotsPerDay = (court: Court) => {
    const [oh, om] = court.open_time.split(":").map(Number);
    const [ch, cm] = court.close_time.split(":").map(Number);
    let totalMin = (ch * 60 + cm) - (oh * 60 + om);
    if (totalMin <= 0) totalMin += 24 * 60; // overnight
    return Math.floor(totalMin / court.slot_duration_minutes) * court.quantity;
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Canchas</h2>
          <p className="text-sm text-gray-500">
            Tipos de canchas disponibles en el complejo
          </p>
        </div>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 transition-colors"
        >
          {showForm ? "Cancelar" : "+ Agregar tipo"}
        </button>
      </div>

      {showForm && (
        <form
          action={createAction}
          className="bg-white rounded-xl border border-green-200 p-6 mb-6 space-y-4"
        >
          <input type="hidden" name="tenant_id" value={tenantId} />
          <h3 className="font-medium text-gray-900">Nuevo tipo de cancha</h3>

          {createState?.error && <Alert type="error" message={createState.error} />}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Deporte <span className="text-red-500">*</span>
              </label>
              <select
                name="sport_name"
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-500"
              >
                {SPORTS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Cantidad de canchas <span className="text-red-500">*</span>
              </label>
              <input
                type="number"
                name="quantity"
                min={1}
                defaultValue={1}
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Duración por turno
              </label>
              <select
                name="slot_duration_minutes"
                defaultValue={60}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-500"
              >
                <option value={30}>30 minutos</option>
                <option value={60}>1 hora</option>
                <option value={90}>1h 30min</option>
                <option value={120}>2 horas</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Precio por turno ($)
              </label>
              <input
                type="number"
                name="price_per_slot"
                min={0}
                step={0.01}
                placeholder="Ej: 5000"
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Hora de apertura <span className="text-red-500">*</span>
              </label>
              <input
                type="time"
                name="open_time"
                defaultValue="08:00"
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Hora de cierre <span className="text-red-500">*</span>
              </label>
              <input
                type="time"
                name="close_time"
                defaultValue="23:00"
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Días disponibles
            </label>
            <div className="flex gap-2 flex-wrap">
              {DAYS.map((d) => (
                <label key={d.value} className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    name="days_of_week"
                    value={d.value}
                    defaultChecked
                    className="accent-green-600"
                  />
                  <span className="text-sm text-gray-700">{d.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="flex justify-end">
            <SubmitButton label="Guardar cancha" />
          </div>
        </form>
      )}

      {deleteState?.error && <Alert type="error" message={deleteState.error} />}

      {initialCourts.length === 0 && !showForm ? (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
          <p className="text-gray-400 text-sm">No hay tipos de canchas configurados.</p>
          <p className="text-gray-400 text-xs mt-1">
            Hacé clic en &quot;Agregar tipo&quot; para comenzar.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {initialCourts.map((court) => (
            <div
              key={court.id}
              className="bg-white rounded-xl border border-gray-200 p-5 flex items-start gap-4"
            >
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <h3 className="font-semibold text-gray-900">{court.sport_name}</h3>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full ${
                      court.active
                        ? "bg-green-100 text-green-700"
                        : "bg-gray-100 text-gray-500"
                    }`}
                  >
                    {court.active ? "Activa" : "Inactiva"}
                  </span>
                </div>

                <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-gray-600">
                  <span>
                    🏟️ <strong>{court.quantity}</strong> cancha{court.quantity !== 1 ? "s" : ""}
                  </span>
                  <span>
                    ⏱ <strong>{court.slot_duration_minutes}min</strong> por turno
                  </span>
                  <span>
                    🕐 {court.open_time} – {court.close_time}
                  </span>
                  {court.price_per_slot && (
                    <span>
                      💰 <strong>${court.price_per_slot}</strong>/turno
                    </span>
                  )}
                </div>

                <p className="text-xs text-gray-400 mt-1.5">
                  {slotsPerDay(court)} turnos disponibles por día ·{" "}
                  {court.days_of_week
                    .sort()
                    .map((d) => DAYS.find((x) => x.value === d)?.label)
                    .join(", ")}
                </p>
              </div>

              <form action={deleteAction}>
                <input type="hidden" name="id" value={court.id} />
                <input type="hidden" name="tenant_id" value={court.tenant_id} />
                <button
                  type="submit"
                  className="text-xs text-red-500 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50 transition-colors"
                >
                  Eliminar
                </button>
              </form>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
