import { addDays, addMonths, setDate } from "date-fns";
import { formatInTimeZone, toZonedTime } from "date-fns-tz";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createAgentBookingServices,
  type AgentBookingContext,
  type CustomerReservation,
  type ReservableCourt,
} from "@/domain/booking/agentBookingServices";
import { IntentExtractor } from "@/integrations/ai/intentExtractor";
import type { NormalizedIntent } from "@/integrations/ai/schemas";
import { getBotPolicy } from "@/lib/actions/policies";
import {
  getAgentState,
  logAgentEvent,
  saveAgentState,
  type AgentReservationRef,
  type AgentConversationState,
  type AgentIntent,
} from "@/domain/conversation/agentOps";

export interface DeterministicRouterInput {
  db: SupabaseClient;
  tenantId: string;
  customerId: string;
  customerPhone: string;
  timezone: string;
  conversationId: string;
  message: string;
  calendarSync?: AgentBookingContext["calendarSync"];
}

export interface DeterministicRouterResult {
  handled: boolean;
  reply?: string;
}

interface ParsedMessage {
  intent: AgentIntent;
  date: string | null;
  time: string | null;
  multiTimes: string[] | null;
  sport: string | null;
  customerName: string | null;
  reservationId: string | null;
  courtQuantity: number | null;
  asksUnsupportedSport: boolean;
  hasCorrection: boolean;
  hasDepositProof: boolean;
  timeAmbiguous: boolean;
  timeOptions: { morning: string; evening: string } | null;
  contextualReference: NormalizedIntent["contextual_reference"] | null;
  confirmation: NormalizedIntent["confirmation"] | null;
  actionRequested: NormalizedIntent["action_requested"] | null;
  wantsExactSlot: boolean;
}

