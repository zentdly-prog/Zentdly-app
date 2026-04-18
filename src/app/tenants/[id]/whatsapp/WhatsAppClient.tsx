"use client";

import { useActionState, useState, useTransition } from "react";
import { connectEvolutionWhatsApp, saveWhatsAppConfig } from "@/lib/actions/whatsapp";
import { SubmitButton } from "@/components/SubmitButton";
import { Alert } from "@/components/Alert";

type QrStatus = "idle" | "loading" | "qr" | "connected" | "error";

type Config = {
  provider?: string;
  meta_phone_number_id?: string | null;
  meta_access_token?: string | null;
  meta_verify_token?: string | null;
  meta_app_secret?: string | null;
  meta_business_id?: string | null;
} | null;

export default function WhatsAppClient({
  tenantId,
  initialConfig,
}: {
  tenantId: string;
  initialConfig: Config;
}) {
  const savedProvider = initialConfig?.provider === "meta" ? "meta" : "evolution";
  const [provider, setProvider] = useState<"evolution" | "meta">(savedProvider);

  // Evolution QR state
  const [qrStatus, setQrStatus] = useState<QrStatus>("idle");
  const [qr, setQr] = useState<string | null>(null);
  const [qrError, setQrError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  // Meta form state
  const [metaState, metaAction] = useActionState(saveWhatsAppConfig, null);

  const webhookUrl = `https://zentdlyw.vercel.app/api/webhooks/whatsapp`;

  function handleGetQr() {
    setQr(null);
    setQrError(null);
    setQrStatus("loading");
    startTransition(async () => {
      const res = await connectEvolutionWhatsApp(tenantId);
      if (res.connected) {
        setQrStatus("connected");
      } else if (res.qr) {
        setQr(res.qr);
        setQrStatus("qr");
      } else {
        setQrError(res.error ?? "Error desconocido.");
        setQrStatus("error");
      }
    });
  }

  return (
    <div className="max-w-md">
      <h2 className="text-lg font-semibold text-gray-900 mb-1">WhatsApp</h2>
      <p className="text-sm text-gray-500 mb-6">
        Elegí cómo conectar WhatsApp a este negocio.
      </p>

      {/* Toggle */}
      <div className="flex bg-gray-100 rounded-xl p-1 mb-6">
        <button
          type="button"
          onClick={() => setProvider("evolution")}
          className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors ${
            provider === "evolution"
              ? "bg-white text-gray-900 shadow-sm"
              : "text-gray-500 hover:text-gray-700"
          }`}
        >
          📱 Personal
        </button>
        <button
          type="button"
          onClick={() => setProvider("meta")}
          className={`flex-1 py-2 text-sm font-medium rounded-lg transition-colors ${
            provider === "meta"
              ? "bg-white text-gray-900 shadow-sm"
              : "text-gray-500 hover:text-gray-700"
          }`}
        >
          💼 Business
        </button>
      </div>

      {/* ── PERSONAL (Evolution API) ── */}
      {provider === "evolution" && (
        <div className="space-y-4">
          <div className="text-xs text-gray-500 bg-amber-50 border border-amber-200 rounded-lg p-3">
            Conecta un número personal de WhatsApp escaneando un QR. No requiere cuenta Business.
          </div>

          {qrStatus === "idle" && (
            <div className="bg-white rounded-2xl border border-gray-200 p-8 flex flex-col items-center gap-4">
              <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center text-3xl">
                📱
              </div>
              <div className="text-center">
                <p className="font-medium text-gray-900 mb-1">Sin conectar</p>
                <p className="text-sm text-gray-500">
                  Al presionar el botón se genera el código QR para vincular el número.
                </p>
              </div>
              <button
                onClick={handleGetQr}
                className="mt-2 w-full py-3 bg-green-600 text-white font-semibold rounded-xl hover:bg-green-700 transition-colors"
              >
                Obtener QR
              </button>
            </div>
          )}

          {qrStatus === "loading" && (
            <div className="bg-white rounded-2xl border border-gray-200 p-8 flex flex-col items-center gap-4">
              <svg className="animate-spin w-10 h-10 text-green-600" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
              <p className="text-sm text-gray-500 text-center">
                Generando QR… puede tardar unos segundos si el servidor está iniciando.
              </p>
            </div>
          )}

          {qrStatus === "qr" && qr && (
            <div className="bg-white rounded-2xl border border-gray-200 p-6 flex flex-col items-center gap-4">
              <p className="text-sm text-gray-700 text-center">
                Abrí WhatsApp → <strong>Dispositivos vinculados</strong> → <strong>Vincular dispositivo</strong>
              </p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={qr.startsWith("data:") ? qr : `data:image/png;base64,${qr}`}
                alt="QR WhatsApp"
                className="w-64 h-64 rounded-xl border border-gray-100"
              />
              <p className="text-xs text-gray-400">El QR expira en ~60 segundos.</p>
              <button
                onClick={handleGetQr}
                disabled={isPending}
                className="text-sm text-green-600 hover:underline disabled:opacity-50"
              >
                Generar nuevo QR
              </button>
            </div>
          )}

          {qrStatus === "connected" && (
            <div className="bg-white rounded-2xl border border-green-200 p-8 flex flex-col items-center gap-4">
              <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center text-3xl">✅</div>
              <div className="text-center">
                <p className="font-semibold text-green-800 mb-1">WhatsApp conectado</p>
                <p className="text-sm text-gray-500">El número está vinculado y el bot puede operar.</p>
              </div>
              <button
                onClick={handleGetQr}
                disabled={isPending}
                className="text-sm text-gray-400 hover:text-gray-600 disabled:opacity-50"
              >
                Reconectar
              </button>
            </div>
          )}

          {qrStatus === "error" && (
            <div className="bg-white rounded-2xl border border-gray-200 p-8 flex flex-col items-center gap-4">
              <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center text-3xl">⚠️</div>
              <div className="text-center">
                <p className="font-medium text-gray-900 mb-1">No se pudo conectar</p>
                <p className="text-sm text-red-600">{qrError}</p>
              </div>
              <button
                onClick={handleGetQr}
                disabled={isPending}
                className="mt-2 w-full py-3 bg-green-600 text-white font-semibold rounded-xl hover:bg-green-700 disabled:opacity-50 transition-colors"
              >
                Reintentar
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── BUSINESS (Meta Cloud API) ── */}
      {provider === "meta" && (
        <form action={metaAction} className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
          <input type="hidden" name="tenant_id" value={tenantId} />
          <input type="hidden" name="provider" value="meta" />

          <div className="text-xs text-gray-500 bg-blue-50 border border-blue-200 rounded-lg p-3">
            API oficial de Meta. Coexiste con WhatsApp Business en el celular. Requiere cuenta verificada en Meta Business.
          </div>

          {metaState?.error && <Alert type="error" message={metaState.error} />}
          {metaState?.ok && <Alert type="success" message="Configuración guardada." />}

          <Field name="meta_phone_number_id" label="Phone Number ID" placeholder="123456789012345"
            defaultValue={initialConfig?.meta_phone_number_id ?? ""} />
          <Field name="meta_access_token" label="Access Token" type="password" placeholder="EAABsbCS..."
            defaultValue={initialConfig?.meta_access_token ?? ""} />
          <Field name="meta_verify_token" label="Verify Token" placeholder="un-token-secreto"
            defaultValue={initialConfig?.meta_verify_token ?? ""} />
          <Field name="meta_app_secret" label="App Secret" type="password" placeholder="abc123..."
            defaultValue={initialConfig?.meta_app_secret ?? ""} />
          <Field name="meta_business_id" label="Business Account ID" placeholder="987654321"
            defaultValue={initialConfig?.meta_business_id ?? ""} />

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
        </form>
      )}
    </div>
  );
}

function Field({
  name, label, placeholder, type = "text", defaultValue,
}: {
  name: string; label: string; placeholder?: string; type?: string; defaultValue?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <input
        type={type} name={name} placeholder={placeholder} defaultValue={defaultValue}
        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-500"
      />
    </div>
  );
}
