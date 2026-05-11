import { getAgentLogs } from "@/lib/actions/agentLogs";

export const dynamic = "force-dynamic";

export default async function LogsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const logs = await getAgentLogs(id);

  return (
    <div>
      <h2 className="text-lg font-semibold text-gray-900 mb-4">Logs del agente</h2>
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        {logs.length === 0 ? (
          <div className="p-8 text-sm text-gray-500">Todavía no hay logs del agente.</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {logs.map((log) => (
              <div key={log.id} className="p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-medium text-gray-900">{log.event_type}</div>
                  <div className="text-xs text-gray-400">
                    {new Date(log.created_at).toLocaleString("es-AR")}
                  </div>
                </div>
                <div className="mt-1 flex flex-wrap gap-2 text-xs text-gray-500">
                  {log.intent && <span>Intent: {log.intent}</span>}
                  {log.tool_name && <span>Tool: {log.tool_name}</span>}
                  {log.error && <span className="text-red-600">Error: {log.error}</span>}
                </div>
                {log.payload && (
                  <pre className="mt-2 max-h-28 overflow-auto rounded-lg bg-gray-50 p-2 text-xs text-gray-600">
                    {JSON.stringify(log.payload, null, 2)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