export async function handleDeterministicBookingMessage(
  input: DeterministicRouterInput,
): Promise<DeterministicRouterResult> {
  const rawState = await getAgentState(input.db, input.conversationId);
  const normalizedIntent = await normalizeMessage(input, rawState);
  // Policy questions (including deposit-only) now route through the fallback
  // responder so multi-topic queries like "cuanto cuesta y cuanto es la seña"
  // get a complete answer.

  const parsed = normalizedIntent
    ? normalizedIntentToParsedMessage(normalizedIntent, rawState, input.message)
    : parseBookingMessage(input.message, input.timezone, rawState);
  if (parsed.intent === "availability" && !messageHasExplicitTime(input.message)) {
    parsed.time = null;
    parsed.timeAmbiguous = false;
    parsed.timeOptions = null;
    parsed.wantsExactSlot = false;
  }

  const state = maybeResetStateForNewOperation(rawState, parsed);
  if (state !== rawState) {
    await logRouterEvent(input, "state_reset_for_new_operation", {
      previousIntent: rawState.intent,
      previousStatus: rawState.status,
      newIntent: parsed.intent,
    });
  }

  if (parsed.intent === "unknown" && parsed.actionRequested !== "list_reservations") return { handled: false };

  const booking = createAgentBookingServices({
    db: input.db,
    tenantId: input.tenantId,
    customerId: input.customerId,
    customerPhone: input.customerPhone,
    timezone: input.timezone,
    calendarSync: input.calendarSync,
  });

  if (parsed.actionRequested === "list_reservations") {
    const active = await booking.reservations.listActive();
    await persistState(input, state, parsed, {
      intent: "availability",
      status: "done",
      sport: parsed.sport ?? state.collected.sport ?? null,
      date: parsed.date,
      time: parsed.time,
      reservationId: null,
      missing: [],
      candidateReservationIds: active.map((reservation) => reservation.id),
      candidateReservations: active,
      lastListedReservations: active,
      pendingConfirmation: null,
    });
    await logRouterEvent(input, "reservations_listed", { count: active.length });
    return {
      handled: true,
      reply: active.length
        ? `Estas son tus reservas activas:\n${booking.reservations.formatReservations(active)}`
        : "No encontré reservas activas a tu nombre.",
    };
  }

  const courts = await booking.availability.fetchReservableCourts();
  const sportDecision = resolveSport(courts, parsed.sport, parsed.asksUnsupportedSport, state);

  if (sportDecision.reply) {
    await persistState(input, state, parsed, {
      intent: parsed.intent,
      status: "collecting_data",
      sport: sportDecision.sport,
      date: parsed.date ?? state.collected.date ?? null,
      time: parsed.time ?? state.collected.time ?? null,
      courtQuantity: parsed.courtQuantity ?? state.collected.court_quantity ?? 1,
    });
    return { handled: true, reply: sportDecision.reply };
  }

  const sport = sportDecision.sport;
  const canUseCollected = parsed.intent !== "availability";
  const date = parsed.date ?? (canUseCollected ? state.collected.date ?? null : null);
  const time = parsed.time ?? (canUseCollected ? state.collected.time ?? null : null);
  const customerName = parsed.customerName ?? (canUseCollected ? state.collected.customer_name ?? null : null);
  const reservationId = parsed.reservationId ?? (canUseCollected ? state.collected.reservation_id ?? null : null);
  const courtQuantity = parsed.courtQuantity ?? (canUseCollected ? state.collected.court_quantity ?? 1 : 1);
  const multiTimes = parsed.multiTimes && parsed.multiTimes.length >= 2
    ? parsed.multiTimes
    : (canUseCollected && state.collected.multi_times && state.collected.multi_times.length >= 2
        ? state.collected.multi_times
        : null);

  if (parsed.timeAmbiguous && parsed.timeOptions) {
    await persistState(input, state, parsed, {
      intent: parsed.intent,
      status: "collecting_data",
      sport,
      date,
      time: null,
      customerName,
      courtQuantity,
      missing: ["time"],
      lastOfferedSlots: [parsed.timeOptions.morning, parsed.timeOptions.evening],
    });
    return {
      handled: true,
      reply: `¿Te referís a las ${parsed.timeOptions.morning} o a las ${parsed.timeOptions.evening}?`,
    };
  }

  if (parsed.intent === "cancel") {
    if (parsed.confirmation?.is_rejection && state.intent === "cancel" && state.status === "confirming") {
      await persistState(input, state, parsed, {
        intent: "cancel",
        status: "idle",
        sport,
        date,
        time,
        reservationId: null,
        missing: [],
        candidateReservationId: null,
        candidateReservationIds: [],
        candidateReservations: [],
        pendingConfirmation: null,
      });
      return {
        handled: true,
        reply: "Perfecto, no cancelo nada.",
      };
    }

    if (parsed.confirmation?.is_confirmation && state.intent === "cancel" && state.status === "confirming") {
      const pending = state.pending_confirmation?.action === "cancel" ? state.pending_confirmation : null;
      const candidateIds = pending?.reservation_ids?.length ? pending.reservation_ids : state.candidate_reservation_ids ?? [];
      const result = await booking.reservations.cancelMany(candidateIds);
      await persistState(input, state, parsed, {
        intent: "cancel",
        status: result.ok ? "done" : "collecting_data",
        sport,
        date,
        time,
        reservationId,
        missing: result.ok ? [] : ["reservation"],
        candidateReservationId: null,
        candidateReservationIds: result.ok ? [] : candidateIds,
        candidateReservations: result.ok ? [] : state.candidate_reservations ?? [],
        pendingConfirmation: result.ok ? null : pending,
      });
      await logRouterEvent(input, "cancel_many_confirmed", { candidateIds, reply: result.reply });
      return { handled: true, reply: result.reply };
    }

    const candidates = await resolveCancellationCandidates({
      booking,
      parsed,
      state,
      sport,
      date,
      time,
      reservationId,
      quantity: courtQuantity,
    });

    if (!candidates.length) {
      const active = await booking.reservations.listActive();
      await persistState(input, state, parsed, {
        intent: "cancel",
        status: "collecting_data",
        sport,
        date,
        time,
        reservationId,
        missing: ["reservation"],
        candidateReservationIds: active.map((reservation) => reservation.id),
        candidateReservations: active,
        lastListedReservations: active,
      });
      return {
        handled: true,
        reply: active.length
          ? `${booking.reservations.formatReservations(active)}\n\n¿Cuál querés cancelar? Podés decirme el ID, el día/horario, "esas 3", "las de mañana" o "todas".`
          : "No encontré reservas activas a tu nombre para cancelar.",
      };
    }

    const candidateIds = candidates.map((reservation) => reservation.id);
    if (candidates.length > 1) {
      const prompt = `Tengo estas ${candidates.length} reservas para cancelar:\n${booking.reservations.formatReservations(candidates)}\n¿Confirmás que querés cancelarlas?`;
      await persistState(input, state, parsed, {
        intent: "cancel",
        status: "confirming",
        sport,
        date,
        time,
        reservationId,
        courtQuantity: candidates.length,
        missing: [],
        candidateReservationId: candidateIds[0] ?? null,
        candidateReservationIds: candidateIds,
        candidateReservations: candidates,
        lastListedReservations: candidates,
        pendingConfirmation: buildPendingConfirmation("cancel", candidateIds, {
          date,
          time,
          sport,
          courtQuantity: candidates.length,
          prompt,
        }),
      });
      return {
        handled: true,
        reply: prompt,
      };
    }

    const result = await booking.reservations.cancelMany(candidateIds);

    await persistState(input, state, parsed, {
      intent: "cancel",
      status: result.ok ? "done" : "collecting_data",
      sport,
      date,
      time,
      reservationId,
      missing: result.ok ? [] : ["reservation"],
      candidateReservationId: null,
      candidateReservationIds: result.ok ? [] : candidateIds,
      candidateReservations: result.ok ? [] : candidates,
      pendingConfirmation: null,
    });
    await logRouterEvent(input, "cancel_attempted", { date, time, sport, reservationId, reply: result.reply });
    return { handled: true, reply: result.reply };
  }

  if (parsed.intent === "availability") {
    if (!date) return { handled: false };

    const reply = await renderAvailabilityReply(input.db, input.tenantId, input.timezone, date, sport, time);
    await persistState(input, state, parsed, {
      intent: parsed.wantsExactSlot ? "booking" : "availability",
      status: parsed.wantsExactSlot ? "collecting_data" : "done",
      sport,
      date,
      time,
      lastOfferedSlots: extractSlotTimes(reply),
    });
    await logRouterEvent(input, "availability_answered", { date, time, sport, reply });
    return { handled: true, reply };
  }

  if (parsed.intent === "reschedule") {
    if (parsed.confirmation?.is_rejection && state.intent === "reschedule" && state.status === "confirming") {
      await persistState(input, state, parsed, {
        intent: "reschedule",
        status: "idle",
        sport,
        date,
        time,
        reservationId: null,
        missing: [],
        candidateReservationId: null,
        candidateReservationIds: [],
        candidateReservations: [],
        pendingConfirmation: null,
      });
      return {
        handled: true,
        reply: "Perfecto, no reprogramo nada.",
      };
    }

    if (parsed.confirmation?.is_confirmation && state.intent === "reschedule" && state.status === "confirming") {
      const pending = state.pending_confirmation?.action === "reschedule" ? state.pending_confirmation : null;
      const candidateIds = pending?.reservation_ids?.length ? pending.reservation_ids : state.candidate_reservation_ids ?? [];
      const targetDate = date ?? pending?.date ?? state.collected.date ?? null;
      const targetTime = time ?? pending?.time ?? state.collected.time ?? null;
      if (!candidateIds.length || !targetDate || !targetTime) {
        await persistState(input, state, parsed, {
          intent: "reschedule",
          status: "collecting_data",
          sport,
          date: targetDate,
          time: targetTime,
          missing: [
            !candidateIds.length ? "reservation" : null,
            !targetDate ? "date" : null,
            !targetTime ? "time" : null,
          ].filter(Boolean) as string[],
          pendingConfirmation: pending,
        });
        return { handled: true, reply: "Me falta identificar qué reserva mover y a qué día/horario." };
      }

      const result = await booking.reservations.rescheduleMany(candidateIds, targetDate, targetTime);
      await persistState(input, state, parsed, {
        intent: "reschedule",
        status: result.ok ? "done" : "collecting_data",
        sport,
        date: targetDate,
        time: targetTime,
        reservationId: null,
        missing: result.ok ? [] : ["reservation"],
        candidateReservationId: null,
        candidateReservationIds: result.ok ? [] : candidateIds,
        candidateReservations: result.ok ? [] : state.candidate_reservations ?? [],
        pendingConfirmation: result.ok ? null : pending,
      });
      await logRouterEvent(input, "reschedule_many_confirmed", { candidateIds, date: targetDate, time: targetTime, reply: result.reply });
      return { handled: true, reply: result.reply };
    }

    const candidates = await resolveChangeCandidates({
      booking,
      parsed,
      state,
      sport,
      date: null,
      time: null,
      reservationId,
      quantity: courtQuantity,
    });

    if (!candidates.length) {
      const active = await booking.reservations.listActive();
      await persistState(input, state, parsed, {
        intent: "reschedule",
        status: "collecting_data",
        sport,
        date,
        time,
        reservationId,
        missing: ["reservation"],
        candidateReservationIds: active.map((reservation) => reservation.id),
        candidateReservations: active,
        lastListedReservations: active,
      });
      return {
        handled: true,
        reply: active.length
          ? `${booking.reservations.formatReservations(active)}\n\n¿Cuál querés reprogramar y para qué día/horario?`
          : "No encontré reservas activas a tu nombre para reprogramar.",
      };
    }

    if (!date || !time) {
      const candidateIds = candidates.map((reservation) => reservation.id);
      await persistState(input, state, parsed, {
        intent: "reschedule",
        status: "collecting_data",
        sport,
        date,
        time,
        reservationId: candidateIds[0] ?? null,
        courtQuantity: candidates.length,
        missing: [!date ? "date" : null, !time ? "time" : null].filter(Boolean) as string[],
        candidateReservationId: candidateIds[0] ?? null,
        candidateReservationIds: candidateIds,
        candidateReservations: candidates,
        lastListedReservations: candidates,
      });
      return {
        handled: true,
        reply: `Tengo identificada${candidates.length !== 1 ? "s" : ""}:\n${booking.reservations.formatReservations(candidates)}\n¿A qué día y horario querés mover${candidates.length !== 1 ? "las" : "la"}?`,
      };
    }

    const slotResolution = await resolveScheduleTime(input.db, input.tenantId, input.timezone, date, time, sport);
    if (!slotResolution.ok) {
      await persistState(input, state, parsed, {
        intent: "reschedule",
        status: "collecting_data",
        sport,
        date,
        time: slotResolution.suggestedTime ?? time,
        reservationId: candidates[0]?.id ?? null,
        courtQuantity: candidates.length,
        candidateReservationId: candidates[0]?.id ?? null,
        candidateReservationIds: candidates.map((reservation) => reservation.id),
        candidateReservations: candidates,
      });
      return { handled: true, reply: slotResolution.reply };
    }

    const validation = await booking.reservations.validateRescheduleMany(
      candidates.map((reservation) => reservation.id),
      date,
      slotResolution.time,
    );
    if (!validation.ok) {
      await persistState(input, state, parsed, {
        intent: "reschedule",
        status: "collecting_data",
        sport,
        date,
        time: slotResolution.time,
        reservationId: candidates[0]?.id ?? null,
        courtQuantity: candidates.length,
        candidateReservationId: candidates[0]?.id ?? null,
        candidateReservationIds: candidates.map((reservation) => reservation.id),
        candidateReservations: candidates,
      });
      return { handled: true, reply: validation.reply };
    }

    const candidateIds = candidates.map((reservation) => reservation.id);
    const prompt = `Tengo estas ${candidates.length} reserva${candidates.length !== 1 ? "s" : ""} para mover:\n${booking.reservations.formatReservations(candidates)}\nNuevo horario: ${date} a las ${slotResolution.time}.\n¿Confirmás el cambio?`;
    await persistState(input, state, parsed, {
      intent: "reschedule",
      status: "confirming",
      sport,
      date,
      time: slotResolution.time,
      reservationId: candidateIds[0] ?? null,
      courtQuantity: candidates.length,
      missing: [],
      candidateReservationId: candidateIds[0] ?? null,
      candidateReservationIds: candidateIds,
      candidateReservations: candidates,
      lastListedReservations: candidates,
      pendingConfirmation: buildPendingConfirmation("reschedule", candidateIds, {
        date,
        time: slotResolution.time,
        sport,
        courtQuantity: candidates.length,
        prompt,
      }),
    });
    return {
      handled: true,
      reply: prompt,
    };
  }

  if (parsed.intent === "booking") {
    const policy = await getBotPolicy(input.tenantId, input.db);
    const pendingReservationIds = (state.pending_deposit_reservation_ids?.length
      ? state.pending_deposit_reservation_ids
      : state.pending_reservation_ids) ?? [];

    if (policy.requires_deposit && parsed.hasDepositProof) {
      if (pendingReservationIds.length > 0) {
        const reply = await booking.reservations.confirmPending({
          reservation_ids: pendingReservationIds,
          date: date ?? undefined,
          time: time ?? undefined,
          sport_name: sport,
        });
        await persistState(input, state, parsed, {
          intent: "booking",
          status: reply.startsWith("✅") ? "done" : "collecting_data",
          sport,
          date,
          time,
          customerName,
          courtQuantity,
          missing: reply.startsWith("✅") ? [] : ["deposit"],
          pendingReservationIds: reply.startsWith("✅") ? [] : pendingReservationIds,
          pendingDepositReservationIds: reply.startsWith("✅") ? [] : pendingReservationIds,
          candidateReservationIds: reply.startsWith("✅") ? [] : pendingReservationIds,
          candidateReservations: reply.startsWith("✅") ? [] : state.candidate_reservations ?? [],
          lastCreatedReservationIds: reply.startsWith("✅") ? pendingReservationIds : state.last_created_reservation_ids ?? [],
          pendingConfirmation: reply.startsWith("✅") ? null : buildPendingConfirmation("confirm_deposit", pendingReservationIds, {
            date,
            time,
            sport,
            courtQuantity,
          }),
        });
        await logRouterEvent(input, "pending_booking_confirmed", { date, time, sport, reply, pendingReservationIds });
        return { handled: true, reply };
      }

      if (!date || !time || !customerName) {
        await persistState(input, state, parsed, {
          intent: "booking",
          status: "collecting_data",
          sport,
          date,
          time,
          customerName,
          courtQuantity,
          missing: [
            !date ? "date" : null,
            !time ? "time" : null,
            !customerName ? "customer_name" : null,
          ].filter(Boolean) as string[],
        });
        return {
          handled: true,
          reply: "Recibí el comprobante, pero no encontré una reserva pendiente en esta conversación. Pasame día, horario y nombre para ubicarla.",
        };
      }
    }

    if (multiTimes && !parsed.hasDepositProof) {
      const result = await handleMultiTimeBooking({
        input,
        state,
        parsed,
        booking,
        policy,
        date,
        sport,
        customerName,
        multiTimes,
      });
      if (result) return result;
    }

    if (!date || !time) {
      await persistState(input, state, parsed, {
        intent: "booking",
        status: "collecting_data",
        sport,
        date,
        time,
        customerName,
        missing: [!date ? "date" : null, !time ? "time" : null].filter(Boolean) as string[],
      });
      return { handled: true, reply: missingBookingReply(date, time) };
    }

    if (parsed.hasCorrection && state.candidate_reservation_id) {
      const reply = await booking.reservations.reschedule({
        reservation_id: state.candidate_reservation_id,
        date,
        time,
      });
      await persistState(input, state, parsed, {
        intent: "booking",
        status: reply.startsWith("✅") ? "done" : "collecting_data",
        sport,
        date,
        time,
        customerName,
      });
      await logRouterEvent(input, "booking_correction_attempted", { date, time, sport, reply });
      return { handled: true, reply };
    }

    const slotResolution = await resolveScheduleTime(input.db, input.tenantId, input.timezone, date, time, sport);
    if (!slotResolution.ok) {
      await persistState(input, state, parsed, {
        intent: "booking",
        status: "collecting_data",
        sport,
        date,
        time: slotResolution.suggestedTime ?? time,
        customerName,
      });
      return { handled: true, reply: slotResolution.reply };
    }

    if (pendingReservationIds.length === 0) {
      const exactSlot = await getExactSlotFree(input.db, input.tenantId, input.timezone, date, slotResolution.time, sport);
      if (!exactSlot.available || exactSlot.free < courtQuantity) {
        const list = await booking.availability.check(date, sport);
        const availableCount = exactSlot.available ? exactSlot.free : 0;
        await persistState(input, state, parsed, {
          intent: "booking",
          status: "collecting_data",
          sport,
          date,
          time: slotResolution.time,
          customerName,
          courtQuantity: Math.max(availableCount, 1),
          lastOfferedSlots: extractSlotTimes(list),
        });
        return {
          handled: true,
          reply: availableCount > 0
            ? `Para ${date} a las ${slotResolution.time} hay ${availableCount} cancha${availableCount !== 1 ? "s" : ""} disponible${availableCount !== 1 ? "s" : ""}. No puedo reservar ${courtQuantity}.\n¿Querés reservar ${availableCount}?`
            : `Para ${date} a las ${slotResolution.time} está completo.\n${list}`,
        };
      }
    }

    if (!customerName) {
      const depositLine = await renderDepositLine(input.tenantId, input.db);
      await persistState(input, state, parsed, {
        intent: "booking",
        status: "collecting_data",
        sport,
        date,
        time: slotResolution.time,
        customerName,
        courtQuantity,
        missing: ["customer_name"],
      });
      return {
        handled: true,
        reply: `Dale. ¿A nombre de quién hago la reserva?${depositLine ? `\n${depositLine}` : ""}`,
      };
    }

    if (policy.requires_deposit && !parsed.hasDepositProof && pendingReservationIds.length > 0) {
      const depositLine = await renderDepositLine(input.tenantId, input.db);
      const pendingMatch = pendingReservationMatchesSlot(state, date, slotResolution.time);

      // If the existing pending is at a DIFFERENT slot, reschedule it to the new one
      // so the pending IDs keep pointing to the right reservation.
      if (!pendingMatch) {
        const reschedule = await booking.reservations.rescheduleMany(
          pendingReservationIds,
          date,
          slotResolution.time,
        );
        if (!reschedule.ok) {
          await persistState(input, state, parsed, {
            intent: "booking",
            status: "collecting_data",
            sport,
            date,
            time: slotResolution.time,
            customerName,
            courtQuantity,
            missing: ["deposit"],
            pendingReservationIds,
            pendingDepositReservationIds: pendingReservationIds,
          });
          await logRouterEvent(input, "pending_reschedule_failed", {
            reservationIds: pendingReservationIds,
            date,
            time: slotResolution.time,
            reply: reschedule.reply,
          });
          return { handled: true, reply: reschedule.reply };
        }
        await logRouterEvent(input, "pending_rescheduled_to_new_slot", {
          reservationIds: pendingReservationIds,
          date,
          time: slotResolution.time,
        });
      }

      await persistState(input, state, parsed, {
        intent: "booking",
        status: "collecting_data",
        sport,
        date,
        time: slotResolution.time,
        customerName,
        courtQuantity,
        missing: ["deposit"],
        pendingReservationIds,
        pendingDepositReservationIds: pendingReservationIds,
        candidateReservationIds: pendingReservationIds,
        candidateReservations: reservationRefsFromIds(pendingReservationIds, {
          sport,
          date,
          time: slotResolution.time,
          status: "pending",
        }),
        pendingConfirmation: buildPendingConfirmation("confirm_deposit", pendingReservationIds, {
          date,
          time: slotResolution.time,
          sport,
          courtQuantity,
        }),
      });
      const verb = pendingMatch ? "ya quedó pendiente" : "quedó actualizada y pendiente";
      return {
        handled: true,
        reply: `La reserva ${verb} para ${date} a las ${slotResolution.time} a nombre de ${customerName}.\n${depositLine || "Para confirmarla hace falta seña."}\nMandame el comprobante y la marco como confirmada.`,
      };
    }

    if (policy.requires_deposit && !parsed.hasDepositProof) {
      const depositLine = await renderDepositLine(input.tenantId, input.db);
      const created = [];
      for (let index = 0; index < courtQuantity; index++) {
        const createResult = await booking.reservations.createReservation({
          customer_name: customerName,
          sport_name: sport,
          date,
          time: slotResolution.time,
          status: "pending",
        });
        created.push(createResult);
        if (!createResult.ok) break;
      }

      const successful = created.filter((result) => result.ok);
      const createdIds = successful.map((result) => result.id).filter(Boolean) as string[];
      const reply = successful.length === courtQuantity
        ? renderPendingDepositReply({
            quantity: courtQuantity,
            sport,
            date,
            time: slotResolution.time,
            customerName,
            depositLine,
          })
        : created.at(-1)?.reply ?? "No pude dejar la reserva pendiente.";

      await persistState(input, state, parsed, {
        intent: "booking",
        status: "collecting_data",
        sport,
        date,
        time: slotResolution.time,
        customerName,
        courtQuantity,
        missing: ["deposit"],
        pendingReservationIds: createdIds,
        pendingDepositReservationIds: createdIds,
        candidateReservationId: createdIds[0] ?? null,
        candidateReservationIds: createdIds,
        candidateReservations: reservationRefsFromIds(createdIds, {
          sport,
          date,
          time: slotResolution.time,
          status: "pending",
        }),
        lastCreatedReservationIds: createdIds,
        pendingConfirmation: buildPendingConfirmation("confirm_deposit", createdIds, {
          date,
          time: slotResolution.time,
          sport,
          courtQuantity,
          prompt: reply,
        }),
      });
      await logRouterEvent(input, "pending_booking_created", { date, time: slotResolution.time, sport, createdIds, reply });
      return {
        handled: true,
        reply,
      };
    }

    const createdReplies: string[] = [];
    const createdIds: string[] = [];
    for (let index = 0; index < courtQuantity; index++) {
      const createArgs: Record<string, string> = {
        customer_name: customerName,
        sport_name: sport,
        date,
        time: slotResolution.time,
      };
      if (policy.requires_deposit) createArgs.status = "confirmed";
      const createResult = await booking.reservations.createReservation(createArgs);
      if (!createResult.ok) {
        createdReplies.push(createResult.reply);
        break;
      }
      createdReplies.push(createResult.reply);
      if (createResult.id) createdIds.push(createResult.id);
    }

    const reply = renderMultiReservationReply(createdReplies, {
      quantity: courtQuantity,
      sport,
      date,
      time: slotResolution.time,
      customerName,
    });

    const reservationId = createdIds[0] ?? reply.match(/ID:\s*([a-f0-9-]{8,})/i)?.[1] ?? null;
    await persistState(input, state, parsed, {
      intent: "booking",
      status: reply.startsWith("✅") ? "done" : "collecting_data",
      sport,
      date,
      time: slotResolution.time,
      customerName,
      courtQuantity,
      candidateReservationId: reservationId,
      candidateReservationIds: createdIds,
      candidateReservations: reservationRefsFromIds(createdIds, {
        sport,
        date,
        time: slotResolution.time,
        status: "confirmed",
      }),
      lastCreatedReservationIds: createdIds,
      missing: [],
      pendingReservationIds: [],
      pendingDepositReservationIds: [],
      pendingConfirmation: null,
    });
    await logRouterEvent(input, "booking_attempted", { date, time: slotResolution.time, sport, reply });
    return { handled: true, reply };
  }

  return { handled: false };
}

