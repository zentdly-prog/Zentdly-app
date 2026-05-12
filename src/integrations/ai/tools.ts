import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createAgentBookingServices,
  type CalendarSyncReservation,
} from "@/domain/booking/agentBookingServices";
import { computeDepositAmount, formatMoney } from "@/domain/booking/reservationRules";
import { getBotPolicy } from "@/lib/actions/policies";

export interface AgentToolDeps {
  db: SupabaseClient;
  tenantId: string;
  customerId: string;
  customerPhone: string;
  timezone: string;
  conversationId: string;
  calendarSync?: {
    sync(reservation: CalendarSyncReservation, customerName: string, customerPhone: string, tz: string): Promise<void>;
    delete(externalEventId: string | null, tz: string): Promise<void>;
  };
}

export const AGENT_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "check_availability",
      description:
        "Consulta los horarios disponibles para una fecha. Devuelve texto con los slots libres y cuántas canchas hay en cada uno. Usá esta tool ANTES de crear una reserva si el cliente no especificó horario, o si tenés dudas.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "Fecha en formato YYYY-MM-DD" },
          sport: { type: "string", description: "Deporte (opcional, ej: 'Pádel'). Si no se especifica, muestra todos." },
        },
        required: ["date"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_reservation",
      description:
        "Crea una reserva nueva. Si la política del negocio requiere seña, queda como 'pending' hasta que el cliente mande el comprobante. Si quantity > 1, crea esa cantidad de reservas en el mismo horario (canchas distintas).",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "YYYY-MM-DD" },
          time: { type: "string", description: "HH:mm 24hs" },
          customer_name: { type: "string", description: "Nombre del cliente" },
          sport: { type: "string", description: "Nombre del deporte (ej: 'Pádel')" },
          quantity: { type: "integer", description: "Cantidad de canchas, default 1" },
        },
        required: ["date", "time", "customer_name", "sport"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "confirm_deposit",
      description:
        "Confirma una reserva pendiente cuando el cliente mandó el comprobante de la seña. Si no se especifican reservation_ids, confirma todas las pendientes recientes del cliente.",
      parameters: {
        type: "object",
        properties: {
          reservation_ids: {
            type: "array",
            items: { type: "string" },
            description: "IDs de las reservas a confirmar. Opcional — sin esto confirma todas las pendientes.",
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_my_reservations",
      description:
        "Devuelve la lista de reservas activas (confirmed + pending) del cliente actual. Usalo cuando el cliente pregunta '¿qué reservas tengo?' o cuando necesitás identificar una reserva para cancelar/reagendar.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_reservation",
      description:
        "Cancela una o más reservas. Podés pasar reservation_ids (IDs de 8 chars o completos), o fecha+horario para identificar, o all=true para cancelar todas las reservas activas del cliente.",
      parameters: {
        type: "object",
        properties: {
          reservation_ids: { type: "array", items: { type: "string" } },
          date: { type: "string", description: "YYYY-MM-DD (alternativa a reservation_ids)" },
          time: { type: "string", description: "HH:mm (alternativa a reservation_ids)" },
          all: { type: "boolean", description: "Cancela todas las reservas activas del cliente" },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reschedule_reservation",
      description:
        "Mueve una reserva existente a otro día/horario. Necesitás reservation_id O fecha+horario actual para identificarla, más new_date y new_time.",
      parameters: {
        type: "object",
        properties: {
          reservation_id: { type: "string" },
          current_date: { type: "string", description: "YYYY-MM-DD de la reserva actual (alternativa a reservation_id)" },
          current_time: { type: "string", description: "HH:mm de la reserva actual" },
          new_date: { type: "string", description: "YYYY-MM-DD del nuevo horario" },
          new_time: { type: "string", description: "HH:mm del nuevo horario" },
        },
        required: ["new_date", "new_time"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_business_info",
      description:
        "Información del negocio: precios, horarios, deportes, dirección, link de Maps, Instagram, web, email, datos de transferencia (alias y titular) para pagar la seña, política de seña, política de cancelación. Usalo cuando el cliente pregunta cualquier dato del comercio o cuando estás por pedir el comprobante de seña y necesitás dar el alias.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            enum: ["price", "hours", "sports", "address", "deposit", "payment_method", "cancellation", "social", "all"],
            description: "Tema sobre el que quiere saber. 'payment_method' devuelve alias/titular/banco para pasarle al cliente al pedir seña. 'social' devuelve Instagram/web/email.",
          },
        },
        required: ["topic"],
        additionalProperties: false,
      },
    },
  },
];

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  deps: AgentToolDeps,
): Promise<string> {
  const booking = createAgentBookingServices({
    db: deps.db,
    tenantId: deps.tenantId,
    customerId: deps.customerId,
    customerPhone: deps.customerPhone,
    timezone: deps.timezone,
    calendarSync: deps.calendarSync,
  });

  switch (name) {
    case "check_availability": {
      const date = String(args.date);
      const sport = args.sport ? String(args.sport) : undefined;
      return booking.availability.check(date, sport);
    }

    case "create_reservation": {
      const quantity = Math.max(1, Math.min(10, Number(args.quantity ?? 1)));
      const baseArgs: Record<string, string> = {
        date: String(args.date),
        time: String(args.time),
        customer_name: String(args.customer_name),
        sport_name: String(args.sport),
      };
      const results: string[] = [];
      const createdIds: string[] = [];
      let lastStatus: string | undefined;
      for (let i = 0; i < quantity; i++) {
        const r = await booking.reservations.createReservation(baseArgs);
        results.push(r.reply);
        if (r.id) createdIds.push(r.id);
        if (r.status) lastStatus = r.status;
        if (!r.ok) break;
      }
      const successful = results.filter((_, i) => i < createdIds.length);
      if (successful.length === quantity) {
        return `✅ ${successful.length} reserva(s) creada(s) (status: ${lastStatus}). IDs: ${createdIds.map((id) => id.slice(0, 8)).join(", ")}.`;
      }
      return results.join("\n---\n");
    }

    case "confirm_deposit": {
      const reservationIds = Array.isArray(args.reservation_ids)
        ? (args.reservation_ids as string[]).filter(Boolean)
        : undefined;
      return booking.reservations.confirmPending({ reservation_ids: reservationIds });
    }

    case "list_my_reservations": {
      const active = await booking.reservations.listActive();
      if (!active.length) return "El cliente no tiene reservas activas a su nombre.";
      return booking.reservations.formatReservations(active);
    }

    case "cancel_reservation": {
      const reservationIds = Array.isArray(args.reservation_ids)
        ? (args.reservation_ids as string[]).filter(Boolean)
        : undefined;
      const all = Boolean(args.all);

      // Resolve which reservations to cancel
      const candidates = await booking.reservations.findCancellationCandidates({
        reservation_ids: reservationIds,
        reservation_id: reservationIds?.[0],
        date: args.date ? String(args.date) : null,
        time: args.time ? String(args.time) : null,
        sport_name: null,
        quantity: null,
        all,
      });

      if (!candidates.length) {
        return "No encontré reservas que coincidan con eso. Pedile al cliente que aclare cuál.";
      }

      const ids = candidates.map((r) => r.id);
      const result = await booking.reservations.cancelMany(ids);
      return result.reply;
    }

    case "reschedule_reservation": {
      const newDate = String(args.new_date);
      const newTime = String(args.new_time);
      const reservationId = args.reservation_id ? String(args.reservation_id) : null;

      // Resolve the reservation to move
      let candidates: Awaited<ReturnType<typeof booking.reservations.findCancellationCandidates>> = [];
      if (reservationId) {
        candidates = await booking.reservations.findCancellationCandidates({
          reservation_id: reservationId,
          date: null,
          time: null,
          sport_name: null,
          quantity: null,
          all: false,
        });
      } else if (args.current_date && args.current_time) {
        candidates = await booking.reservations.findCancellationCandidates({
          reservation_id: null,
          date: String(args.current_date),
          time: String(args.current_time),
          sport_name: null,
          quantity: null,
          all: false,
        });
      }

      if (!candidates.length) {
        return "No encontré la reserva original para mover. Pedile al cliente el ID o día+horario actual.";
      }

      const result = await booking.reservations.rescheduleMany(
        candidates.map((r) => r.id),
        newDate,
        newTime,
      );
      return result.reply;
    }

    case "get_business_info": {
      return getBusinessInfo(deps, String(args.topic));
    }

    default:
      return `Tool desconocida: ${name}`;
  }
}

async function getBusinessInfo(deps: AgentToolDeps, topic: string): Promise<string> {
  const sections: string[] = [];

  // Most topics need the tenant row anyway — fetch once.
  const { data: tenant } = await deps.db
    .from("tenants")
    .select("name, address, maps_url, instagram, website, contact_email, bank_alias, bank_holder_name, bank_name")
    .eq("id", deps.tenantId)
    .single();
  const t = tenant as {
    name: string;
    address: string | null;
    maps_url: string | null;
    instagram: string | null;
    website: string | null;
    contact_email: string | null;
    bank_alias: string | null;
    bank_holder_name: string | null;
    bank_name: string | null;
  } | null;

  if (topic === "all" || topic === "address") {
    if (t?.address) sections.push(`Dirección: ${t.address}`);
    if (t?.maps_url) sections.push(`Mapa: ${t.maps_url}`);
  }

  if (topic === "all" || topic === "social") {
    if (t?.instagram) sections.push(`Instagram: @${t.instagram.replace(/^@/, "")}`);
    if (t?.website) sections.push(`Web: ${t.website}`);
    if (t?.contact_email) sections.push(`Email: ${t.contact_email}`);
  }

  if (topic === "all" || topic === "payment_method") {
    const bankBits: string[] = [];
    if (t?.bank_alias) bankBits.push(`Alias / CBU: ${t.bank_alias}`);
    if (t?.bank_holder_name) bankBits.push(`A nombre de: ${t.bank_holder_name}`);
    if (t?.bank_name) bankBits.push(`Banco: ${t.bank_name}`);
    if (bankBits.length) {
      sections.push(`Datos de transferencia para la seña:\n${bankBits.join("\n")}`);
    } else if (topic === "payment_method") {
      sections.push("Todavía no tengo cargados los datos bancarios. Pedíselos al complejo.");
    }
  }

  if (topic === "all" || topic === "sports" || topic === "price" || topic === "hours") {
    const { data: courts } = await deps.db
      .from("court_types")
      .select("sport_name, price_per_slot, open_time, close_time, quantity")
      .eq("tenant_id", deps.tenantId)
      .eq("active", true);

    if (courts?.length) {
      if (topic === "all" || topic === "sports") {
        sections.push(`Deportes: ${courts.map((c) => c.sport_name).join(", ")}.`);
      }
      if (topic === "all" || topic === "price") {
        const prices = courts.map((c) =>
          c.price_per_slot != null ? `${c.sport_name}: ${formatMoney(c.price_per_slot as number)}` : `${c.sport_name}: precio a consultar`,
        );
        sections.push(`Precios por turno: ${prices.join(" · ")}.`);
      }
      if (topic === "all" || topic === "hours") {
        const hours = courts.map(
          (c) => `${c.sport_name}: ${(c.open_time as string).slice(0, 5)} a ${(c.close_time as string).slice(0, 5)}`,
        );
        sections.push(`Horarios: ${hours.join(" · ")}.`);
      }
    }
  }

  if (topic === "all" || topic === "deposit" || topic === "cancellation") {
    const policy = await getBotPolicy(deps.tenantId, deps.db);
    if (topic === "all" || topic === "deposit") {
      if (!policy.requires_deposit) {
        sections.push("Seña: no se requiere.");
      } else if (policy.deposit_amount != null) {
        sections.push(`Seña: ${formatMoney(policy.deposit_amount)}.`);
      } else if (policy.deposit_percentage != null) {
        // Compute per sport with prices
        const { data: courts } = await deps.db
          .from("court_types")
          .select("sport_name, price_per_slot")
          .eq("tenant_id", deps.tenantId)
          .eq("active", true);
        const withPrice = (courts ?? []).filter((c) => c.price_per_slot != null);
        if (withPrice.length) {
          const lines = withPrice.map((c) => {
            const amount = computeDepositAmount(policy, c.price_per_slot as number);
            return `${c.sport_name}: ${amount != null ? formatMoney(amount) : "consultar"}`;
          });
          sections.push(`Seña (${policy.deposit_percentage}% del turno): ${lines.join(" · ")}.`);
        } else {
          sections.push(`Seña: ${policy.deposit_percentage}% del turno.`);
        }
      }
    }
    if (topic === "all" || topic === "cancellation") {
      const hours = policy.cancellation_min_hours ?? 0;
      sections.push(hours > 0 ? `Cancelación: hasta ${hours} hs antes del turno.` : "Cancelación: sin límite.");
    }
  }

  return sections.join("\n") || "No tengo esa información cargada todavía.";
}
