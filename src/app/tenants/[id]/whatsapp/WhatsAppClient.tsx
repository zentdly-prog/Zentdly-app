"use client";

import { useState, useTransition } from "react";
import { connectEvolutionWhatsApp } from "@/lib/actions/whatsapp";

type Status = "idle" | "loading" | "qr" | "connected" | "error";

export default function WhatsAppClient({
  tenantId,
  alreadyConnected,
}: {
  tenantId: string;
  alreadyConnected: boolean;
}) {
  const [status, setStatus] = useState<Status>(alreadyConnected ? "connected" : "idle");
  const [qr, setQr] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleGetQr() {
    setQr(null);
    setErrorMsg(null);
    setStatus("loading");
    startTransition(async () => {
      const res = await connectEvolutionWhatsApp(tenantId);
      if (res.connected) {
        setStatus("connected");
      } else if (res.qr) {
        setQr(res.qr);
        setStatus("qr");
      } else {
        setErrorMsg(res.error ?? "Error desconocido.");
        setStatus("error");
      }
    });
  }

  return (
    <div className="max-w-sm">
      <h2 className="text-lg font-semibold text-gray-900 mb-1">WhatsApp</h2>
      <p className="text-sm text-gray-500 mb-8">
        Conectá el WhatsApp de este negocio escaneando el QR desde el celular.
      </p>

      {status === "idle" && (
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

      {status === "loading" && (
        <div className="bg-white rounded-2xl border border-gray-200 p-8 flex flex-col items-center gap-4">
          <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center">
            <svg className="animate-spin w-8 h-8 text-green-600" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
            </svg>
          </div>
          <p className="text-sm text-gray-500 text-center">
            Generando QR… puede tardar unos segundos si el servidor está iniciando.
          </p>
        </div>
      )}

      {status === "qr" && qr && (
        <div className="bg-white rounded-2xl border border-gray-200 p-6 flex flex-col items-center gap-4">
          <p className="text-sm text-gray-700 text-center">
            Abrí WhatsApp en tu celular →{" "}
            <strong>Dispositivos vinculados</strong> →{" "}
            <strong>Vincular dispositivo</strong>
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={qr.startsWith("data:") ? qr : `data:image/png;base64,${qr}`}
            alt="QR WhatsApp"
            className="w-64 h-64 rounded-xl border border-gray-100"
          />
          <p className="text-xs text-gray-400 text-center">
            El QR expira en ~60 segundos.
          </p>
          <button
            onClick={handleGetQr}
            disabled={isPending}
            className="text-sm text-green-600 hover:underline disabled:opacity-50"
          >
            Generar nuevo QR
          </button>
        </div>
      )}

      {status === "connected" && (
        <div className="bg-white rounded-2xl border border-green-200 p-8 flex flex-col items-center gap-4">
          <div className="w-16 h-16 rounded-full bg-green-100 flex items-center justify-center text-3xl">
            ✅
          </div>
          <div className="text-center">
            <p className="font-semibold text-green-800 mb-1">WhatsApp conectado</p>
            <p className="text-sm text-gray-500">
              El número está vinculado y el bot puede enviar y recibir mensajes.
            </p>
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

      {status === "error" && (
        <div className="bg-white rounded-2xl border border-gray-200 p-8 flex flex-col items-center gap-4">
          <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center text-3xl">
            ⚠️
          </div>
          <div className="text-center">
            <p className="font-medium text-gray-900 mb-1">No se pudo conectar</p>
            <p className="text-sm text-red-600">{errorMsg}</p>
          </div>
          <button
            onClick={handleGetQr}
            disabled={isPending}
            className="mt-2 w-full py-3 bg-green-600 text-white font-semibold rounded-xl hover:bg-green-700 transition-colors disabled:opacity-50"
          >
            Reintentar
          </button>
        </div>
      )}
    </div>
  );
}
