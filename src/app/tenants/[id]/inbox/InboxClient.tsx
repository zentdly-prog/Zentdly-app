"use client";

import { useActionState, useCallback, useEffect, useRef, useState, useTransition } from "react";
import {
  updateConversationControl,
  getTenantConversations,
  getConversationsSignature,
} from "@/lib/actions/conversations";
import { useVisiblePolling } from "@/lib/useVisiblePolling";
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

function relativeTime(iso: string, now: number): string {
  const diff = now - new Date(iso).getTime();
  const s = Math.round(diff / 1000);
  if (s < 60) return "hace un momento";
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  if (d < 7) return `hace ${d} día${d !== 1 ? "s" : ""}`;
  return new Date(iso).toLocaleDateString("es-AR");
}

// Sort newest-first by last activity — the person who wrote last goes on top.
function sortByRecency(list: Conversation[]): Conversation[] {
  return [...list].sort(
    (a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime(),
  );
}

export default function InboxClient({
  tenantId,
  conversations: initial,
}: {
  tenantId: string;
  conversations: Conversation[];
}) {
  const [state, action] = useActionState(updateConversationControl, null);
  const [conversations, setConversations] = useState<Conversation[]>(sortByRecency(initial));
  // Rendering reads "now" from state rather than calling Date.now() inline, so
  // relative labels stay pure and refresh on a predictable tick.
  const [now, setNow] = useState(() => Date.now());
  const [, startTransition] = useTransition();

  // Remember what we last rendered so a poll that finds nothing new costs
  // only the tiny signature query instead of the full conversation list.
  const signature = useRef<string>(
    `${initial.length}|${sortByRecency(initial)[0]?.last_message_at ?? ""}`,
  );

  const poll = useCallback(() => {
    startTransition(async () => {
      const sig = await getConversationsSignature(tenantId);
      const key = `${sig.count}|${sig.latest ?? ""}`;
      if (key === signature.current) return; // nothing changed — skip the big fetch
      signature.current = key;
      const fresh = await getTenantConversations(tenantId);
      setConversations(sortByRecency(fresh as Conversation[]));
    });
  }, [tenantId]);

  useVisiblePolling(poll, 8_000);

  // Keep the "hace X min" labels fresh without a network call.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const topId = conversations[0]?.id;

  return (
    <div>
      <div className="flex items-center gap-2 mb-4">
        <h2 className="text-lg font-semibold text-gray-900">Conversaciones</h2>
        <span className="flex items-center gap-1 text-xs text-gray-400">
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
          en vivo
        </span>
      </div>

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
          const isMostRecent = conversation.id === topId;
          const fresh = now - new Date(conversation.last_message_at).getTime() < 60_000;

          return (
            <div
              key={conversation.id}
              className={`bg-white rounded-xl border p-4 transition-colors ${
                isMostRecent && fresh ? "border-green-300 ring-1 ring-green-100" : "border-gray-200"
              }`}
            >
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    {fresh && <span className="w-2 h-2 rounded-full bg-green-500" />}
                    <span className="font-medium text-gray-900">{displayName}</span>
                  </div>
                  <div className="text-xs text-gray-400 mt-0.5">
                    Último mensaje: {relativeTime(conversation.last_message_at, now)}
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
