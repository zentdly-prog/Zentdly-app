import { createServerClient } from "@/infrastructure/supabase/server";
import { IntentExtractor } from "@/integrations/ai/intentExtractor";
import { WhatsAppSender } from "./sender";
import { ConversationHandler } from "@/domain/conversation/conversationHandler";
import { CustomerRepository } from "@/infrastructure/repositories/customerRepository";
import { ReservationRepository } from "@/infrastructure/repositories/reservationRepository";
import { AvailabilityRepository } from "@/infrastructure/repositories/availabilityRepository";
import { AvailabilityService } from "@/domain/booking/availabilityService";
import { ReservationService } from "@/domain/booking/reservationService";
import { formatLocal } from "@/lib/utils/date";
import type { WhatsAppIncomingMessage } from "./types";

export async function handleIncomingMessage(
  msg: WhatsAppIncomingMessage,
  tenantId: string,
  timezone: string,
): Promise<void> {
  const db = createServerClient();
  const sender = new WhatsAppSender();
  const extractor = new IntentExtractor();
  const conversationHandler = new ConversationHandler(db);
  const customerRepo = new CustomerRepository(db);
  const reservationRepo = new ReservationRepository(db);
  const availRepo = new AvailabilityRepository(db);
  const availService = new AvailabilityService(availRepo, reservationRepo);
  const reservationService = new ReservationService(reservationRepo, customerRepo, availService);

  await sender.markRead(msg.messageId);

  // Upsert customer
  const customer = await customerRepo.upsertByPhone(tenantId, `+${msg.from}`);

  // Get or create conversation
  const conversation = await conversationHandler.getOrCreate(tenantId, msg.from, customer.id);

  // Save inbound message
  await conversationHandler.saveMessage(conversation.id, "inbound", msg.text, {
    message_id: msg.messageId,
  });

  // Load existing session
  const session = await conversationHandler.getSession(conversation.id);

  // Extract intent from message
  const extracted = await extractor.extract(msg.text, timezone);

  // Merge with prior context
  const merged = conversationHandler.mergeExtracted(session?.extracted_data ?? null, extracted);

  let replyText: string;

  if (merged.intent === "create_reservation" && !merged.needs_follow_up) {
    // All data available — attempt booking
    try {
      // Find first available court for the sport
      // In a real scenario you'd resolve court_id and venue_id from sport name + venue name
      // Here we illustrate the flow; real resolution requires a lookup service
      replyText = `¡Perfecto! Voy a intentar confirmar tu reserva de ${merged.sport} para el ${merged.date} a las ${merged.time}. Un momento...`;

      // Mark session as done
      await conversationHandler.upsertSession(conversation.id, merged, [], { step: "confirming" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Error desconocido";
      replyText = `Ocurrió un error al procesar tu reserva: ${message} ¿Querés intentarlo de nuevo?`;
    }
  } else if (merged.intent === "cancel_reservation") {
    replyText = `Entendido, quieres cancelar una reserva. ¿Me podés dar el día y horario de la reserva que querés cancelar?`;
    await conversationHandler.upsertSession(conversation.id, merged, merged.missing_fields, {
      step: "collecting",
    });
  } else if (merged.intent === "query_availability") {
    if (merged.date && merged.sport) {
      replyText = `Chequeando disponibilidad para ${merged.sport} el ${merged.date}... Dame un segundo.`;
    } else {
      replyText = await extractor.generateReply(
        `El cliente preguntó por disponibilidad`,
        merged.missing_fields,
        timezone,
      );
    }
    await conversationHandler.upsertSession(conversation.id, merged, merged.missing_fields, {
      step: "collecting",
    });
  } else {
    // Still missing data — ask for it
    replyText = await extractor.generateReply(
      `El cliente quiere hacer una reserva y dijo: "${msg.text}"`,
      merged.missing_fields,
      timezone,
    );
    await conversationHandler.upsertSession(conversation.id, merged, merged.missing_fields, {
      step: "collecting",
    });
  }

  await sender.sendText(msg.from, replyText);
  await conversationHandler.saveMessage(conversation.id, "outbound", replyText);
}