function maybeResetStateForNewOperation(
  state: AgentConversationState,
  parsed: ParsedMessage,
): AgentConversationState {
  const parsedIntent = parsed.intent;
  const inConfirmation = state.status === "confirming";
  const isConfirmationResponse =
    parsed.confirmation?.is_confirmation || parsed.confirmation?.is_rejection;

  // Respond to a pending confirmation prompt — do NOT reset.
  if (inConfirmation && isConfirmationResponse) return state;

  // Deposit proof for a pending reservation — do NOT reset (keeps pending IDs).
  if (parsed.hasDepositProof && (state.pending_deposit_reservation_ids?.length || state.pending_reservation_ids?.length)) {
    return state;
  }

  const previousFinished = state.status === "done" || state.status === "handoff" || state.status === "idle";
  const intentChanged =
    state.intent !== "unknown" &&
    parsedIntent !== "unknown" &&
    state.intent !== parsedIntent;

  // Start of a brand-new booking after a completed one
  const restartsBooking =
    parsedIntent === "booking" &&
    state.status === "done" &&
    !!parsed.date &&
    !!parsed.time;

  if (!previousFinished && !intentChanged && !restartsBooking) return state;

  return {
    ...state,
    collected: {},
    missing: [],
    last_offered_slots: [],
    candidate_reservation_id: null,
    candidate_reservation_ids: [],
    candidate_reservations: [],
    pending_confirmation: null,
    // Preserve: pending_*_reservation_ids, last_created_reservation_ids,
    // last_listed_reservations — user may still reference them.
  };
}

