export type ReservationStatus = "pending" | "confirmed" | "cancelled" | "completed";
export type ReservationSource = "whatsapp" | "panel" | "api";
export type ConversationStatus = "active" | "closed" | "abandoned";
export type ConversationChannel = "whatsapp";
export type MessageDirection = "inbound" | "outbound";
export type IntegrationProvider = "google_calendar" | "google_sheets";

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  active: boolean;
  created_at: string;
}

export interface Venue {
  id: string;
  tenant_id: string;
  name: string;
  address: string | null;
  active: boolean;
  created_at: string;
}

export interface Sport {
  id: string;
  tenant_id: string;
  name: string;
  default_duration_minutes: number;
  created_at: string;
}

export interface Court {
  id: string;
  tenant_id: string;
  venue_id: string;
  sport_id: string;
  name: string;
  capacity: number | null;
  active: boolean;
  created_at: string;
}

export interface BusinessHours {
  id: string;
  tenant_id: string;
  venue_id: string;
  day_of_week: number; // 0=Sunday, 6=Saturday
  open_time: string; // HH:mm
  close_time: string; // HH:mm
  slot_duration_minutes: number;
}

export interface Closure {
  id: string;
  tenant_id: string;
  venue_id: string;
  court_id: string | null;
  starts_at: string;
  ends_at: string;
  reason: string | null;
}

export interface Customer {
  id: string;
  tenant_id: string;
  name: string | null;
  phone_e164: string;
  notes: string | null;
  created_at: string;
}

export interface Conversation {
  id: string;
  tenant_id: string;
  customer_id: string;
  channel: ConversationChannel;
  external_chat_id: string;
  status: ConversationStatus;
  last_message_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  direction: MessageDirection;
  content: string;
  raw_payload: Record<string, unknown>;
  created_at: string;
}

export interface Reservation {
  id: string;
  tenant_id: string;
  venue_id: string;
  court_id: string;
  customer_id: string;
  sport_id: string;
  starts_at: string;
  ends_at: string;
  status: ReservationStatus;
  source: ReservationSource;
  external_event_id: string | null;
  external_sheet_row_id: string | null;
  notes: string | null;
  created_at: string;
}

export interface ReservationAuditLog {
  id: string;
  reservation_id: string;
  action: string;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface IntegrationSettings {
  id: string;
  tenant_id: string;
  provider: IntegrationProvider;
  config: Record<string, unknown>;
  active: boolean;
}

export interface AiSession {
  id: string;
  conversation_id: string;
  state: Record<string, unknown>;
  extracted_data: ExtractedBookingData | null;
  missing_fields: string[];
  updated_at: string;
}

export interface ExtractedBookingData {
  intent: "create_reservation" | "query_availability" | "cancel_reservation" | "reschedule_reservation" | "unknown";
  sport: string | null;
  venue: string | null;
  date: string | null; // YYYY-MM-DD
  time: string | null; // HH:mm
  duration_minutes: number | null;
  customer_name: string | null;
  needs_follow_up: boolean;
  missing_fields: string[];
}
