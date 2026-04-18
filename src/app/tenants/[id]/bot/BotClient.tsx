"use client";

import { useState, useTransition } from "react";
import { saveBotPrompt } from "@/lib/actions/whatsapp";
import { Alert } from "@/components/Alert";

const DEFAULT_PROMPT = `Sos un asistente de reservas de canchas deportivas. Tu objetivo es ayudar a los clientes a reservar, cancelar y consultar turnos de manera rápida y amigable.

Siempre respondé en español, de forma concisa y clara.

Cuando el cliente quiera reservar:
1. Preguntá qué deporte y horario prefiere
2. Confirmá la disponibilidad
3. Pedí nombre y teléfono si no los tenés
4. Confirmá la reserva con todos los detalles

Cuando el cliente quiera cancelar:
1. Pedí el número de reserva o fecha/hora del turno
2. Confirmá qué turno se cancela antes de proceder

Sé proactivo ofreciendo alternativas si el horario pedido no está disponible.`;

export default function BotClient({
  tenantId,
  savedPrompt,
}: {
  tenantId: string;
  savedPrompt: string;
}) {
  const [prompt, setPrompt] = useState(savedPrompt || DEFAULT_PROMPT);
  const [status, setStatus] = useState<"idle" | "ok" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState("");
  const [isPending, startTransition] = useTransition();

  function handleSave() {
    setStatus("idle");
    const formData = new FormData();
    formData.append("tenant_id", tenantId);
    formData.append("bot_prompt", prompt);

    startTransition(async () => {
      const res = await saveBotPrompt(null, formData);
      if (res?.ok) {
        setStatus("ok");
      } else {
        setErrorMsg(res?.error ?? "Error al guardar.");
        setStatus("error");
      }
    });
  }

  return (
    <div className="max-w-2xl">
      <h2 className="text-lg font-semibold text-gray-900 mb-1">Bot / IA</h2>
      <p className="text-sm text-gray-500 mb-6">
        Configurá el comportamiento del asistente virtual para este negocio.
      </p>

      <div className="space-y-6">
        {status === "error" && <Alert type="error" message={errorMsg} />}
        {status === "ok" && <Alert type="success" message="Prompt actualizado." />}

        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Prompt del sistema
            </label>
            <p className="text-xs text-gray-400 mb-3">
              Instrucciones que definen cómo se comporta el bot. Los datos de las canchas se inyectan automáticamente como contexto.
            </p>
            <textarea
              rows={16}
              value={prompt}
              onChange={(e) => { setPrompt(e.target.value); setStatus("idle"); }}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 font-mono focus:outline-none focus:ring-2 focus:ring-green-500 resize-y"
              placeholder="Escribí las instrucciones para el bot..."
            />
          </div>

          <div className="bg-gray-50 rounded-lg p-4 text-xs text-gray-500 space-y-1">
            <p className="font-medium text-gray-700 mb-2">Variables automáticas disponibles</p>
            <p><code className="bg-white px-1 rounded border border-gray-200">{"{{canchas}}"}</code> — Lista de canchas con horarios y precios</p>
            <p><code className="bg-white px-1 rounded border border-gray-200">{"{{fecha_hoy}}"}</code> — Fecha actual en la zona horaria del negocio</p>
            <p><code className="bg-white px-1 rounded border border-gray-200">{"{{nombre_negocio}}"}</code> — Nombre del complejo</p>
          </div>

          <div className="flex justify-end">
            <button
              onClick={handleSave}
              disabled={isPending}
              className="px-4 py-2 bg-green-600 text-white text-sm font-semibold rounded-lg hover:bg-green-700 disabled:opacity-50 transition-colors"
            >
              {isPending ? "Guardando..." : "Guardar prompt"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
