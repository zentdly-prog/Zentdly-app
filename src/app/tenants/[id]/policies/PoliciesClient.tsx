"use client";

import { useActionState } from "react";
import { saveBotPolicy, type BotPolicy } from "@/lib/actions/policies";
import { SubmitButton } from "@/components/SubmitButton";
import { Alert } from "@/components/Alert";

export default function PoliciesClient({ policy }: { policy: BotPolicy }) {
  const [state, action] = useActionState(saveBotPolicy, null);

  return (
    <div className="max-w-3xl">
      <h2 className="text-lg font-semibold text-gray-900 mb-4">Políticas del agente</h2>

      <form action={action} className="bg-white rounded-xl border border-gray-200 p-6 space-y-5">
        <input type="hidden" name="tenant_id" value={policy.tenant_id} />

        {state?.error && <Alert type="error" message={state.error} />}
        {state?.ok && <Alert type="success" message="Políticas actualizadas." />}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <NumberField
            name="cancellation_min_hours"
            label="Horas mínimas para cancelar"
            defaultValue={policy.cancellation_min_hours}
          />
          <NumberField
            name="reschedule_min_hours"
            label="Horas mínimas para reprogramar"
            defaultValue={policy.reschedule_min_hours}
          />
          <NumberField
            name="deposit_amount"
            label="Seña fija ($)"
            defaultValue={policy.deposit_amount ?? ""}
          />
          <NumberField
            name="deposit_percentage"
            label="Seña porcentual (%)"
            defaultValue={policy.deposit_percentage ?? ""}
          />
        </div>

        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input
            type="checkbox"
            name="requires_deposit"
            defaultChecked={policy.requires_deposit}
            className="accent-green-600"
          />
          El agente debe informar que la reserva requiere seña
        </label>

        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Estado inicial de una reserva
          </label>
          <select
            name="reservation_status_default"
            defaultValue={policy.reservation_status_default}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-500"
          >
            <option value="confirmed">Confirmada</option>
            <option value="pending">Pendiente</option>
          </select>
        </div>

        <TextArea
          name="audio_message"
          label="Respuesta cuando mandan audio"
          defaultValue={policy.audio_message}
        />
        <TextArea
          name="human_handoff_message"
          label="Mensaje al derivar a humano"
          defaultValue={policy.human_handoff_message}
        />

        <div className="flex justify-end">
          <SubmitButton label="Guardar políticas" />
        </div>
      </form>
    </div>
  );
}

function NumberField({
  name,
  label,
  defaultValue,
}: {
  name: string;
  label: string;
  defaultValue: number | string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input
        type="number"
        min={0}
        step="1"
        name={name}
        defaultValue={defaultValue}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-500"
      />
    </div>
  );
}

function TextArea({ name, label, defaultValue }: { name: string; label: string; defaultValue: string }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <textarea
        name={name}
        defaultValue={defaultValue}
        rows={3}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-500"
      />
    </div>
  );
}
