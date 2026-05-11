import { SupabaseClient } from "@supabase/supabase-js";

export type AgentIntent = "booking" | "cancel" | "reschedule" | "availability" | "unknown";
export type AgentConversationStatus = "idle" | "collecting_data" | "confirming" | "executing" | "done" | "handoff";

export interface AgentReservationRef {
  id: string;
  label?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
  status?: string | null;
  sport_name?: string | null;
  court_label?: string | null;
}

export interface AgentPendingConfirmation {
  action: "cancel" | "reschedule" | "booking" | "confirm_deposit";
  reservation_ids: string[];
  date?: string | null;
  time?: string | null;
  sport?: string | null;
  court_quantity?: number | null;
  prompt?: string | null;
  created_at: string;
}

export interface AgentConversationState {
  current_intent: AgentIntent;
  intent: AgentIntent;
  status: AgentConversationStatus;
  operation: {
    intent: AgentIntent;
    status: AgentConversationStatus;
    action?: string | null;
    updated_at: string;
  };
  collected: {
    sport?: string | null;
    date?: string | null;
    time?: string | null;
    customer_name?: string | null;
    reservation_id?: string | null;
    court_quantity?: number | null;
  };
  missing: string[];
  last_offered_slots?: string[];
  candidate_reservations?: AgentReservationRef[];
  candidate_reservation_id?: string | null;
  candidate_reservation_ids?: string[];
  last_listed_reservations?: AgentReservationRef[];
  last_listed_reservation_ids?: string[];
  last_created_reservation_ids?: string[];
  pending_deposit_reservation_ids?: string[];
  pending_reservation_ids?: string[];
  pending_confirmation?: AgentPendingConfirmation | null;
  updated_at: string;
}

export function createEmptyAgentState(): AgentConversationState {
  const updatedAt = new Date().toISOString();
  return {
    current_intent: "unknown",
    intent: "unknown",
    status: "idle",
    operation: {
      intent: "unknown",
      status: "idle",
      action: null,
      updated_at: updatedAt,
    },
    collected: {},
    missing: [],
    last_offered_slots: [],
    candidate_reservations: [],
    candidate_reservation_id: null,
    candidate_reservation_ids: [],
    last_listed_reservations: [],
    last_listed_reservation_ids: [],
    last_created_reservation_ids: [],
    pending_deposit_reservation_ids: [],
    pending_reservation_ids: [],
    pending_confirmation: null,
    updated_at: updatedAt,
  };
}

export async function getAgentState(
  db: SupabaseClient,
  conversationId: string,
): Promise<AgentConversationState> {
  const { data } = await db
    .from("ai_sessions")
    .select("state")
    .eq("conversation_id", conversationId)
    .maybeSingle();

  return normalizeAgentState(data?.state);
}

export async function saveAgentState(
  db: SupabaseClient,
  conversationId: string,
  state: Partial<AgentConversationState>,
): Promise<void> {
  const current = await getAgentState(db, conversationId);
  const updatedAt = new Date().toISOString();
  const nextIntent = state.current_intent ?? state.intent ?? current.current_intent ?? current.intent;
  const nextStatus = state.status ?? current.status;
  const next: AgentConversationState = {
    ...current,
    ...state,
    current_intent: nextIntent,
    intent: nextIntent,
    status: nextStatus,
    operation: {
      ...current.operation,
      ...(state.operation ?? {}),
      intent: state.operation?.intent ?? nextIntent,
      status: state.operation?.status ?? nextStatus,
      updated_at: updatedAt,
    },
    collected: {
      ...current.collected,
      ...(state.collected ?? {}),
    },
    updated_at: updatedAt,
  };

  await db.from("ai_sessions").upsert(
    {
      conversation_id: conversationId,
      state: next,
      missing_fields: next.missing,
      updated_at: next.updated_at,
    },
    { onConflict: "conversation_id" },
  );
}

export async function logAgentEvent(
  db: SupabaseClient,
  input: {
    tenantId: string;
    conversationId?: string | null;
    customerId?: string | null;
    eventType: string;
    intent?: string | null;
    toolName?: string | null;
    payload?: Record<string, unknown>;
    error?: string | null;
  },
): Promise<void> {
  await db.from("agent_logs").insert({
    tenant_id: input.tenantId,
    conversation_id: input.conversationId ?? null,
    customer_id: input.customerId ?? null,
    event_type: input.eventType,
    intent: input.intent ?? null,
    tool_name: input.toolName ?? null,
    payload: input.payload ?? {},
    error: input.error ?? null,
  }).then(() => undefined);
}

export function normalizeAgentState(value: unknown): AgentConversationState {
  const fallback = createEmptyAgentState();

  if (!value || typeof value !== "object") return fallback;
  const raw = value as Partial<AgentConversationState>;
  const candidateReservations = Array.isArray(raw.candidate_reservations) ? raw.candidate_reservations : [];
  const candidateReservationIds = Array.isArray(raw.candidate_reservation_ids)
    ? raw.candidate_reservation_ids
    : candidateReservations.map((reservation) => reservation.id).filter(Boolean);
  const normalizedCandidateReservations = candidateReservations.length
    ? candidateReservations
    : candidateReservationIds.map((id) => ({ id }));
  const lastListedReservations = Array.isArray(raw.last_listed_reservations) ? raw.last_listed_reservations : [];
  const lastListedReservationIds = Array.isArray(raw.last_listed_reservation_ids)
    ? raw.last_listed_reservation_ids
    : lastListedReservations.map((reservation) => reservation.id).filter(Boolean);
  const normalizedLastListedReservations = lastListedReservations.length
    ? lastListedReservations
    : lastListedReservationIds.map((id) => ({ id }));
  const pendingDepositReservationIds = Array.isArray(raw.pending_deposit_reservation_ids)
    ? raw.pending_deposit_reservation_ids
    : Array.isArray(raw.pending_reservation_ids)
      ? raw.pending_reservation_ids
      : [];
  const intent = raw.current_intent ?? raw.intent ?? fallback.intent;
  const status = raw.status ?? fallback.status;

  return {
    current_intent: intent,
    intent,
    status,
    operation: {
      intent: raw.operation?.intent ?? intent,
      status: raw.operation?.status ?? status,
      action: raw.operation?.action ?? null,
      updated_at: raw.operation?.updated_at ?? raw.updated_at ?? fallback.updated_at,
    },
    collected: raw.collected ?? fallback.collected,
    missing: Array.isArray(raw.missing) ? raw.missing : fallback.missing,
    last_offered_slots: Array.isArray(raw.last_offered_slots) ? raw.last_offered_slots : fallback.last_offered_slots,
    candidate_reservations: normalizedCandidateReservations,
    candidate_reservation_id: raw.candidate_reservation_id ?? null,
    candidate_reservation_ids: candidateReservationIds,
    last_listed_reservations: normalizedLastListedReservations,
    last_listed_reservation_ids: lastListedReservationIds,
    last_created_reservation_ids: Array.isArray(raw.last_created_reservation_ids) ? raw.last_created_reservation_ids : fallback.last_created_reservation_ids,
    pending_deposit_reservation_ids: pendingDepositReservationIds,
    pending_reservation_ids: pendingDepositReservationIds,
    pending_confirmation: raw.pending_confirmation ?? null,
    updated_at: raw.updated_at ?? fallback.updated_at,
  };
}
