import { SupabaseClient } from "@supabase/supabase-js";
import type { Customer } from "@/types/database";

export class CustomerRepository {
  constructor(private readonly db: SupabaseClient) {}

  async upsertByPhone(tenantId: string, phone: string, name?: string): Promise<Customer> {
    const { data, error } = await this.db
      .from("customers")
      .upsert(
        { tenant_id: tenantId, phone_e164: phone, name: name ?? null },
        { onConflict: "tenant_id,phone_e164", ignoreDuplicates: false },
      )
      .select()
      .single();

    if (error) throw error;
    return data as Customer;
  }

  async findById(id: string): Promise<Customer | null> {
    const { data } = await this.db.from("customers").select("*").eq("id", id).single();
    return data as Customer | null;
  }
}
