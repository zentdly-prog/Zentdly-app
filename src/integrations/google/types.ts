import type { Reservation } from "@/types/database";

export interface SyncReservationResult {
  externalId: string;
}

export interface GoogleIntegrationProvider {
  syncReservation(reservation: Reservation, customerName: string, customerPhone: string): Promise<SyncReservationResult>;
  deleteReservation(externalId: string): Promise<void>;
}
