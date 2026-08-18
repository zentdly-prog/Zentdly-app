"use client";

import { useActionState, useCallback, useEffect, useRef, useState, useTransition } from "react";
import { updateConversationControl, getHumanQueue } from "@/lib/actions/conversations";
import { useVisiblePolling } from "@/lib/useVisiblePolling";
import { Alert } from "@/components/Alert";

type CustomerRelation = { name: string | null; phone_e164: string | null } | { name: string | null; phone_e164: string | null }[] | null;

type QueueItem = {
  id: string;
  external_chat_id: string;
  last_message_at: string;
  human_reason: string | null;
  customers: CustomerRelation;
};

function one<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export default function SupportClient({
  tenantId,
  initialQueue,
  contactEmail,
}: {
  tenantId: string;
  initialQueue: QueueItem[];
  contactEmail?: string | null;
}) {
  const [state, action] = useActionState(updateConversationControl, null);
  const [queue, setQueue] = useState<QueueItem[]>(initialQueue);
  const [, startTransition] = useTransition();
  const lastActionAt = useRef(0);

  const poll = useCallback(() => {
    startTransition(async () => {
      const fresh = await getHumanQueue(tenantId);
      // Avoid clobbering the list right after the user marks one attended
      if (Date.now() - lastActionAt.current < 1500) return;
      setQueue(fresh);
    });
  }, [tenantId]);

  useVisiblePolling(poll, 15_000);

  // When the "Atendido" action succeeds, drop it from the local list immediately
  useEffect(() => {
    if (state?.ok) {
      lastActionAt.current = Date.now();
    }
  }, [state]);

  return (
    <div>
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
          <span className={`w-2.5 h-2.5 rounded-full ${queue.length ? "bg-red-500 animate-pulse" : "bg-gray-300"}`} />
          Atención humana
          {queue.length > 0 && (
            <span className="bg-red-500 text-white text-xs font-bold px-2 py-0.5 rounded-full">{queue.length}</span>
          )}
        </h2>
        <p className="text-sm text-gray-500 mt-1">
          Clientes que pidieron hablar con una persona. El bot queda pausado con ellos hasta que los marques como atendidos.
        </p>
      </div>

      {!contactEmail && (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-900">Falta el email de contacto</p>
          <p className="mt-1 text-xs text-amber-800">
            Este negocio no tiene email cargado, así que no se envía aviso cuando un cliente pide una
            persona. Igual aparece acá, con sonido y el contador en la pestaña.{" "}
            <a href={`/tenants/${tenantId}`} className="font-medium underline">
              Cargalo en General
            </a>
            .
          </p>
        </div>
      )}

      {state?.error && <Alert type="error" message={state.error} />}

      {queue.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-10 text-center">
          <div className="text-3xl mb-2">✅</div>
          <p className="text-sm text-gray-500">Nadie esperando atención humana.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {queue.map((item) => {
            const customer = one(item.customers);
            const displayName = customer?.name || customer?.phone_e164 || item.external_chat_id;
            const phone = customer?.phone_e164 || item.external_chat_id;

            return (
              <div key={item.id} className="bg-red-50 rounded-xl border border-red-200 p-4">
                <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-semibold text-gray-900">{displayName}</div>
                    <div className="text-xs text-gray-500 mt-0.5">{phone}</div>
                    {item.human_reason && (
                      <div className="text-sm text-gray-700 mt-2 bg-white border border-red-100 rounded-lg px-3 py-2">
                        &ldquo;{item.human_reason}&rdquo;
                      </div>
                    )}
                    <div className="text-xs text-gray-400 mt-2">
                      {new Date(item.last_message_at).toLocaleString("es-AR")}
                    </div>
                  </div>

                  <form
                    action={action}
                    className="shrink-0"
                    onSubmit={() => {
                      lastActionAt.current = Date.now();
                      setQueue((q) => q.filter((c) => c.id !== item.id));
                    }}
                  >
                    <input type="hidden" name="tenant_id" value={tenantId} />
                    <input type="hidden" name="conversation_id" value={item.id} />
                    <input type="hidden" name="bot_paused" value="false" />
                    <input type="hidden" name="requires_human" value="false" />
                    <input type="hidden" name="human_reason" value="" />
                    <button className="px-4 py-2 rounded-lg bg-green-600 hover:bg-green-700 text-white text-sm font-medium whitespace-nowrap">
                      Atendido ✓
                    </button>
                  </form>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