async function normalizeMessage(
  input: DeterministicRouterInput,
  state: AgentConversationState,
): Promise<NormalizedIntent | null> {
  try {
    const history = await loadShortHistory(input.db, input.conversationId);
    const normalized = await new IntentExtractor().normalize({
      message: input.message,
      timezone: input.timezone,
      state,
      history,
    });
    await logRouterEvent(input, "intent_normalized", { normalized });
    return normalized;
  } catch (error) {
    const err = error as Error & { rawPayload?: unknown };
    await logRouterEvent(input, "intent_normalization_failed", {
      error: err.message ?? "Unknown extractor error",
      rawPayload: err.rawPayload ?? null,
    });
    return null;
  }
}

async function loadShortHistory(
  db: SupabaseClient,
  conversationId: string,
): Promise<Array<{ role: "user" | "assistant"; content: string }>> {
  const { data } = await db
    .from("messages")
    .select("direction, content")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .limit(12);

  return (data ?? []).reverse().map((message) => ({
    role: message.direction === "inbound" ? "user" : "assistant",
    content: message.content,
  }));
}

function normalizedIntentToParsedMessage(
  normalized: NormalizedIntent,
  state: AgentConversationState,
  rawMessage: string,
): ParsedMessage {
  const fallbackIntent: AgentIntent =
    normalized.intent === "booking" || normalized.intent === "deposit_confirmation" ? "booking" :
    normalized.intent === "availability" ? "availability" :
    normalized.intent === "cancel" ? "cancel" :
    normalized.intent === "reschedule" ? "reschedule" :
    normalized.customer_name && state.intent === "booking" && state.status === "collecting_data" ? "booking" :
    normalized.confirmation.is_confirmation && state.intent === "booking" && state.status === "collecting_data" ? "booking" :
    normalized.confirmation.is_confirmation && state.intent !== "unknown" ? state.intent :
    "unknown";

  const rawNormalized = normalizeText(rawMessage);
  const multiTimes = fallbackIntent === "booking" ? parseMultipleTimes(rawNormalized) : null;

  // Resolve LLM-flagged ambiguity using explicit markers or prior offered slots
  let resolvedTime = normalized.time;
  let resolvedAmbiguous = normalized.time_ambiguous;
  if (normalized.time_ambiguous && normalized.time_options.length >= 2 && !multiTimes) {
    const morning = normalized.time_options[0];
    const evening = normalized.time_options[1];
    const meridiemHint = detectMeridiem(rawNormalized);
    if (meridiemHint === "morning") {
      resolvedTime = morning;
      resolvedAmbiguous = false;
    } else if (meridiemHint === "evening") {
      resolvedTime = evening;
      resolvedAmbiguous = false;
    } else if (state.last_offered_slots?.length === 2) {
      const offered = state.last_offered_slots;
      const bare = rawNormalized.match(/^\s*(\d{1,2})(?::(\d{2}))?\s*$/);
      if (bare) {
        const padded = `${bare[1].padStart(2, "0")}:${(bare[2] ?? "00").padStart(2, "0")}`;
        const match = offered.find((slot) => slot === padded);
        if (match) {
          resolvedTime = match;
          resolvedAmbiguous = false;
        }
      }
    }
  }

  const timeOptions = resolvedAmbiguous && !multiTimes
    ? {
        morning: normalized.time_options[0] ?? "08:00",
        evening: normalized.time_options[1] ?? "20:00",
      }
    : null;

  const contextualReservationId =
    normalized.contextual_reference.type === "explicit_reservation_id"
      ? normalized.reservation_id
      : null;

  return {
    intent: fallbackIntent,
    date: normalized.date,
    time: multiTimes ? multiTimes[0] : resolvedTime,
    multiTimes,
    sport: normalized.sport,
    customerName: normalized.customer_name,
    reservationId: normalized.reservation_id ?? contextualReservationId,
    courtQuantity: normalized.quantity,
    asksUnsupportedSport: Boolean(normalized.sport && normalizeText(normalized.sport).includes("futbol")),
    hasCorrection: normalized.intent === "reschedule" || normalized.action_requested === "reschedule_reservation",
    hasDepositProof: normalized.intent === "deposit_confirmation" || normalized.action_requested === "confirm_pending_reservation",
    timeAmbiguous: resolvedAmbiguous && !multiTimes,
    timeOptions,
    contextualReference: normalized.contextual_reference,
    confirmation: normalized.confirmation,
    actionRequested: normalized.action_requested,
    wantsExactSlot: Boolean(normalized.time),
  };
}

async function renderDepositLine(tenantId: string, db?: SupabaseClient): Promise<string> {
  const policy = await getBotPolicy(tenantId, db);
  if (!policy.requires_deposit) return "";

  if (policy.deposit_amount != null) return `Seña: $${policy.deposit_amount}.`;
  if (policy.deposit_percentage != null) return `Seña: ${policy.deposit_percentage}% del turno.`;
  return "La reserva requiere seña.";
}

export function parseBookingMessage(
  message: string,
  timezone: string,
  state?: AgentConversationState,
  now = new Date(),
): ParsedMessage {
  const normalized = normalizeText(message);
  const date = parseDate(normalized, timezone, now, state?.collected.date ?? null);
  const multiTimes = parseMultipleTimes(normalized);
  const timeResolution = parseTime(normalized, state);
  const time = multiTimes ? multiTimes[0] : timeResolution.time;
  const sport = parseSport(normalized);
  const customerName = parseCustomerName(message, state);
  const reservationId = parseReservationId(normalized);
  const courtQuantity = parseCourtQuantity(normalized);
  const asksUnsupportedSport = /\bfutbol\b|\bfutbol\s*7\b|\bf7\b|\bfutbol\s*5\b/.test(normalized);
  const hasCorrection = /\b(no+no+|queria|quise|me equivoque|era para)\b/.test(normalized);
  const hasDepositProof = /\b(comprobante|transferi|transferencia|pague|pagado|mande|envie|seña enviada|sena enviada)\b/.test(normalized) || normalized === "[image]";
  const wantsReserve = /\b(reserv\w*|agend\w*|anot\w*|sacar|hacer una reserva)\b/.test(normalized);
  const wantsCancel = /\b(cancel\w*|anula\w*|baja|dar de baja)\b/.test(normalized);
  const wantsReschedule = /\b(reprogram\w*|cambi\w*|mover|moveme|pasar|pasame)\b/.test(normalized);
  const asksReservationsList = /\b(que|qué|cuales|cu[aá]les|ver|listar|pasame|decime|tengo)\b/.test(normalized)
    && /\b(reserva|reservas|turno|turnos)\b/.test(normalized)
    && !wantsCancel
    && !wantsReschedule;
  const confirmation = parseFallbackConfirmation(normalized, state);
  const contextualReference = parseFallbackContextualReference(normalized);
  const confirmsPendingBooking =
    confirmation.is_confirmation &&
    state?.intent === "booking" &&
    state.status === "collecting_data";
  const asksAvailability = /\b(tenes|hay|dispo|disponible|disponibilidad|horario|horarios|turno|turnos|cancha)\b/.test(normalized);
  const followUpAvailability = /^\s*y\s+(para\s+)?(hoy|manana|el\s+\d{1,2})\??\s*$/.test(normalized);
  const suppliesMissingName = Boolean(customerName) && state?.intent === "booking" && state.status === "collecting_data";
  const suppliesMissingTime = Boolean(time || timeResolution.ambiguous) && state?.intent === "booking" && state.status === "collecting_data" && state.missing.includes("time");
  const suppliesDeposit = hasDepositProof && state?.intent === "booking" && state.missing.includes("deposit");
  const hasPendingAwaitingDeposit =
    state?.intent === "booking" &&
    state.status === "collecting_data" &&
    ((state.pending_deposit_reservation_ids?.length ?? 0) > 0 || state.missing?.includes("deposit"));
  const changesPendingSlot = hasPendingAwaitingDeposit && !hasDepositProof && Boolean(date || time || timeResolution.ambiguous);

  let intent: AgentIntent = "unknown";
  let actionRequested: ParsedMessage["actionRequested"] = null;
  if (asksReservationsList) actionRequested = "list_reservations";

  if (confirmation.target_action === "cancel") intent = "cancel";
  else if (confirmation.target_action === "reschedule") intent = "reschedule";
  else if (wantsCancel || (state?.intent === "cancel" && (date || time || reservationId))) intent = "cancel";
  else if (wantsReschedule || (state?.intent === "reschedule" && (date || time || reservationId))) intent = "reschedule";
  else if (wantsReserve || suppliesMissingName || suppliesMissingTime || suppliesDeposit || confirmsPendingBooking || changesPendingSlot || (hasCorrection && state?.intent === "booking")) intent = "booking";
  else if (asksAvailability || followUpAvailability) intent = "availability";

  return {
    intent,
    date,
    time,
    sport,
    customerName,
    reservationId,
    courtQuantity,
    asksUnsupportedSport,
    hasCorrection,
    hasDepositProof,
    timeAmbiguous: timeResolution.ambiguous && !multiTimes,
    timeOptions: multiTimes ? null : timeResolution.options,
    multiTimes,
    contextualReference,
    confirmation,
    actionRequested,
    wantsExactSlot: Boolean(time),
  };
}

