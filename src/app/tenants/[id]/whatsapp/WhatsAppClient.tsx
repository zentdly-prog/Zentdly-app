"use client";

import { useActionState, useState, useTransition } from "react";
import { saveWhatsAppConfig, getEvolutionQR } from "@/lib/actions/whatsapp";
import { SubmitButton } from "@/components/SubmitButton";
import { Alert } from "@/components/Alert";

type Config = {
  provider?: string;
  evolution_api_url?: string | null;
  evolution_api_key?: string | null;
  evolution_instance_name?: string | null;
  meta_phone_number_id?: string | null;
  meta_access_token?: string | null;
  meta_verify_token?: string | null;
  meta_app_secret?: string | null;
  meta_business_id?: string | null;
} | null;

const DEFAULT_EVOLUTION_URL = "https://evolution-api-6ufp.onrender.com";
const DEFAULT_EVOLUTION_KEY = "zentdly-evolution-key-2024";

export default function WhatsAppClient({
  tenantId,
  initialConfig,
}: {
  tenantId: string;
  initialConfig: Config;
}) {
  const [provider, setProvider] = useState<"evolution" | "meta">(
    (initialConfig?.provider as "evolution" | "meta") ?? "evolution"
  );
  const [qr, setQr] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [loadingQr, startQr] = useTransition();
  const [state, action] = useActionState(saveWhatsAppConfig, null);

  const webhookUrl = `https://zentdlyw.vercel.app/api/webhooks/whatsapp`;

  function handleGetQr() {
    startQr(async () => {
      setQr(null);
      setQrError(null);
      setConnected(false);
      const res = await getEvolutionQR(tenantId);
      if (res.error) setQrError(res.error);
      else if (res.connected) setConnected(true);
      else if (res.qr) setQr(res.qr);
    });
  }

  return (
    <div className="max-w-xl">
      <h2 className="text-lg font-semibold text-gray-900 mb-1">WhatsApp</h2>
      <p className="text-sm text-gray-500 mb-6">
        Conectá WhatsApp a este negocio para que el bot pueda recibir y enviar mensajes.
      </p>

      {/* Provider toggle */}
      <div className="flex gap-2 mb-6">
        <button
          type="button"
          onClick={() => setProvider("evolution")}
          className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium border transition-colors ${
            provider === "evolution"
              ? "bg-green-600 text-white border-green-600"
              : "bg-white text-gray-600 border-gray-300 hover:border-gray-400"
          }`}
        >
          Evolution API (no oficial)
        </button>
        <button
          type="button"
          onClick={() => setProvider("meta")}
          className={`flex-1 py-2 px-4 rounded-lg text-sm font-medium border transition-colors ${
            provider === "meta"
              ? "bg-green-600 text-white border-green-600"
              : "bg-white text-gray-600 border-gray-300 hover:border-gray-400"
          }`}
        >
          Meta Cloud API (oficial)
        </button>
      </div>

      <form action={action} className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <input type="hidden" name="tenant_id" value={tenantId} />
        <input type="hidden" name="provider" value={provider} />

        {state?.error && <Alert type="error" message={state.error} />}
        {state?.ok && <Alert type="success" message="Configuración guardada." />}

        {provider === "evolution" ? (
          <>
            <div className="text-xs text-gray-500 bg-amber-50 border border-amber-200 rounded-lg p-3">
              Conecta WhatsApp escaneando un QR desde tu celular. El servidor de Evolution API ya está corriendo — solo necesitás darle un nombre a la instancia y escanear.
            </div>

            <Field
              name="evolution_api_url"
              label="URL del servidor"
              defaultValue={initialConfig?.evolution_api_url ?? DEFAULT_EVOLUTION_URL}
            />
            <Field
              name="evolution_api_key"
              label="API Key"
              type="password"
              defaultValue={initialConfig?.evolution_api_key ?? DEFAULT_EVOLUTION_KEY}
            />
            <Field
              name="evolution_instance_name"
              label="Nombre de instancia"
              placeholder="ej: complejo-norte"
              defaultValue={initialConfig?.evolution_instance_name ?? ""}
              hint="Usá el nombre del negocio en minúsculas y sin espacios."
            />

            <div className="flex gap-3 pt-2">
              <button
                type="button"
                onClick={handleGetQr}
                disabled={loadingQr}
                className="flex-1 py-2 px-4 text-sm font-medium border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
              >
                {loadingQr ? "Generando QR..." : "Generar QR"}
              </button>
              <SubmitButton label="Guardar" />
            </div>

            {qrError && <Alert type="error" message={qrError} />}

            {connected && (
              <div className="flex items-center gap-2 text-green-700 bg-green-50 border border-green-200 rounded-lg p-3 text-sm">
                <span className="text-lg">✓</span>
                <span>WhatsApp ya está conectado en esta instancia.</span>
              </div>
            )}

            {qr && (
              <div className="flex flex-col items-center gap-3 pt-2 pb-1">
                <p className="text-sm text-gray-600 text-center">
                  Abrí WhatsApp → <strong>Dispositivos vinculados</strong> → <strong>Vincular dispositivo</strong> y escaneá este QR
                </p>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={qr.startsWith("data:") ? qr : `data:image/png;base64,${qr}`}
                  alt="WhatsApp QR"
                  className="w-60 h-60 border-2 border-green-200 rounded-xl"
                />
                <p className="text-xs text-gray-400">El QR expira en ~60 segundos. Si vence, generá uno nuevo.</p>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="text-xs text-gray-500 bg-blue-50 border border-blue-200 rounded-lg p-3">
              Meta Cloud API es la integración oficial. Coexiste con WhatsApp Business en el celular.
            </div>

            <Field
              name="meta_phone_number_id"
              label="Phone Number ID"
              placeholder="123456789012345"
              defaultValue={initialConfig?.meta_phone_number_id ?? ""}
            />
            <Field
              name="meta_access_token"
              label="Access Token"
              type="password"
              placeholder="EAABsbCS..."
              defaultValue={initialConfig?.meta_access_token ?? ""}
            />
            <Field
              name="meta_verify_token"
              label="Verify Token"
              placeholder="un-token-secreto"
              defaultValue={initialConfig?.meta_verify_token ?? ""}
            />
            <Field
              name="meta_app_secret"
              label="App Secret"
              type="password"
              placeholder="abc123..."
              defaultValue={initialConfig?.meta_app_secret ?? ""}
            />
            <Field
              name="meta_business_id"
              label="Business Account ID"
              placeholder="987654321"
              defaultValue={initialConfig?.meta_business_id ?? ""}
            />

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">Webhook URL</label>
              <div className="flex items-center gap-2">
                <code className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-xs text-gray-700 break-all">
                  {webhookUrl}
                </code>
                <button
                  type="button"
                  onClick={() => navigator.clipboard.writeText(webhookUrl)}
                  className="px-3 py-2 text-xs border border-gray-300 rounded-lg hover:bg-gray-50 whitespace-nowrap"
                >
                  Copiar
                </button>
              </div>
              <p className="mt-1 text-xs text-gray-400">
                Pegá en Meta Developer Dashboard → WhatsApp → Webhook. Suscribite al campo <strong>messages</strong>.
              </p>
            </div>

            <div className="pt-2 flex justify-end">
              <SubmitButton label="Guardar" />
            </div>
          </>
        )}
      </form>
    </div>
  );
}

function Field({
  name,
  label,
  placeholder,
  type = "text",
  defaultValue,
  hint,
}: {
  name: string;
  label: string;
  placeholder?: string;
  type?: string;
  defaultValue?: string;
  hint?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input
        type={type}
        name={name}
        placeholder={placeholder}
        defaultValue={defaultValue}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-500"
      />
      {hint && <p className="mt-1 text-xs text-gray-400">{hint}</p>}
    </div>
  );
}
