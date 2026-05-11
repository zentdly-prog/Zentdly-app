"use client";

import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { createCourtType, deleteCourtType, updateCourtType } from "@/lib/actions/courts";
import { SubmitButton } from "@/components/SubmitButton";
import { Alert } from "@/components/Alert";
import type { CourtUnit } from "@/domain/courts/courtUnits";
import { describeCourtUnit, getActiveCourtUnits, getCourtCapacity } from "@/domain/courts/courtUnits";

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
  description: string | null;
  slot_duration_minutes: number;
  open_time: string;
  close_time: string;
  quantity: number;
  price_per_slot: number | null;
  days_of_week: number[];
  court_units?: CourtUnit[] | null;
  active: boolean;
};

type EditableCourtUnit = Required<Pick<CourtUnit, "id" | "name" | "active">> &
  Pick<CourtUnit, "has_roof" | "synthetic_grass" | "acrylic" | "description">;

function isFootball(sport: string) {
  return sport.toLowerCase().includes("fútbol") || sport.toLowerCase().includes("futbol");
}

function isPadel(sport: string) {
  return sport.toLowerCase().includes("pádel") || sport.toLowerCase().includes("padel");
}

function defaultCourtUnit(index: number): EditableCourtUnit {
  return {
    id: `court-${index + 1}`,
    name: `Cancha ${index + 1}`,
    has_roof: false,
    synthetic_grass: false,
    acrylic: false,
    description: "",
    active: true,
  };
}

function editableUnitsFromCourt(court: Court): EditableCourtUnit[] {
  return getActiveCourtUnits(court).map((unit, index) => ({
    id: unit.id || `court-${index + 1}`,
    name: unit.name,
    has_roof: unit.has_roof ?? false,
    synthetic_grass: unit.synthetic_grass ?? false,
    acrylic: unit.acrylic ?? false,
    description: unit.description ?? "",
    active: unit.active !== false,
  }));
}

function timeValue(value: string) {
  return value.slice(0, 5);
}