async function renderAvailabilityReply(
  db: SupabaseClient,
  tenantId: string,
  timezone: string,
  date: string,
  sport: string,
  time: string | null,
): Promise<string> {
  const availability = new (await import("@/domain/booking/agentBookingServices")).AgentAvailabilityService(
    db,
    tenantId,
    timezone,
  );

  if (!time) return availability.check(date, sport);

  const resolution = await resolveScheduleTime(db, tenantId, timezone, date, time, sport);
  if (!resolution.ok) return resolution.reply;

  const courts = await availability.getAvailability(date, sport);
  const court = courts.find((candidate) => candidate.working_day);
  const slot = court?.slots.find((candidate) => candidate.time === resolution.time);

  if (!slot || !court) {
    const list = await availability.check(date, sport);
    return `Para ${date} a las ${resolution.time} está completo.\n${list}`;
  }

  return `Sí, para ${date} a las ${resolution.time} hay ${slot.free} cancha${slot.free !== 1 ? "s" : ""} disponible${slot.free !== 1 ? "s" : ""}. ¿A nombre de quién hago la reserva?`;
}

async function resolveCancellationCandidates(input: {
  booking: ReturnType<typeof createAgentBookingServices>;
  parsed: ParsedMessage;
  state: AgentConversationState;
  sport: string;
  date: string | null;
  time: string | null;
  reservationId: string | null;
  quantity: number;
}): Promise<CustomerReservation[]> {
  const reference = input.parsed.contextualReference;
  const scope = reference?.scope ?? "none";
  const referenceType = reference?.type ?? "none";
  const stateCandidateIds = input.state.candidate_reservation_ids ?? [];
  const lastListedIds = input.state.last_listed_reservation_ids ?? [];
  const lastCreatedIds = input.state.last_created_reservation_ids ?? [];
  const pendingIds = input.state.pending_deposit_reservation_ids?.length
    ? input.state.pending_deposit_reservation_ids
    : input.state.pending_reservation_ids ?? [];

  const referencedIdFallback = lastListedIds.length
    ? lastListedIds
    : stateCandidateIds.length
      ? stateCandidateIds
      : lastCreatedIds;

  let reservationIds: string[] = [];
  if (input.reservationId) reservationIds = [input.reservationId];
  else if (referenceType === "last_created_reservations") reservationIds = lastCreatedIds;
  else if (referenceType === "last_pending_reservations") reservationIds = pendingIds;
  else if (referenceType === "last_listed_reservations") reservationIds = referencedIdFallback;
  else if (referenceType === "customer_active_reservations") reservationIds = stateCandidateIds.length ? stateCandidateIds : lastCreatedIds;
  else if (scope === "last_group" || scope === "mentioned_quantity") {
    reservationIds = referencedIdFallback;
  }

  const all = scope === "all" || (input.parsed.actionRequested === "cancel_many_reservations" && referenceType === "customer_active_reservations");
  const quantity = scope === "mentioned_quantity" ? input.quantity : input.parsed.courtQuantity ?? null;
  const sportName = input.parsed.sport ? input.sport : null;

  if (reservationIds.length > 0) {
    return input.booking.reservations.findCancellationCandidates({
      reservation_ids: reservationIds,
      date: input.date,
      time: input.time,
      sport_name: sportName,
      quantity,
      all,
    });
  }

  return input.booking.reservations.findCancellationCandidates({
    reservation_id: input.reservationId,
    date: input.date,
    time: input.time,
    sport_name: sportName,
    quantity,
    all,
  });
}

async function resolveChangeCandidates(input: {
  booking: ReturnType<typeof createAgentBookingServices>;
  parsed: ParsedMessage;
  state: AgentConversationState;
  sport: string;
  date: string | null;
  time: string | null;
  reservationId: string | null;
  quantity: number;
}): Promise<CustomerReservation[]> {
  const reference = input.parsed.contextualReference;
  const scope = reference?.scope ?? "none";
  const referenceType = reference?.type ?? "none";
  const stateCandidateIds = input.state.candidate_reservation_ids ?? [];
  const lastListedIds = input.state.last_listed_reservation_ids ?? [];
  const lastCreatedIds = input.state.last_created_reservation_ids ?? [];
  const pendingIds = input.state.pending_deposit_reservation_ids?.length
    ? input.state.pending_deposit_reservation_ids
    : input.state.pending_reservation_ids ?? [];

  const referencedIdFallback = lastListedIds.length
    ? lastListedIds
    : stateCandidateIds.length
      ? stateCandidateIds
      : lastCreatedIds;

  let reservationIds: string[] = [];
  if (input.reservationId) reservationIds = [input.reservationId];
  else if (referenceType === "last_created_reservations") reservationIds = lastCreatedIds;
  else if (referenceType === "last_pending_reservations") reservationIds = pendingIds;
  else if (referenceType === "last_listed_reservations") reservationIds = referencedIdFallback;
  else if (referenceType === "customer_active_reservations") reservationIds = stateCandidateIds.length ? stateCandidateIds : lastCreatedIds;
  else if (scope === "last_group" || scope === "mentioned_quantity") {
    reservationIds = referencedIdFallback;
  }
  else if (input.state.intent === "reschedule" && stateCandidateIds.length > 0) reservationIds = stateCandidateIds;

  const all = scope === "all";
  const quantity = scope === "mentioned_quantity" ? input.quantity : input.parsed.courtQuantity ?? null;
  const sportName = input.parsed.sport ? input.sport : null;

  if (reservationIds.length > 0) {
    return input.booking.reservations.findChangeCandidates({
      reservation_ids: reservationIds,
      date: input.date,
      time: input.time,
      sport_name: sportName,
      quantity,
      all,
    });
  }

  if (!all && !input.date && !input.time && !sportName) return [];

  return input.booking.reservations.findChangeCandidates({
    reservation_id: input.reservationId,
    date: input.date,
    time: input.time,
    sport_name: sportName,
    quantity,
    all,
  });
}

async function getExactSlotFree(
  db: SupabaseClient,
  tenantId: string,
  timezone: string,
  date: string,
  time: string,
  sport: string,
): Promise<{ available: true; free: number } | { available: false }> {
  const { AgentAvailabilityService } = await import("@/domain/booking/agentBookingServices");
  const availability = new AgentAvailabilityService(db, tenantId, timezone);
  const courts = await availability.getAvailability(date, sport);
  const slot = courts.flatMap((court) => court.slots).find((candidate) => candidate.time === time);
  if (!slot || slot.free <= 0) return { available: false };
  return { available: true, free: slot.free };
}

async function resolveScheduleTime(
  db: SupabaseClient,
  tenantId: string,
  timezone: string,
  date: string,
  requestedTime: string,
  sport: string,
): Promise<
  | { ok: true; time: string }
  | { ok: false; reply: string; suggestedTime?: string }
