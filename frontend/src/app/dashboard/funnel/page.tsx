"use client";
import { useState, useEffect } from "react";
import { useFunnel, usePipelines } from "@/lib/hooks";
import { useAccountId } from "@/lib/account-context";

export default function FunnelPage() {
  const accountId = useAccountId();

  const { data: pipelinesData, isLoading: pipelinesLoading } = usePipelines(accountId);
  const pipelines = pipelinesData?.pipelines ?? [];

  const [pipelineAmoId, setPipelineAmoId] = useState<number | null>(null);
  const [period, setPeriod] = useState("30d");

  // Auto-select main pipeline (or first) once loaded
  useEffect(() => {
    if (pipelines.length > 0 && pipelineAmoId === null) {
      const main = pipelines.find((p) => p.isMain) ?? pipelines[0];
      setPipelineAmoId(main.amoId);
    }
  }, [pipelines, pipelineAmoId]);

  const { data, isLoading } = useFunnel(accountId, pipelineAmoId ?? 0, period);

  const transitions = data?.transitions ?? [];
  const stageTimes = data?.stageTimes ?? [];

  const selectedPipeline = pipelines.find((p) => p.amoId === pipelineAmoId);
  const stageNameMap = new Map(
    selectedPipeline?.stages.map((s) => [s.amoId, s.name]) ?? []
  );

  // Build per-stage totals from transitions
  const stageMap = new Map<number, { inbound: number; outbound: number }>();
  for (const t of transitions) {
    if (!stageMap.has(t.from_stage_amo_id))
      stageMap.set(t.from_stage_amo_id, { inbound: 0, outbound: 0 });
    stageMap.get(t.from_stage_amo_id)!.outbound += t.transition_count;

    if (!stageMap.has(t.to_stage_amo_id))
      stageMap.set(t.to_stage_amo_id, { inbound: 0, outbound: 0 });
    stageMap.get(t.to_stage_amo_id)!.inbound += t.transition_count;
  }

  const stageTimeMap = new Map(stageTimes.map((s) => [s.stage_amo_id, s]));

  // Sort stages by the pipeline stage order (using selectedPipeline.stages sort)
  const stageOrder = selectedPipeline?.stages.map((s) => s.amoId) ?? [];
  const stageEntries = Array.from(stageMap.entries()).map(([id, counts]) => {
    const st = stageTimeMap.get(id);
    const convRate =
      counts.inbound > 0 ? (counts.outbound / counts.inbound) * 100 : null;
    return { id, ...counts, convRate, avgHours: st?.avg_hours ?? null };
  });
  stageEntries.sort(
    (a, b) => (stageOrder.indexOf(a.id) ?? 999) - (stageOrder.indexOf(b.id) ?? 999)
  );

  // Max inbound for funnel bar width
  const maxInbound = Math.max(...stageEntries.map((s) => s.inbound), 1);

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">Воронка</h1>
        <div className="flex items-center gap-3">
          <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
            {["7d", "30d", "90d"].map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-3 py-1.5 font-medium transition-colors ${
                  period === p ? "bg-brand-600 text-white" : "bg-white text-gray-600 hover:bg-gray-50"
                }`}
              >
                {p === "7d" ? "7 дн" : p === "30d" ? "30 дн" : "90 дн"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Pipeline selector */}
      <div className="flex items-center gap-3">
        <label className="text-sm text-gray-600 font-medium">Воронка:</label>
        {pipelinesLoading ? (
          <div className="h-9 w-48 bg-gray-100 rounded-lg animate-pulse" />
        ) : (
          <select
            value={pipelineAmoId ?? ""}
            onChange={(e) => setPipelineAmoId(Number(e.target.value))}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white"
          >
            {pipelines.length === 0 && (
              <option value="">Нет воронок</option>
            )}
            {pipelines.map((p) => (
              <option key={p.amoId} value={p.amoId}>
                {p.name}{p.isMain ? " (основная)" : ""}
              </option>
            ))}
          </select>
        )}
      </div>

      {!pipelineAmoId && !pipelinesLoading && (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-gray-400 text-sm">
          Нет данных — подключите AmoCRM аккаунт и дождитесь синхронизации
        </div>
      )}

      {pipelineAmoId && isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-14 bg-white rounded-xl border border-gray-200 animate-pulse" />
          ))}
        </div>
      )}

      {pipelineAmoId && !isLoading && stageEntries.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-xs text-gray-500 uppercase tracking-wide">
                <th className="text-left px-5 py-3 font-medium">Этап</th>
                <th className="text-right px-4 py-3 font-medium">Сделок</th>
                <th className="px-4 py-3 font-medium w-48">Воронка</th>
                <th className="text-right px-4 py-3 font-medium">Конверсия</th>
                <th className="text-right px-5 py-3 font-medium">Ср. время</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {stageEntries.map((s) => (
                <tr key={s.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-5 py-3 font-medium text-gray-900">
                    {stageNameMap.get(s.id) ?? `Этап #${s.id}`}
                  </td>
                  <td className="px-4 py-3 text-right text-gray-700">{s.inbound}</td>
                  <td className="px-4 py-3">
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-brand-500 rounded-full"
                        style={{ width: `${(s.inbound / maxInbound) * 100}%` }}
                      />
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    {s.convRate != null ? (
                      <span
                        className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                          s.convRate >= 60
                            ? "bg-green-50 text-green-700"
                            : s.convRate >= 30
                            ? "bg-yellow-50 text-yellow-700"
                            : "bg-red-50 text-red-700"
                        }`}
                      >
                        {s.convRate.toFixed(0)}%
                      </span>
                    ) : "—"}
                  </td>
                  <td className="px-5 py-3 text-right text-gray-600">
                    {s.avgHours != null
                      ? s.avgHours >= 24
                        ? `${(s.avgHours / 24).toFixed(1)} дн`
                        : `${s.avgHours.toFixed(1)} ч`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pipelineAmoId && !isLoading && stageEntries.length === 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-gray-400 text-sm">
          Нет данных по воронке за выбранный период
        </div>
      )}
    </div>
  );
}
