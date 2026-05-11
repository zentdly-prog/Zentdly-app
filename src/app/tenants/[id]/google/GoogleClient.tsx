"use client";

import { useActionState, useState, useTransition } from "react";
import { saveGoogleConfig, testGoogleConnection } from "@/lib/actions/google";
import { SubmitButton } from "@/components/SubmitButton";
import { Alert } from "@/components/Alert";

type Config = {
  service_account?: Record<string, unknown> | null;
  calendar_id?: string;
  spreadsheet_id?: string;
  sheet_name?: string;
  calendar_enabled?: boolean;
  sheets_enabled?: boolean;
} | null;

export default function GoogleClient({
  tenantId,
  initialConfig,
}: {
  tenantId: string;
  initialConfig: Config;
}) {
  const [state, action] = useActionState(saveGoogleConfig, null);
  const [testResult, setTestResult] = useState<{ ok?: boolean; error?: string; calendarOk?: boolean; sheetsOk?: boolean; calendarError?: string } | null>(null);
  const [isTesting, startTest] = useTransition();

  const savedJson = initialConfig?.service_account
    ? JSON.stringify(initialConfig.service_account, null, 2)
    : "";

  function handleTest() {
    setTestResult(null);
    startTest(async () => {
      const res = await testGoogleConnection(tenantId);
      setTestResult(res);
    });
  }

  return (
    <div className="max-w-2xl">
      <h2 className="text-lg font-semibold text-gray-900 mb-1">Google</h2>
      <p className="text-sm text-gray-500 mb-6">
        Conectá Google Calendar y Google Sheets para sincronizar reservas automáticamente.
      </p>

      {state?.error && <Alert type="error" message={state.error} />}
      {state?.ok && <Alert type="success" message="Configuración guardada." />}

      <form action={action} className="space-y-6">
        <input type="hidden" name="tenant_id" value={tenantId} />

        {/* Service Account */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-gray-900 mb-1">Cuenta de Servicio</h3>
            <p className="text-xs text-gray-500 mb-3">
              Pegá el contenido del archivo <code className="bg-gray-100 px-1 rounded">.json</code> que descargás desde Google Cloud Console → IAM → Cuentas de servicio.
            </p>
            <textarea
              name="service_account"
              rows={8}
              defaultValue={savedJson}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-xs text-gray-900 font-mono focus:outline-none focus:ring-2 focus:ring-green-500 resize-y"
              placeholder={'{\n  "type": "service_account",\n  "client_email": "...",\n  "private_key": "..."\n}'}
            />
          </div>

          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-800 space-y-1">
            <p className="font-medium">Cómo obtener la cuenta de servicio:</p>
            <ol className="list-decimal list-inside space-y-0.5 text-blue-700">
              <li>Ir a <strong>console.cloud.google.com</strong></li>
              <li>Activar APIs: Google Calendar API y Google Sheets API</li>
              <li>Crear una Cuenta de Servicio en IAM</li>
              <li>Generar una clave JSON y descargarla</li>
              <li>Compartir el calendario/sheet con el email de la cuenta de servicio</li>
            </ol>
          </div>
        </div>

        {/* Calendar */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-gray-900">Google Calendar</h3>
              <p className="text-xs text-gray-500 mt-0.5">Crea eventos por cada reserva confirmada.</p>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                name="calendar_enabled"
                defaultChecked={initialConfig?.calendar_enabled ?? false}
                className="w-4 h-4 rounded text-green-600"
              />
              <span className="text-sm text-gray-700">Activar</span>
            </label>
          </div>

          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900 space-y-2">
            <p className="font-semibold">Cómo conectar el calendario (2 pasos):</p>
            <div className="space-y-1">
              <p className="font-medium text-amber-800">Paso 1 — Compartir el calendario con la cuenta de servicio</p>
              <ol className="list-decimal list-inside space-y-0.5 text-amber-700 pl-1">
                <li>Abrí <strong>calendar.google.com</strong></li>
                <li>En el panel izquierdo, encontrá el calendario que querés usar</li>
                <li>Hacé clic en los <strong>tres puntos</strong> al lado del nombre → <strong>Configuración y uso compartido</strong></li>
                <li>En la sección <strong>&quot;Compartir con determinadas personas&quot;</strong>, hacé clic en <strong>+ Agregar personas</strong></li>
                <li>Pegá el <code className="bg-amber-100 px-0.5 rounded">client_email</code> del JSON que cargaste arriba</li>
                <li>En permisos elegí <strong>&quot;Realizar cambios en eventos&quot;</strong></li>
                <li>Hacé clic en <strong>Enviar</strong></li>
              </ol>
            </div>
            <div className="space-y-1">
              <p className="font-medium text-amber-800">Paso 2 — Copiar el Calendar ID</p>
              <ol className="list-decimal list-inside space-y-0.5 text-amber-700 pl-1">
                <li>En la misma pantalla de configuración, bajá hasta la sección <strong>&quot;Integrar calendario&quot;</strong></li>
                <li>Copiá el valor de <strong>&quot;ID del calendario&quot;</strong> — termina en <code className="bg-amber-100 px-0.5 rounded">@group.calendar.google.com</code></li>
                <li>Si querés usar tu calendario personal principal, usá <code className="bg-amber-100 px-0.5 rounded">primary</code></li>
                <li>Pegalo en el campo de abajo</li>
              </ol>
            </div>
            <p className="text-amber-600 text-[11px] pt-1">
              ⚠️ Si saltás el Paso 1, el test de conexión va a fallar con error de permisos.
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Calendar ID</label>
            <input
              type="text"
              name="calendar_id"
              defaultValue={initialConfig?.calendar_id ?? ""}
              placeholder="ejemplo@group.calendar.google.com o primary"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-500"
            />
            <p className="mt-1 text-xs text-gray-400">
              Configuración del calendario → Integrar calendario → ID del calendario.
            </p>
          </div>
        </div>

        {/* Sheets */}
        <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-gray-900">Google Sheets</h3>
              <p className="text-xs text-gray-500 mt-0.5">Registra cada reserva en una hoja de cálculo.</p>
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                name="sheets_enabled"
                defaultChecked={initialConfig?.sheets_enabled ?? false}
                className="w-4 h-4 rounded text-green-600"
              />
              <span className="text-sm text-gray-700">Activar</span>
            </label>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Spreadsheet ID</label>
            <input
              type="text"
              name="spreadsheet_id"
              defaultValue={initialConfig?.spreadsheet_id ?? ""}
              placeholder="1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgVE2upms"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-500"
            />
            <p className="mt-1 text-xs text-gray-400">
              El ID está en la URL del sheet: docs.google.com/spreadsheets/d/<strong>[ID]</strong>/edit
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Nombre de la hoja</label>
            <input
              type="text"
              name="sheet_name"
              defaultValue={initialConfig?.sheet_name ?? "Reservas"}
              placeholder="Reservas"
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>
        </div>

        {/* Test result */}
        {testResult && (
          <div className={`rounded-lg p-4 text-sm space-y-1 ${testResult.error ? "bg-red-50 border border-red-200" : "bg-green-50 border border-green-200"}`}>
            {testResult.error ? (
              <p className="text-red-700">{testResult.error}</p>
            ) : (
              <>
                {testResult.calendarOk !== undefined && (
                  <div>
                    <p className={testResult.calendarOk ? "text-green-700" : "text-red-600"}>
                      {testResult.calendarOk ? "✓" : "✗"} Google Calendar
                    </p>
                    {!testResult.calendarOk && testResult.calendarError && (
                      <p className="text-red-500 text-xs mt-0.5 ml-3">{testResult.calendarError}</p>
                    )}
                  </div>
                )}
                {testResult.sheetsOk !== undefined && (
                  <p className={testResult.sheetsOk ? "text-green-700" : "text-red-600"}>
                    {testResult.sheetsOk ? "✓" : "✗"} Google Sheets
                  </p>
                )}
              </>
            )}
          </div>
        )}

        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={handleTest}
            disabled={isTesting}
            className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            {isTesting ? "Probando..." : "Probar conexión"}
          </button>
          <SubmitButton label="Guardar" />
        </div>
      </form>
    </div>
  );
}
