"use client";
import { useState, useEffect } from "react";
import { usePipelines, useHeatmap, useManagerNames } from "@/lib/hooks";
import { useAccountId } from "@/lib/account-context";

export default function HeatmapPage() {
  const accountId = useAccountId();

  const { data: pipelinesData, isLoading: pipelinesLoading } = usePipelines(accountId);
  const pipelines = pipelinesData?.pipelines ?? [];
  const managerNames = useManagerNames(accountId);

  const [pipelineAmoId, setPipelineAmoId] = useState<number | null>(null);
  const [period, setPeriod] = useState("30d");

  useEffect(() => {
    if (pipelines.length > 0 && pipelineAmoId === null) {
      const main = pipelines.find((p) => p.isMain) ?? pipelines[0];
      setPipelineAmoId(main.amoId);
    }
  }, [pipelines, pipelineAmoId]);

  const { data, isLoading } = useHeatmap(accountId, pipelineAmoId ?? 0, period);

  const selectedPipeline = pipelines.find((p) => p.amoId === pipelineAmoId);
  const stageNameMap = new Map(
    selectedPipeline?.stages
      .filter((s) => s.type === 0) // only normal stages
      .map((s) => [s.amoId, s.name]) ?? []
  );

  const rows = data?.rows ?? [];
  const managers = data?.managers ?? [];
  const stages = data?.stages ?? [];

  // Sort stages by pipeline stage order
  const stageOrder = selectedPipeline?.stages.map((s) => s.amoId) ?? [];
  const sortedStages = [...stages].sort(
    (a, b) => (stageOrder.indexOf(a) ?? 999) - (stageOrder.indexOf(b) ?? 999)
  );

  // Build lookup: manager → stage → row
  const cellMap = new Map<string, { avg_hours: number; deal_count: number }>();
  for (const r of rows) {
    cellMap.set(`${r.user_amo_id}:${r.stage_amo_id}`, {
      avg_hours: r.avg_hours,
      deal_count: r.deal_count,
    });
  }

  // Find max avg_hours for color scaling
  const allHours = rows.map((r) => r.avg_hours).filter((h) => h > 0);
  const maxHours = allHours.length > 0 ? Math.max(...allHours) : 1;

  function cellBg(hours: number | undefined): string {
    if (!hours || hours === 0) return "bg-gray-50";
    const ratio = Math.min(hours / maxHours, 1);
    if (ratio < 0.33) return "bg-green-100";
    if (ratio < 0.66) return "bg-yellow-100";
    return "bg-red-100";
  }

  function formatHours(hours: number): string {
    if (hours >= 24) return `${(hours / 24).toFixed(1)} дн`;
    return `${hours.toFixed(1)} ч`;
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Тепловая карта</h1>
          <p className="text-sm text-gray-500 mt-0.5">Среднее время менеджера на каждом этапе</p>
        </div>
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
            {pipelines.map((p) => (
              <option key={p.amoId} value={p.amoId}>
                {p.name}{p.isMain ? " (основная)" : ""}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Legend */}
      <div className="flex items-center gap-4 text-xs text-gray-500">
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded bg-green-100 inline-block" /> Быстро
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded bg-yellow-100 inline-block" /> Среднее
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded bg-red-100 inline-block" /> Долго
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded bg-gray-50 border border-gray-200 inline-block" /> Нет данных
        </span>
      </div>

      {isLoading && (
        <div className="h-64 bg-white rounded-xl border border-gray-200 animate-pulse" />
      )}

      {!isLoading && managers.length === 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center text-gray-400 text-sm">
          Нет данных за выбранный период
        </div>
      )}

      {!isLoading && managers.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-auto">
          <table className="text-xs min-w-full">
            <thead>
              <tr className="border-b border-gray-100">
                <th className="sticky left-0 bg-white px-4 py-3 text-left font-medium text-gray-500 z-10 min-w-36">
                  Менеджер
                </th>
                {sortedStages.map((stageId) => (
                  <th key={stageId} className="px-3 py-3 font-medium text-gray-500 text-center min-w-24">
                    {stageNameMap.get(stageId) ?? `#${stageId}`}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {managers.map((managerId) => (
                <tr key={managerId} className="hover:bg-gray-50 transition-colors">
                  <td className="sticky left-0 bg-white px-4 py-3 font-medium text-gray-900 z-10">
                    {managerNames.get(managerId) ?? `Manager #${managerId}`}
                  </td>
                  {sortedStages.map((stageId) => {
                    const cell = cellMap.get(`${managerId}:${stageId}`);
                    return (
                      <td
                        key={stageId}
                        className={`px-3 py-3 text-center ${cellBg(cell?.avg_hours)}`}
                        title={cell ? `${formatHours(cell.avg_hours)}, ${cell.deal_count} сделок` : ""}
                      >
                        {cell ? (
                          <div>
                            <div className="font-semibold text-gray-800">
                              {formatHours(cell.avg_hours)}
                            </div>
                            <div className="text-gray-400 mt-0.5">{cell.deal_count} сд</div>
                          </div>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
