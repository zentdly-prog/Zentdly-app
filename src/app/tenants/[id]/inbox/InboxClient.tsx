"use client";

import { useActionState } from "react";
import { updateConversationControl } from "@/lib/actions/conversations";
import { Alert } from "@/components/Alert";

type CustomerRelation = { name: string | null; phone_e164: string | null } | { name: string | null; phone_e164: string | null }[] | null;

type Conversation = {
  id: string;
  external_chat_id: string;
  status: string;
  last_message_at: string;
  bot_paused?: boolean | null;
  requires_human?: boolean | null;
  human_reason?: string | null;
  customers?: CustomerRelation;
};

function one<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export default function InboxClient({
  tenantId,
  conversations,
}: {
  tenantId: string;
  conversations: Conversation[];
}) {
  const [state, action] = useActionState(updateConversationControl, null);

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 mb-4">Conversaciones</h2>
      {state?.error && <Alert type="error" message={state.error} />}
      {state?.ok && <Alert type="success" message="Conversación actualizada." />}

      <div className="space-y-3">
        {conversations.length === 0 && (
          <div className="bg-white rounded-xl border border-gray-200 p-8 text-sm text-gray-500">
            Todavía no hay conversaciones.
          </div>
        )}

        {conversations.map((conversation) => {
          const customer = one(conversation.customers);
          const displayName = customer?.name || customer?.phone_e164 || conversation.external_chat_id;

          return (
            <div key={conversation.id} className="bg-white rounded-xl border border-gray-200 p-4">
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                <div>
                  <div className="font-medium text-gray-900">{displayName}</div>
                  <div className="text-xs text-gray-400">
                    Último mensaje: {new Date(conversation.last_message_at).toLocaleString("es-AR")}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-2 text-xs">
                    {conversation.bot_paused && <Badge label="Bot pausado" tone="gray" />}
                    {conversation.requires_human && <Badge label="Requiere humano" tone="red" />}
                    {!conversation.bot_paused && !conversation.requires_human && <Badge label="Automático" tone="green" />}
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <form action={action}>
                    <input type="hidden" name="tenant_id" value={tenantId} />
                    <input type="hidden" name="conversation_id" value={conversation.id} />
                    <input type="hidden" name="bot_paused" value={String(!conversation.bot_paused)} />
                    <input type="hidden" name="requires_human" value={String(!!conversation.requires_human)} />
                    <input type="hidden" name="human_reason" value={conversation.human_reason ?? ""} />
                    <button className="px-3 py-1.5 rounded-lg border border-gray-300 text-xs text-gray-700 hover:bg-gray-50">
                      {conversation.bot_paused ? "Reactivar bot" : "Pausar bot"}
                    </button>
                  </form>

                  <form action={action}>
                    <input type="hidden" name="tenant_id" value={tenantId} />
                    <input type="hidden" name="conversation_id" value={conversation.id} />
                    <input type="hidden" name="bot_paused" value={String(!!conversation.bot_paused)} />
                    <input type="hidden" name="requires_human" value={String(!conversation.requires_human)} />
                    <input type="hidden" name="human_reason" value={conversation.requires_human ? "" : "Marcado desde panel"} />
                    <button className="px-3 py-1.5 rounded-lg border border-gray-300 text-xs text-gray-700 hover:bg-gray-50">
                      {conversation.requires_human ? "Quitar humano" : "Requiere humano"}
                    </button>
                  </form>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Badge({ label, tone }: { label: string; tone: "green" | "gray" | "red" }) {
  const classes = {
    green: "bg-green-100 text-green-700",
    gray: "bg-gray-100 text-gray-600",
    red: "bg-red-100 text-red-700",
  };

  return <span className={`px-2 py-0.5 rounded-full ${classes[tone]}`}>{label}</span>;
}