> {
  const { AgentAvailabilityService } = await import("@/domain/booking/agentBookingServices");
  const availability = new AgentAvailabilityService(db, tenantId, timezone);
  const courts = await availability.fetchReservableCourts(sport);
  const court = courts[0];
  if (!court) return { ok: false, reply: `No encontré ${sport}.` };

  const normalizedTime = requestedTime;
  const slots = availability.getScheduleSlots(court, date, new Date());
  if (slots.includes(normalizedTime)) return { ok: true, time: normalizedTime };

  const suggested = closestTime(slots, normalizedTime);
  if (!suggested) {
    return {
      ok: false,
      reply: `No tenemos turnos reservables para ${sport} el ${date}.`,
    };
  }

  return {
    ok: false,
    suggestedTime: suggested,
    reply: `No tenemos turno a las ${normalizedTime}. El horario más cercano es ${suggested}.\n¿Querés que lo reserve para ese horario?`,
  };
}

function resolveSport(
  courts: ReservableCourt[],
  parsedSport: string | null,
  asksUnsupportedSport: boolean,
  state: AgentConversationState,
): { sport: string; reply?: string } {
  const defaultSport = courts[0]?.sport_name ?? parsedSport ?? "";
  if (!asksUnsupportedSport) return { sport: parsedSport ?? state.collected.sport ?? defaultSport };

  const hasRequestedSport = courts.some((court) => normalizeText(court.sport_name).includes(normalizeText(parsedSport ?? "")));
  if (hasRequestedSport && parsedSport) return { sport: parsedSport };

  return {
    sport: defaultSport,
    reply: `Por ahora solo gestiono reservas para ${defaultSport}. Si querés, puedo ayudarte con una cancha de ${defaultSport}.`,
  };
}

async function persistState(
  input: DeterministicRouterInput,
  state: AgentConversationState,
  parsed: ParsedMessage,
  patch: {
    intent?: AgentIntent;
    status?: AgentConversationState["status"];
    sport?: string | null;
    date?: string | null;
    time?: string | null;
    customerName?: string | null;
    reservationId?: string | null;
    courtQuantity?: number | null;
    missing?: string[];
    lastOfferedSlots?: string[];
    candidateReservationId?: string | null;
    candidateReservationIds?: string[];
    candidateReservations?: CustomerReservation[] | AgentReservationRef[];
    lastListedReservations?: CustomerReservation[] | AgentReservationRef[];
    lastCreatedReservationIds?: string[];
    pendingDepositReservationIds?: string[];
    pendingReservationIds?: string[];
    pendingConfirmation?: AgentConversationState["pending_confirmation"];
  },
): Promise<void> {
  const hasPatch = (key: keyof typeof patch) => Object.prototype.hasOwnProperty.call(patch, key);
  const candidateReservations = hasPatch("candidateReservations")
    ? normalizeReservationRefs(patch.candidateReservations ?? [], input.timezone)
    : state.candidate_reservations ?? [];
  const candidateReservationIds = patch.candidateReservationIds
    ?? (hasPatch("candidateReservations") || candidateReservations.length
      ? candidateReservations.map((reservation) => reservation.id)
      : state.candidate_reservation_ids ?? []);
  const lastListedReservations = hasPatch("lastListedReservations")
    ? normalizeReservationRefs(patch.lastListedReservations ?? [], input.timezone)
    : state.last_listed_reservations ?? [];
  const lastListedReservationIds = lastListedReservations.length
    ? lastListedReservations.map((reservation) => reservation.id)
    : state.last_listed_reservation_ids ?? [];
  const pendingDepositReservationIds = patch.pendingDepositReservationIds
    ?? patch.pendingReservationIds
    ?? state.pending_deposit_reservation_ids
    ?? state.pending_reservation_ids
    ?? [];
  const nextIntent = patch.intent ?? parsed.intent ?? state.intent;
  const nextStatus = patch.status ?? state.status;
  const operationFinished = nextStatus === "done";

  await saveAgentState(input.db, input.conversationId, {
    current_intent: nextIntent,
    intent: nextIntent,
    status: nextStatus,
    operation: {
      intent: nextIntent,
      status: nextStatus,
      action: parsed.actionRequested ?? state.operation?.action ?? null,
      updated_at: new Date().toISOString(),
    },
    collected: operationFinished
      ? {}
      : {
          sport: hasPatch("sport") ? patch.sport ?? null : parsed.sport ?? state.collected.sport ?? null,
          date: hasPatch("date") ? patch.date ?? null : parsed.date ?? state.collected.date ?? null,
          time: hasPatch("time") ? patch.time ?? null : parsed.time ?? state.collected.time ?? null,
          customer_name: hasPatch("customerName") ? patch.customerName ?? null : parsed.customerName ?? state.collected.customer_name ?? null,
          reservation_id: hasPatch("reservationId") ? patch.reservationId ?? null : parsed.reservationId ?? state.collected.reservation_id ?? null,
          court_quantity: hasPatch("courtQuantity") ? patch.courtQuantity ?? null : parsed.courtQuantity ?? state.collected.court_quantity ?? null,
        },
    missing: patch.missing ?? [],
    last_offered_slots: patch.lastOfferedSlots ?? state.last_offered_slots,
    candidate_reservation_id: patch.candidateReservationId ?? state.candidate_reservation_id,
    candidate_reservation_ids: candidateReservationIds,
    candidate_reservations: candidateReservations,
    last_listed_reservation_ids: lastListedReservationIds,
    last_listed_reservations: lastListedReservations,
    last_created_reservation_ids: patch.lastCreatedReservationIds ?? state.last_created_reservation_ids ?? [],
    pending_deposit_reservation_ids: pendingDepositReservationIds,
    pending_reservation_ids: pendingDepositReservationIds,
    pending_confirmation: hasPatch("pendingConfirmation") ? patch.pendingConfirmation ?? null : state.pending_confirmation ?? null,
  });
}

function pendingReservationMatchesSlot(
  state: AgentConversationState,
  date: string,
  time: string,
): boolean {
  // Use state.collected.date/time as the source of truth for the pending slot.
  // candidate_reservations.starts_at may be unset when refs were synthesized.
  if (state.collected.date && state.collected.time) {
    return state.collected.date === date && state.collected.time === time;
  }
  const candidates = state.candidate_reservations ?? [];
  return candidates.some((reservation) => {
    if (reservation.starts_at?.includes(date) && reservation.starts_at.includes(`${time}:`)) return true;
    if (reservation.label?.includes(date) && reservation.label.includes(time)) return true;
    return false;
  });
}

function buildPendingConfirmation(
  action: NonNullable<AgentConversationState["pending_confirmation"]>["action"],
  reservationIds: string[],
  details: {
    date?: string | null;
    time?: string | null;
    sport?: string | null;
    courtQuantity?: number | null;
    prompt?: string | null;
  },
): NonNullable<AgentConversationState["pending_confirmation"]> {
  return {
    action,
    reservation_ids: reservationIds,
    date: details.date ?? null,
    time: details.time ?? null,
    sport: details.sport ?? null,
    court_quantity: details.courtQuantity ?? null,
    prompt: details.prompt ?? null,
    created_at: new Date().toISOString(),
  };
}

function normalizeReservationRefs(
  reservations: Array<CustomerReservation | AgentReservationRef>,
  timezone: string,
): AgentReservationRef[] {
  return reservations.map((reservation) => {
    if ("starts_at" in reservation && "court_types" in reservation) {
      const courtType = Array.isArray(reservation.court_types)
        ? reservation.court_types[0]
        : reservation.court_types;
      const startsAtLabel = reservation.starts_at
        ? formatInTimeZone(new Date(reservation.starts_at), timezone, "dd/MM HH:mm")
        : null;
      const courtLabel = reservation.notes ?? null;
      const sport = courtType?.sport_name ?? null;
      return {
        id: reservation.id,
        label: startsAtLabel ? `${sport ?? "Cancha"}${courtLabel ? ` - ${courtLabel}` : ""} - ${startsAtLabel} hs` : reservation.id,
        starts_at: reservation.starts_at,
        ends_at: reservation.ends_at,
        status: reservation.status,
        sport_name: sport,
        court_label: courtLabel,
      };
    }

    return reservation;
  }).filter((reservation) => Boolean(reservation.id));
}

function reservationRefsFromIds(
  ids: string[],
  details: {
    sport?: string | null;
    date?: string | null;
    time?: string | null;
    status?: string | null;
  },
): AgentReservationRef[] {
  return ids.map((id, index) => ({
    id,
    label: [
      details.sport ?? "Cancha",
      ids.length > 1 ? `#${index + 1}` : null,
      details.date && details.time ? `${details.date} ${details.time} hs` : null,
    ].filter(Boolean).join(" - "),
    status: details.status ?? null,
    sport_name: details.sport ?? null,
  }));
}

async function logRouterEvent(
  input: DeterministicRouterInput,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await logAgentEvent(input.db, {
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    customerId: input.customerId,
    eventType,
    payload,
  });
}

function missingBookingReply(date: string | null, time: string | null): string {
  if (!date && !time) return "Dale. ¿Para qué día y horario querés reservar?";
  if (!date) return "Dale. ¿Para qué día sería?";
  return "Dale. ¿Para qué horario sería?";
}

