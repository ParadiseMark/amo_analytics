"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAccountId } from "@/lib/account-context";
import { api } from "@/lib/api";
import { Play, Trash2, Plus, X, ChevronRight } from "lucide-react";
import { format } from "date-fns";
import { ru } from "date-fns/locale";

// ─── Types ────────────────────────────────────────────────────────────────────

type ReportDef = {
  id: string;
  name: string;
  description: string | null;
  createdByPlatformUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

type ReportResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  executionMs: number;
  fromCache: boolean;
};

type DataSourceMeta = {
  name: string;
  fields: string[];
};

type SourcesMeta = {
  sources: Record<string, DataSourceMeta>;
  aggFunctions: string[];
};

type MetricDef = { field: string; agg: string; label: string };
type FilterDef = { field: string; op: string; value: string };

// ─── Builder state ────────────────────────────────────────────────────────────

const FILTER_OPS = ["=", "!=", ">", "<", ">=", "<=", "between", "in"];

function defaultDsl(name: string, source: string, metrics: MetricDef[], filters: FilterDef[], groupBy: string[]) {
  return {
    name,
    data_source: source,
    filters,
    group_by: groupBy,
    metrics,
    limit: 100,
  };
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function ReportsPage() {
  const accountId = useAccountId();
  const qc = useQueryClient();

  const [activeResult, setActiveResult] = useState<ReportResult | null>(null);
  const [activeReportName, setActiveReportName] = useState("");
  const [showBuilder, setShowBuilder] = useState(false);

  const { data: reportsData, isLoading } = useQuery({
    queryKey: ["reports", accountId],
    queryFn: () => api.get<{ reports: ReportDef[] }>(`/reports/${accountId}`),
    enabled: Boolean(accountId),
  });

  const { data: metaData } = useQuery({
    queryKey: ["reports-meta", accountId],
    queryFn: () => api.get<SourcesMeta>(`/reports/${accountId}/meta/sources`),
    enabled: Boolean(accountId),
  });

  const runMutation = useMutation({
    mutationFn: ({ id }: { id: string }) =>
      api.post<ReportResult>(`/reports/${accountId}/${id}/run`),
    onSuccess: (result, { id }) => {
      const def = reportsData?.reports.find((r) => r.id === id);
      setActiveReportName(def?.name ?? "Отчёт");
      setActiveResult(result);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/reports/${accountId}/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["reports", accountId] }),
  });

  const reports = reportsData?.reports ?? [];

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">Отчёты</h1>
        <button
          onClick={() => setShowBuilder(true)}
          className="flex items-center gap-2 text-sm font-medium px-3 py-2 rounded-lg bg-brand-600 text-white hover:bg-brand-700 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Создать отчёт
        </button>
      </div>

      {isLoading ? (
        <div className="grid gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-16 bg-white rounded-xl border border-gray-200 animate-pulse" />
          ))}
        </div>
      ) : reports.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-200 p-12 text-center">
          <p className="text-gray-400 text-sm">Отчётов пока нет</p>
          <p className="text-gray-300 text-xs mt-1">Нажмите «Создать отчёт» чтобы начать</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 text-xs text-gray-500 uppercase tracking-wide">
                <th className="text-left px-5 py-3 font-medium">Название</th>
                <th className="text-left px-4 py-3 font-medium">Описание</th>
                <th className="text-right px-4 py-3 font-medium">Обновлён</th>
                <th className="text-right px-5 py-3 font-medium">Действия</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {reports.map((r) => (
                <tr key={r.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-5 py-3 font-medium text-gray-900">{r.name}</td>
                  <td className="px-4 py-3 text-gray-500 text-xs">{r.description ?? "—"}</td>
                  <td className="px-4 py-3 text-right text-gray-400 text-xs">
                    {format(new Date(r.updatedAt), "d MMM yyyy", { locale: ru })}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <div className="flex items-center gap-2 justify-end">
                      <button
                        onClick={() => runMutation.mutate({ id: r.id })}
                        disabled={runMutation.isPending}
                        className="flex items-center gap-1.5 text-xs font-medium text-brand-600 hover:text-brand-700 px-2.5 py-1.5 rounded-lg hover:bg-brand-50 transition-colors"
                      >
                        <Play className="w-3 h-3" />
                        Запустить
                      </button>
                      <button
                        onClick={() => {
                          if (confirm(`Удалить отчёт «${r.name}»?`))
                            deleteMutation.mutate(r.id);
                        }}
                        className="p-1.5 text-gray-300 hover:text-red-500 rounded-lg hover:bg-red-50 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Result panel */}
      {activeResult && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <div>
              <h2 className="font-semibold text-gray-900">{activeReportName}</h2>
              <p className="text-xs text-gray-400 mt-0.5">
                {activeResult.rows.length} строк · {activeResult.executionMs} мс
                {activeResult.fromCache && " · из кэша"}
              </p>
            </div>
            <button
              onClick={() => setActiveResult(null)}
              className="text-xs text-gray-400 hover:text-gray-600"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-gray-100 text-gray-500 uppercase tracking-wide">
                  {activeResult.columns.map((col) => (
                    <th key={col} className="text-left px-4 py-2 font-medium whitespace-nowrap">
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {activeResult.rows.slice(0, 200).map((row, i) => (
                  <tr key={i} className="hover:bg-gray-50">
                    {activeResult.columns.map((col) => (
                      <td key={col} className="px-4 py-2 text-gray-700 whitespace-nowrap">
                        {String(row[col] ?? "")}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Builder modal */}
      {showBuilder && (
        <ReportBuilder
          accountId={accountId}
          meta={metaData ?? { sources: {}, aggFunctions: [] }}
          onClose={() => setShowBuilder(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ["reports", accountId] });
            setShowBuilder(false);
          }}
        />
      )}
    </div>
  );
}

// ─── Report Builder ───────────────────────────────────────────────────────────

function ReportBuilder({
  accountId,
  meta,
  onClose,
  onSaved,
}: {
  accountId: string;
  meta: SourcesMeta;
  onClose: () => void;
  onSaved: () => void;
}) {
  const sources = Object.keys(meta.sources);
  const aggFunctions = meta.aggFunctions.length > 0 ? meta.aggFunctions : ["sum", "avg", "count", "min", "max"];

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [source, setSource] = useState(sources[0] ?? "daily_manager_kpis");
  const [metrics, setMetrics] = useState<MetricDef[]>([
    { field: "revenue_won", agg: "sum", label: "Выручка" },
  ]);
  const [filters, setFilters] = useState<FilterDef[]>([]);
  const [groupBy, setGroupBy] = useState<string[]>(["user_amo_id"]);
  const [previewResult, setPreviewResult] = useState<ReportResult | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);

  const sourceFields = meta.sources[source]?.fields ?? [];

  function addMetric() {
    setMetrics([...metrics, { field: sourceFields[0] ?? "", agg: "sum", label: "" }]);
  }

  function removeMetric(i: number) {
    setMetrics(metrics.filter((_, idx) => idx !== i));
  }

  function updateMetric(i: number, patch: Partial<MetricDef>) {
    setMetrics(metrics.map((m, idx) => idx === i ? { ...m, ...patch } : m));
  }

  function addFilter() {
    setFilters([...filters, { field: sourceFields[0] ?? "", op: "=", value: "" }]);
  }

  function removeFilter(i: number) {
    setFilters(filters.filter((_, idx) => idx !== i));
  }

  function updateFilter(i: number, patch: Partial<FilterDef>) {
    setFilters(filters.map((f, idx) => idx === i ? { ...f, ...patch } : f));
  }

  function buildDsl() {
    return defaultDsl(name, source, metrics, filters, groupBy);
  }

  async function handlePreview() {
    setError("");
    setPreviewing(true);
    try {
      const result = await api.post<ReportResult>(`/reports/${accountId}/preview`, buildDsl());
      setPreviewResult(result);
    } catch (e: unknown) {
      setError((e as { message?: string }).message ?? "Ошибка предпросмотра");
    } finally {
      setPreviewing(false);
    }
  }

  async function handleSave() {
    if (!name.trim()) {
      setError("Введите название отчёта");
      return;
    }
    setError("");
    setSaving(true);
    try {
      const dsl = description ? { ...buildDsl(), description } : buildDsl();
      await api.post(`/reports/${accountId}`, dsl);
      onSaved();
    } catch (e: unknown) {
      setError((e as { message?: string }).message ?? "Ошибка сохранения");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <h2 className="text-base font-bold text-gray-900">Конструктор отчётов</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* Name */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Название *</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                placeholder="Мой отчёт"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Описание</label>
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
                placeholder="Необязательно"
              />
            </div>
          </div>

          {/* Data source */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Источник данных</label>
            <select
              value={source}
              onChange={(e) => { setSource(e.target.value); setMetrics([{ field: "", agg: "sum", label: "" }]); }}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 bg-white"
            >
              {sources.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
              {sources.length === 0 && <option value="daily_manager_kpis">daily_manager_kpis</option>}
            </select>
          </div>

          {/* Metrics */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-gray-600 uppercase tracking-wide">Метрики</label>
              <button onClick={addMetric} className="text-xs text-brand-600 hover:underline flex items-center gap-1">
                <Plus className="w-3 h-3" /> Добавить
              </button>
            </div>
            <div className="space-y-2">
              {metrics.map((m, i) => (
                <div key={i} className="flex items-center gap-2">
                  <select
                    value={m.agg}
                    onChange={(e) => updateMetric(i, { agg: e.target.value })}
                    className="px-2 py-1.5 border border-gray-300 rounded-lg text-xs bg-white w-20"
                  >
                    {aggFunctions.map((a) => <option key={a} value={a}>{a}</option>)}
                  </select>
                  <select
                    value={m.field}
                    onChange={(e) => updateMetric(i, { field: e.target.value })}
                    className="px-2 py-1.5 border border-gray-300 rounded-lg text-xs bg-white flex-1"
                  >
                    {sourceFields.map((f) => <option key={f} value={f}>{f}</option>)}
                    {sourceFields.length === 0 && <option value={m.field}>{m.field}</option>}
                  </select>
                  <input
                    value={m.label}
                    onChange={(e) => updateMetric(i, { label: e.target.value })}
                    placeholder="Метка"
                    className="px-2 py-1.5 border border-gray-300 rounded-lg text-xs w-28"
                  />
                  <button onClick={() => removeMetric(i)} className="text-gray-300 hover:text-red-500">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Group by */}
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Группировка (через запятую)</label>
            <input
              value={groupBy.join(", ")}
              onChange={(e) => setGroupBy(e.target.value.split(",").map((s) => s.trim()).filter(Boolean))}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              placeholder="user_amo_id, date"
            />
          </div>

          {/* Filters */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-medium text-gray-600 uppercase tracking-wide">Фильтры</label>
              <button onClick={addFilter} className="text-xs text-brand-600 hover:underline flex items-center gap-1">
                <Plus className="w-3 h-3" /> Добавить
              </button>
            </div>
            <div className="space-y-2">
              {filters.map((f, i) => (
                <div key={i} className="flex items-center gap-2">
                  <select
                    value={f.field}
                    onChange={(e) => updateFilter(i, { field: e.target.value })}
                    className="px-2 py-1.5 border border-gray-300 rounded-lg text-xs bg-white flex-1"
                  >
                    {sourceFields.map((sf) => <option key={sf} value={sf}>{sf}</option>)}
                  </select>
                  <select
                    value={f.op}
                    onChange={(e) => updateFilter(i, { op: e.target.value })}
                    className="px-2 py-1.5 border border-gray-300 rounded-lg text-xs bg-white w-20"
                  >
                    {FILTER_OPS.map((op) => <option key={op} value={op}>{op}</option>)}
                  </select>
                  <input
                    value={f.value}
                    onChange={(e) => updateFilter(i, { value: e.target.value })}
                    placeholder="Значение"
                    className="px-2 py-1.5 border border-gray-300 rounded-lg text-xs w-36"
                  />
                  <button onClick={() => removeFilter(i)} className="text-gray-300 hover:text-red-500">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          {error && (
            <p className="text-sm text-red-600 bg-red-50 px-3 py-2 rounded-lg">{error}</p>
          )}

          {/* Preview result */}
          {previewResult && (
            <div className="border border-gray-200 rounded-xl overflow-hidden">
              <div className="px-4 py-3 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
                <p className="text-xs font-medium text-gray-600">
                  Предпросмотр — {previewResult.rows.length} строк · {previewResult.executionMs} мс
                </p>
                <button onClick={() => setPreviewResult(null)} className="text-gray-400 hover:text-gray-600">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="overflow-x-auto max-h-48">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-gray-100 text-gray-500">
                      {previewResult.columns.map((col) => (
                        <th key={col} className="text-left px-3 py-2 font-medium whitespace-nowrap">{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {previewResult.rows.map((row, i) => (
                      <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                        {previewResult.columns.map((col) => (
                          <td key={col} className="px-3 py-1.5 text-gray-700 whitespace-nowrap">
                            {String(row[col] ?? "")}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-200">
          <button
            onClick={handlePreview}
            disabled={previewing}
            className="flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            <Play className="w-3.5 h-3.5" />
            {previewing ? "Выполняется..." : "Предпросмотр"}
          </button>
          <div className="flex items-center gap-3">
            <button onClick={onClose} className="text-sm text-gray-500 hover:text-gray-700 px-3 py-2">
              Отмена
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50 transition-colors"
            >
              {saving ? "Сохранение..." : "Сохранить отчёт"}
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