export default function CourtsClient({
  tenantId,
  initialCourts,
}: {
  tenantId: string;
  initialCourts: Court[];
}) {
  const router = useRouter();
  const [showForm, setShowForm] = useState(false);
  const [editingCourt, setEditingCourt] = useState<Court | null>(null);
  const [sportName, setSportName] = useState(SPORTS[0]);
  const [quantity, setQuantity] = useState(1);
  const [courtUnits, setCourtUnits] = useState<EditableCourtUnit[]>([defaultCourtUnit(0)]);

  const closeForm = () => {
    setShowForm(false);
    setEditingCourt(null);
    setSportName(SPORTS[0]);
    setQuantity(1);
    setCourtUnits([defaultCourtUnit(0)]);
  };

  const [createState, createAction] = useActionState(
    async (prev: unknown, fd: FormData) => {
      const res = await createCourtType(prev, fd);
      if (res?.ok) {
        closeForm();
        router.refresh();
      }
      return res;
    },
    null,
  );
  const [updateState, updateAction] = useActionState(
    async (prev: unknown, fd: FormData) => {
      const res = await updateCourtType(prev, fd);
      if (res?.ok) {
        closeForm();
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
    return Math.floor(totalMin / court.slot_duration_minutes) * getCourtCapacity(court);
  };

  const updateQuantity = (nextQuantity: number) => {
    const safeQuantity = Math.max(1, nextQuantity);
    setQuantity(safeQuantity);
    setCourtUnits((current) =>
      Array.from({ length: safeQuantity }, (_, index) => current[index] ?? defaultCourtUnit(index)),
    );
  };

  const updateCourtUnit = (
    index: number,
    patch: Partial<EditableCourtUnit>,
  ) => {
    setCourtUnits((current) =>
      current.map((unit, unitIndex) => (unitIndex === index ? { ...unit, ...patch } : unit)),
    );
  };

  const openCreateForm = () => {
    if (showForm && !editingCourt) {
      closeForm();
      return;
    }

    setEditingCourt(null);
    setSportName(SPORTS[0]);
    setQuantity(1);
    setCourtUnits([defaultCourtUnit(0)]);
    setShowForm(true);
  };

  const openEditForm = (court: Court) => {
    const units = editableUnitsFromCourt(court);
    setEditingCourt(court);
    setSportName(court.sport_name);
    setQuantity(getCourtCapacity(court));
    setCourtUnits(units.length ? units : [defaultCourtUnit(0)]);
    setShowForm(true);
  };

  const formState = editingCourt ? updateState : createState;

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
          onClick={showForm ? closeForm : openCreateForm}
          className="px-4 py-2 bg-green-600 text-white text-sm font-medium rounded-lg hover:bg-green-700 transition-colors"
        >
          {showForm ? "Cancelar" : "+ Agregar canchas"}
        </button>
      </div>

      {showForm && (
        <form
          key={editingCourt?.id ?? "new-court"}
          action={editingCourt ? updateAction : createAction}
          className="bg-white rounded-xl border border-green-200 p-6 mb-6 space-y-4"
        >
          <input type="hidden" name="tenant_id" value={tenantId} />
          {editingCourt && <input type="hidden" name="id" value={editingCourt.id} />}
          <input type="hidden" name="court_units" value={JSON.stringify(courtUnits)} />
          <h3 className="font-medium text-gray-900">
            {editingCourt ? "Editar configuración de canchas" : "Nueva configuración de canchas"}
          </h3>

          {formState?.error && <Alert type="error" message={formState.error} />}
          {formState?.warning && <Alert type="success" message={formState.warning} />}

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Deporte <span className="text-red-500">*</span>
              </label>
              <select
                name="sport_name"
                required
                value={sportName}
                onChange={(event) => setSportName(event.target.value)}
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
                value={quantity}
                onChange={(event) => updateQuantity(Number(event.target.value))}
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
                defaultValue={editingCourt?.slot_duration_minutes ?? 60}
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
                defaultValue={editingCourt?.price_per_slot ?? ""}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>

            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Descripción general
              </label>
              <textarea
                name="description"
                rows={2}
                placeholder="Ej: canchas al aire libre, iluminación LED, ideal para partidos nocturnos"
                defaultValue={editingCourt?.description ?? ""}
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
                defaultValue={editingCourt ? timeValue(editingCourt.open_time) : "08:00"}
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
                defaultValue={editingCourt ? timeValue(editingCourt.close_time) : "23:00"}
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-gray-700">
                Canchas físicas
              </label>
              <span className="text-xs text-gray-400">
                Cada cancha cuenta como una unidad reservable
              </span>
            </div>

            <div className="space-y-3">
              {courtUnits.map((unit, index) => (
                <div
                  key={unit.id}
                  className="rounded-lg border border-gray-200 bg-gray-50 p-4"
                >
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">
                        Nombre de la cancha
                      </label>
                      <input
                        type="text"
                        value={unit.name}
                        onChange={(event) => updateCourtUnit(index, { name: event.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-500"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-gray-600 mb-1">
                        Características
                      </label>
                      <div className="flex flex-wrap gap-3 min-h-10 items-center">
                        <label className="flex items-center gap-1.5 text-sm text-gray-700">
                          <input
                            type="checkbox"
                            checked={!!unit.has_roof}
                            onChange={(event) => updateCourtUnit(index, { has_roof: event.target.checked })}
                            className="accent-green-600"
                          />
                          Techo
                        </label>

                        {isFootball(sportName) && (
                          <label className="flex items-center gap-1.5 text-sm text-gray-700">
                            <input
                              type="checkbox"
                              checked={!!unit.synthetic_grass}
                              onChange={(event) => updateCourtUnit(index, { synthetic_grass: event.target.checked })}
                              className="accent-green-600"
                            />
                            Sintético
                          </label>
                        )}

                        {isPadel(sportName) && (
                          <label className="flex items-center gap-1.5 text-sm text-gray-700">
                            <input
                              type="checkbox"
                              checked={!!unit.acrylic}
                              onChange={(event) => updateCourtUnit(index, { acrylic: event.target.checked })}
                              className="accent-green-600"
                            />
                            Acrílico
                          </label>
                        )}
                      </div>
                    </div>

                    <div className="md:col-span-2">
                      <label className="block text-xs font-medium text-gray-600 mb-1">
                        Descripción de la cancha
                      </label>
                      <input
                        type="text"
                        value={unit.description ?? ""}
                        onChange={(event) => updateCourtUnit(index, { description: event.target.value })}
                        placeholder="Ej: pegada al bar, mejor iluminación, al fondo del complejo"
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-500"
                      />
                    </div>
                  </div>
                </div>
              ))}
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
                    defaultChecked={editingCourt ? editingCourt.days_of_week.includes(d.value) : true}
                    className="accent-green-600"
                  />
                  <span className="text-sm text-gray-700">{d.label}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={closeForm}
              className="px-4 py-2 border border-gray-300 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancelar
            </button>
            <SubmitButton
              label={editingCourt ? "Guardar cambios" : "Guardar cancha"}
              loadingLabel={editingCourt ? "Guardando..." : "Creando..."}
            />
          </div>
        </form>
      )}

      {deleteState?.error && <Alert type="error" message={deleteState.error} />}

      {initialCourts.length === 0 && !showForm ? (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
          <p className="text-gray-400 text-sm">No hay tipos de canchas configurados.</p>
          <p className="text-gray-400 text-xs mt-1">
            Hacé clic en &quot;Agregar canchas&quot; para comenzar.
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
                    🏟️ <strong>{getCourtCapacity(court)}</strong> cancha{getCourtCapacity(court) !== 1 ? "s" : ""}
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

                {court.description && (
                  <p className="text-sm text-gray-500 mt-2">{court.description}</p>
                )}

                <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2">
                  {getActiveCourtUnits(court).map((unit) => (
                    <div
                      key={unit.id ?? unit.name}
                      className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-xs text-gray-600"
                    >
                      <strong className="text-gray-800">{unit.name}</strong>
                      <span className="ml-1">{describeCourtUnit(unit).replace(unit.name, "")}</span>
                    </div>
                  ))}
                </div>

                <p className="text-xs text-gray-400 mt-1.5">
                  {slotsPerDay(court)} turnos disponibles por día ·{" "}
                  {court.days_of_week
                    .sort()
                    .map((d) => DAYS.find((x) => x.value === d)?.label)
                    .join(", ")}
                </p>
              </div>

              <div className="flex flex-col gap-1 items-end">
                <button
                  type="button"
                  onClick={() => openEditForm(court)}
                  className="text-xs text-gray-600 hover:text-gray-900 px-2 py-1 rounded hover:bg-gray-100 transition-colors"
                >
                  Editar
                </button>
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
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