function parseDate(normalized: string, timezone: string, now: Date, priorDate: string | null): string | null {
  if (/\bhoy\b/.test(normalized)) return formatInTimeZone(now, timezone, "yyyy-MM-dd");
  if (/\bpasado\s+manana\b/.test(normalized)) return formatInTimeZone(addDays(now, 2), timezone, "yyyy-MM-dd");
  if (/\bmanana\b/.test(normalized)) return formatInTimeZone(addDays(now, 1), timezone, "yyyy-MM-dd");

  const iso = normalized.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1];
  if (iso) return iso;

  const dayOnly = normalized.match(/\b(?:el|para el|dia)\s+(\d{1,2})\b/)?.[1];
  if (!dayOnly) return null;

  const day = Number(dayOnly);
  if (day < 1 || day > 31) return null;

  const localNow = toZonedTime(now, timezone);
  const base = priorDate ? toZonedTime(new Date(`${priorDate}T12:00:00Z`), timezone) : localNow;
  const candidate = setDate(base, day);
  const resolved = candidate < addDays(localNow, -1) ? addMonths(candidate, 1) : candidate;
  return formatInTimeZone(resolved, timezone, "yyyy-MM-dd");
}

function detectMeridiem(normalized: string): "morning" | "evening" | null {
  const morning = /\b(am|de\s+la\s+manana|por\s+la\s+manana|de\s+ma[nñ]ana|mediodia|medio\s+dia)\b/.test(normalized);
  const evening = /\b(pm|de\s+la\s+tarde|por\s+la\s+tarde|de\s+la\s+noche|por\s+la\s+noche|de\s+tarde|de\s+noche)\b/.test(normalized);
  if (morning && !evening) return "morning";
  if (evening && !morning) return "evening";
  return null;
}

function parseMultipleTimes(normalized: string): string[] | null {
  // Looks for patterns like "una a las 14, otra a las 16, ... y la ultima a las 21"
  // or simply "14, 16, 18 y 21" when in a list context (with "y" + numbers separated by commas)
  const cleaned = normalized.replace(/\s+/g, " ").trim();

  // Variant 1: explicit "una/otra a las X" chain
  const enumeratedMatches = [...cleaned.matchAll(
    /\b(?:una|otra|la\s+(?:ultima|primera|segunda|tercera|cuarta))\s+a\s+(?:las\s+)?(\d{1,2})(?::(\d{2}))?\s*(?:hs|horas?)?/g,
  )];

  if (enumeratedMatches.length >= 2) {
    const times = enumeratedMatches.map((m) => formatHourMinute(m[1], m[2]));
    return dedupeTimes(times);
  }

  // Variant 2: explicit comma-separated time list with at least 2 commas or "y"
  const inListContext = /\b(?:para\s+)?(?:las\s+)?(\d{1,2})(?::\d{2})?\s*(?:hs|horas?)?\s*[,;]/.test(cleaned);
  if (inListContext) {
    const allTimes = [...cleaned.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(?:hs|horas?)?\b/g)];
    if (allTimes.length >= 2) {
      const candidates = allTimes
        .filter((m) => {
          const hour = Number(m[1]);
          return hour >= 0 && hour <= 23;
        })
        .map((m) => formatHourMinute(m[1], m[2]));
      const dedup = dedupeTimes(candidates);
      if (dedup.length >= 2) return dedup;
    }
  }

  return null;
}

function formatHourMinute(hourStr: string, minStr?: string): string {
  return `${hourStr.padStart(2, "0")}:${(minStr ?? "00").padStart(2, "0")}`;
}

function dedupeTimes(times: string[]): string[] {
  return [...new Set(times)];
}

