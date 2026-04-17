import OpenAI from "openai";
import { ExtractedBookingSchema, REQUIRED_FIELDS_BY_INTENT, type ExtractedBooking } from "./schemas";

const SYSTEM_PROMPT = `Eres un asistente que analiza mensajes de WhatsApp de clientes que quieren reservar canchas deportivas.
Tu tarea es extraer datos estructurados del mensaje del usuario.
Hoy es {TODAY}. La zona horaria del negocio es {TIMEZONE}.

Reglas:
- Si el usuario dice "mañana", calcula la fecha relativa a hoy.
- Si dice "hoy", usa la fecha de hoy.
- Las fechas deben estar en formato YYYY-MM-DD.
- Los horarios en formato HH:mm (24hs).
- Si no podés determinar un campo, usá null.
- Devolvé SOLO JSON válido, sin explicaciones ni markdown.

JSON esperado:
{
  "intent": "create_reservation" | "query_availability" | "cancel_reservation" | "reschedule_reservation" | "unknown",
  "sport": string | null,
  "venue": string | null,
  "date": string | null,
  "time": string | null,
  "duration_minutes": number | null,
  "customer_name": string | null,
  "needs_follow_up": boolean,
  "missing_fields": string[]
}`;

export class IntentExtractor {
  private readonly client: OpenAI;

  constructor() {
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }

  async extract(
    userMessage: string,
    timezone = "America/Argentina/Buenos_Aires",
  ): Promise<ExtractedBooking> {
    const today = new Date().toISOString().slice(0, 10);
    const systemPrompt = SYSTEM_PROMPT.replace("{TODAY}", today).replace("{TIMEZONE}", timezone);

    const response = await this.client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    });

    const raw = JSON.parse(response.choices[0]?.message?.content ?? "{}");
    const parsed = ExtractedBookingSchema.parse(raw);

    // Compute missing_fields if not provided by model
    const required = REQUIRED_FIELDS_BY_INTENT[parsed.intent] ?? [];
    const missing = required.filter((f) => parsed[f as keyof ExtractedBooking] === null);
    parsed.missing_fields = missing;
    parsed.needs_follow_up = missing.length > 0;

    return parsed;
  }

  async generateReply(
    context: string,
    missingFields: string[],
    timezone = "America/Argentina/Buenos_Aires",
  ): Promise<string> {
    const fieldLabels: Record<string, string> = {
      sport: "el deporte",
      date: "la fecha",
      time: "el horario",
      venue: "la sede",
      customer_name: "tu nombre",
      duration_minutes: "la duración del turno",
    };

    const missing = missingFields.map((f) => fieldLabels[f] ?? f);
    const needsStr =
      missing.length > 0
        ? `Necesito que me indiques: ${missing.join(", ")}.`
        : "";

    const prompt = `Eres un asistente simpático de reservas deportivas. Contexto: ${context}. ${needsStr} Respondé en español rioplatense, de forma breve y amigable.`;

    const response = await this.client.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.7,
      messages: [{ role: "user", content: prompt }],
    });

    return response.choices[0]?.message?.content?.trim() ?? "¿En qué te puedo ayudar?";
  }
}