function parseTime(
  normalized: string,
  state?: AgentConversationState,
): { time: string | null; ambiguous: boolean; options: { morning: string; evening: string } | null } {
  const explicit = normalized.match(/\b(?:a\s+las|las|a\s+la|la)\s+(\d{1,2})(?::(\d{2}))?\b/);
  const plain = normalized.match(/\b(\d{1,2})(?::(\d{2}))?\s*(?:hs|h)\b/);
  const meridiem = normalized.match(/\b(\d{1,2})(?::(\d{2}))?\s*(?:am|pm)\b/);
  const collectingTime = state?.intent === "booking" && state.status === "collecting_data" && state.missing.includes("time");
  const shortReply = collectingTime ? normalized.match(/^\s*(\d{1,2})(?::(\d{2}))?\s*$/) : null;
  const match = explicit ?? plain ?? meridiem ?? shortReply;
  if (!match) return { time: null, ambiguous: false, options: null };

  const rawHour = match[1];
  const hour = Number(rawHour);
  const minutes = match[2] ? Number(match[2]) : 0;
  if (hour < 0 || hour > 23 || minutes < 0 || minutes > 59) return { time: null, ambiguous: false, options: null };

  const hasMorningMarker = /\b(am|mediodia|medio dia)\b/.test(normalized) || /\b(de|por)\s+la\s+manana\b/.test(normalized);
  const hasEveningMarker = /\b(pm|tarde|noche)\b/.test(normalized);
  const resolvedHour = hour <= 11 && hasEveningMarker ? hour + 12 : hour;
  const time = `${resolvedHour.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;

  const hasLeadingZero = rawHour.length === 2 && rawHour.startsWith("0");
  if (hour >= 1 && hour <= 11 && !hasLeadingZero && !hasMorningMarker && !hasEveningMarker) {
    return {
      time: null,
      ambiguous: true,
      options: {
        morning: `${hour.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`,
        evening: `${(hour + 12).toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`,
      },
    };
  }

  return { time, ambiguous: false, options: null };
}

function messageHasExplicitTime(message: string): boolean {
  const normalized = normalizeText(message);
  return /\b(?:a\s+las|las|a\s+la|la)\s+\d{1,2}(?::\d{2})?\b/.test(normalized)
    || /\b\d{1,2}(?::\d{2})?\s*(?:hs|h|am|pm)\b/.test(normalized);
}

function parseSport(normalized: string): string | null {
  if (/\bpadel\b/.test(normalized)) return "Pádel";
  if (/\bfutbol\b/.test(normalized)) return "Fútbol";
  return null;
}

function parseCustomerName(
  message: string,
  state?: AgentConversationState,
): string | null {
  const trimmed = message.trim();

  // Pattern 1: explicit prefixes ("a nombre de X", "soy X", "mi nombre es X")
  const explicit = trimmed.match(
    /(?:a\s+nombre\s+de|nombre\s+de|nombre\s+es|me\s+llamo|soy)\s+([a-zA-ZáéíóúÁÉÍÓÚñÑ\s]{2,60})/i,
  );
  if (explicit) {
    const cleaned = cleanNameCandidate(explicit[1]);
    if (cleaned) return cleaned;
  }

  // Pattern 2: bare "de X" when the bot just asked for the name
  const expectsName = state?.intent === "booking" &&
    state.status === "collecting_data" &&
    (state.missing?.includes("customer_name") || !state.collected.customer_name);

  if (expectsName) {
    const dePrefix = trimmed.match(/^(?:de|para|es\s+para|es)\s+([a-zA-ZáéíóúÁÉÍÓÚñÑ\s]{2,60})$/i);
    if (dePrefix) {
      const cleaned = cleanNameCandidate(dePrefix[1]);
      if (cleaned) return cleaned;
    }

    // Pattern 3: lone name when only name is missing — accept short alpha-only messages
    if (looksLikeBareName(trimmed)) {
      return cleanNameCandidate(trimmed);
    }
  }

  return null;
}

function looksLikeBareName(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2 || trimmed.length > 60) return false;
  // No digits, no operational/affirmation keywords
  if (/\d/.test(trimmed)) return false;
  const normalized = trimmed
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  if (/\b(reserv|agend|cancel|reprogram|cambi|mover|disponib|comprobante|transferi|sena|hola|si|no|ok|dale|gracias|chau|deport|cancha|padel|tenis)\b/.test(normalized)) {
    return false;
  }
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 5) return false;
  // Each word must be mostly alpha
  return words.every((word) => /^[a-zA-ZáéíóúÁÉÍÓÚñÑ'-]{2,}$/.test(word));
}

function cleanNameCandidate(raw: string): string | null {
  const stripped = raw
    .replace(/[.,!?].*$/, "")
    .replace(/\b(porfa(?:vor)?|gracias|please)\b/gi, "")
    .trim();
  if (stripped.length < 2 || stripped.length > 60) return null;
  return titleCase(stripped);
}

function parseCourtQuantity(normalized: string): number | null {
  const numeric = normalized.match(/\b(\d{1,2})\s+cancha/);
  if (numeric) return Math.max(1, Number(numeric[1]));
  if (/\buna\s+cancha\b/.test(normalized)) return 1;
  if (/\bdos\s+canchas\b/.test(normalized)) return 2;
  if (/\btres\s+canchas\b/.test(normalized)) return 3;
  if (/\bcuatro\s+canchas\b/.test(normalized)) return 4;

  // "esas 3", "estas 4" — must not match "las 08:00" (time) or "las 10" mid-time-phrase
  const grouped = normalized.match(/\b(?:esas?|estos?|estas?)\s+(\d{1,2})(?!\s*[:.]|\s+(?:hs|horas?|am|pm|hr))\b/);
  if (grouped) return Math.max(1, Number(grouped[1]));
  if (/\b(?:esas?|estos?|estas?)\s+dos\b/.test(normalized)) return 2;
  if (/\b(?:esas?|estos?|estas?)\s+tres\b/.test(normalized)) return 3;
  if (/\b(?:esas?|estos?|estas?)\s+cuatro\b/.test(normalized)) return 4;

  return null;
}

function parseReservationId(normalized: string): string | null {
  return normalized.match(/\b[a-f0-9]{8}(?:-[a-f0-9-]{4,})?\b/)?.[0] ?? null;
}

function defaultContextualReference(): NormalizedIntent["contextual_reference"] {
  return { type: "none", scope: "none", text: null };
}

function defaultConfirmation(): NormalizedIntent["confirmation"] {
  return { is_confirmation: false, is_rejection: false, target_action: "none" };
}

function parseFallbackConfirmation(
  normalized: string,
  state?: AgentConversationState,
): NormalizedIntent["confirmation"] {
  const isConfirmation = /\b(si|sí|dale|confirmo|confirmar|ok|okay|bueno|perfecto|correcto|esta bien|estaria bien)\b/.test(normalized);
  const isRejection = /\b(no|nono|nope|mejor no|dejalo|no canceles|no cambies)\b/.test(normalized);
  const targetAction =
    state?.status === "confirming" && (state.intent === "cancel" || state.intent === "reschedule" || state.intent === "booking")
      ? state.intent
      : "none";
  if (targetAction === "none") return defaultConfirmation();

  return {
    is_confirmation: isConfirmation,
    is_rejection: isRejection,
    target_action: targetAction,
  };
}

function parseFallbackContextualReference(normalized: string): NormalizedIntent["contextual_reference"] {
  if (/\btodas?\b/.test(normalized)) {
    return { type: "customer_active_reservations", scope: "all", text: "todas" };
  }

  if (/\b(esas?|estos?)\s+\d{1,2}\b/.test(normalized) || /\b(?:las|los)\s+(?:[1-9]|10)\b/.test(normalized)) {
    return { type: "last_listed_reservations", scope: "mentioned_quantity", text: normalized };
  }

  if (/\b(esas?|estos?|las mismas|los mismos)\b/.test(normalized)) {
    return { type: "last_listed_reservations", scope: "last_group", text: normalized };
  }

  if (/\bpendientes?\b/.test(normalized)) {
    return { type: "last_pending_reservations", scope: "last_group", text: normalized };
  }

  return defaultContextualReference();
}

function renderMultiReservationReply(
  replies: string[],
  context: {
    quantity: number;
    sport: string;
    date: string;
    time: string;
    customerName: string;
  },
): string {
  const successful = replies.filter((reply) => reply.startsWith("✅"));
  if (successful.length !== context.quantity) {
    return replies.at(-1) ?? "No pude crear la reserva.";
  }

  const ids = successful
    .map((reply) => reply.match(/ID:\s*([a-f0-9-]{8,})/i)?.[1])
    .filter(Boolean);

  if (context.quantity === 1) return successful[0];

  return `✅ Reserva tomada para ${context.quantity} canchas!\n` +
    `⚽ ${context.sport}\n` +
    `📅 ${context.date} a las ${context.time} hs\n` +
    `👤 ${context.customerName}\n` +
    ids.map((id, index) => `• Cancha ${index + 1}: ID ${id}`).join("\n");
}

async function handleMultiTimeBooking(params: {
  input: DeterministicRouterInput;
  state: AgentConversationState;
  parsed: ParsedMessage;
  booking: ReturnType<typeof createAgentBookingServices>;
  policy: Awaited<ReturnType<typeof getBotPolicy>>;
  date: string | null;
  sport: string;
  customerName: string | null;
  multiTimes: string[];
}): Promise<DeterministicRouterResult | null> {
  const { input, state, parsed, booking, policy, date, sport, customerName, multiTimes } = params;

  if (!date) {
    await persistState(input, state, parsed, {
      intent: "booking",
      status: "collecting_data",
      sport,
      date: null,
      time: multiTimes[0],
      customerName,
      missing: ["date"],
    });
    await saveAgentState(input.db, input.conversationId, {
      collected: { multi_times: multiTimes },
    });
    return {
      handled: true,
      reply: `Tengo ${multiTimes.length} horarios (${multiTimes.join(", ")}). ¿Para qué día son?`,
    };
  }

  if (!customerName) {
    await persistState(input, state, parsed, {
      intent: "booking",
      status: "collecting_data",
      sport,
      date,
      time: multiTimes[0],
      customerName: null,
      missing: ["customer_name"],
    });
    await saveAgentState(input.db, input.conversationId, {
      collected: { multi_times: multiTimes },
    });
    return {
      handled: true,
      reply: `Tengo ${multiTimes.length} horarios (${multiTimes.join(", ")}) para ${date}. ¿A nombre de quién?`,
    };
  }

  const status = policy.requires_deposit ? "pending" : "confirmed";
  const results: Array<{ time: string; ok: boolean; id: string | null; reply: string }> = [];

  for (const slotTime of multiTimes) {
    const slotResolution = await resolveScheduleTime(input.db, input.tenantId, input.timezone, date, slotTime, sport);
    if (!slotResolution.ok) {
      results.push({ time: slotTime, ok: false, id: null, reply: slotResolution.reply });
      continue;
    }
    const create = await booking.reservations.createReservation({
      customer_name: customerName,
      sport_name: sport,
      date,
      time: slotResolution.time,
      status,
    });
    results.push({
      time: slotResolution.time,
      ok: create.ok,
      id: create.id ?? null,
      reply: create.reply,
    });
  }

  const successful = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  const successIds = successful.map((r) => r.id).filter(Boolean) as string[];

  const depositLine = policy.requires_deposit ? await renderDepositLine(input.tenantId, input.db) : "";
  const okLines = successful.map((r) => `• ${r.time}`);
  const failLines = failed.map((r) => `• ${r.time}: ${stripLeadingIcon(r.reply)}`);

  const lines: string[] = [];
  if (successful.length) {
    const verb = status === "pending" ? "Reservas pendientes" : "Reservas confirmadas";
    lines.push(`${verb} para ${date} a nombre de ${customerName}:`);
    lines.push(...okLines);
    if (depositLine) lines.push(depositLine);
    if (status === "pending") lines.push("Cuando mandes el comprobante las marco como confirmadas.");
  }
  if (failed.length) {
    lines.push(successful.length ? "\nNo pude reservar:" : "No pude reservar ningún horario:");
    lines.push(...failLines);
  }
  const reply = lines.join("\n");

  await persistState(input, state, parsed, {
    intent: "booking",
    status: failed.length === 0 && status === "confirmed" ? "done" : "collecting_data",
    sport,
    date,
    time: successful[0]?.time ?? multiTimes[0],
    customerName,
    courtQuantity: successful.length || 1,
    missing: status === "pending" && successful.length ? ["deposit"] : [],
    pendingReservationIds: status === "pending" ? successIds : [],
    pendingDepositReservationIds: status === "pending" ? successIds : [],
    candidateReservationId: successIds[0] ?? null,
    candidateReservationIds: successIds,
    candidateReservations: reservationRefsFromIds(successIds, {
      sport,
      date,
      time: successful[0]?.time ?? multiTimes[0],
      status,
    }),
    lastCreatedReservationIds: successIds,
    pendingConfirmation: status === "pending" && successIds.length
      ? buildPendingConfirmation("confirm_deposit", successIds, {
          date,
          time: successful[0]?.time ?? multiTimes[0],
          sport,
          courtQuantity: successIds.length,
        })
      : null,
  });
  // Clear multi_times on success — they were materialized into reservations
  await saveAgentState(input.db, input.conversationId, {
    collected: { multi_times: null },
  });
  await logRouterEvent(input, "multi_time_booking_attempted", {
    date,
    sport,
    requestedTimes: multiTimes,
    successful: successful.map((r) => r.time),
    failed: failed.map((r) => ({ time: r.time, reply: r.reply })),
  });
  return { handled: true, reply };
}

function stripLeadingIcon(reply: string): string {
  return reply.replace(/^[^a-zA-Z0-9áéíóúñÁÉÍÓÚÑ]+/, "").trim();
}

function renderPendingDepositReply(context: {
  quantity: number;
  sport: string;
  date: string;
  time: string;
  customerName: string;
  depositLine: string;
}): string {
  return `Reserva pendiente para ${context.quantity} cancha${context.quantity !== 1 ? "s" : ""} de ${context.sport}.\n` +
    `📅 ${context.date} a las ${context.time} hs\n` +
    `👤 ${context.customerName}\n` +
    `${context.depositLine || "Para confirmarla hace falta seña."}\n` +
    "Cuando la envíes, mandame el comprobante y la marco como confirmada.";
}

function closestTime(slots: string[], requested: string): string | null {
  if (!slots.length) return null;
  const requestedMinutes = minutesOfDay(requested);
  return slots
    .map((slot) => ({ slot, distance: Math.abs(minutesOfDay(slot) - requestedMinutes) }))
    .sort((a, b) => a.distance - b.distance)[0]?.slot ?? null;
}

function minutesOfDay(time: string): number {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

function extractSlotTimes(reply: string): string[] {
  return [...reply.matchAll(/\b(\d{2}:\d{2})\b/g)].map((match) => match[1]);
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\bmama\b/g, "manana");
}
