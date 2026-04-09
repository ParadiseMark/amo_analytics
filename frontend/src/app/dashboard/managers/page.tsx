"use client";
import { useState } from "react";
import Link from "next/link";
import { useManagers, useManagerNames } from "@/lib/hooks";
import { useAccountId } from "@/lib/account-context";
import { formatCurrency, formatPct, cn } from "@/lib/utils";
import { ChevronUp, ChevronDown } from "lucide-react";

type SortKey = "revenue_won" | "win_rate" | "calls_made" | "deals_won" | "response_time_p50";

const COLUMNS: { key: SortKey; label: string; format: (v: number) => string }[] = [
  { key: "revenue_won",        label: "Выручка",        format: formatCurrency },
  { key: "deals_won",          label: "Сделок",          format: String },
  { key: "win_rate",           label: "Win Rate",        format: (v) => formatPct(v * 100, 1) },
  { key: "calls_made",         label: "Звонки",          format: String },
  { key: "response_time_p50",  label: "Ответ (мед)",     format: (v) => `${Math.round(v)} мин` },
];

const PERIODS = [
  { value: "7d",  label: "7 дн" },
  { value: "30d", label: "30 дн" },
  { value: "90d", label: "90 дн" },
];

export default function ManagersPage() {
  const accountId = useAccountId();

  const [period, setPeriod] = useState("30d");
  const [sortKey, setSortKey] = useState<SortKey>("revenue_won");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const { data, isLoading } = useManagers(accountId, period);
  const managerNames = useManagerNames(accountId);

  const managers = (data?.managers ?? []).slice().sort((a, b) => {
    const av = a[sortKey] as number;
    const bv = b[sortKey] as number;
    return sortDir === "desc" ? bv - av : av - bv;
  });

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else { setSortKey(key); setSortDir("desc"); }
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-gray-900">Менеджеры</h1>
        <div className="flex rounded-lg border border-gray-200 overflow-hidden text-sm">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              onClick={() => setPeriod(p.value)}
              className={`px-3 py-1.5 font-medium transition-colors ${
                period === p.value
                  ? "bg-brand-600 text-white"
                  : "bg-white text-gray-600 hover:bg-gray-50"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-xs text-gray-500 uppercase tracking-wide">
              <th className="text-left px-5 py-3 font-medium w-8">#</th>
              <th className="text-left px-5 py-3 font-medium">Менеджер</th>
              {COLUMNS.map((col) => (
                <th key={col.key} className="text-right px-4 py-3 font-medium">
                  <button
                    onClick={() => toggleSort(col.key)}
                    className="flex items-center gap-1 ml-auto hover:text-gray-800"
                  >
                    {col.label}
                    {sortKey === col.key ? (
                      sortDir === "desc" ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />
                    ) : (
                      <ChevronDown className="w-3 h-3 opacity-30" />
                    )}
                  </button>
                </th>
              ))}
              <th className="text-right px-4 py-3 font-medium">Профиль</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {isLoading
              ? Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: COLUMNS.length + 3 }).map((_, j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="h-4 bg-gray-100 rounded animate-pulse" />
                      </td>
                    ))}
                  </tr>
                ))
              : managers.map((m, i) => {
                  const profile = m.profile as { strengths?: string[]; weaknesses?: string[] } | undefined;
                  return (
                    <tr key={m.user_amo_id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-5 py-3 text-gray-400 font-medium">{i + 1}</td>
                      <td className="px-5 py-3">
                        <Link
                          href={`/dashboard/managers/${m.user_amo_id}`}
                          className="font-medium text-gray-900 hover:text-brand-600"
                        >
                          {managerNames.get(m.user_amo_id) ?? `Manager #${m.user_amo_id}`}
                        </Link>
                        {profile?.weaknesses && profile.weaknesses.length > 0 && (
                          <p className="text-xs text-red-500 mt-0.5">
                            ⚠ {profile.weaknesses[0].replace(/_/g, " ")}
                          </p>
                        )}
                      </td>
                      {COLUMNS.map((col) => (
                        <td key={col.key} className="px-4 py-3 text-right font-medium text-gray-800">
                          {col.format(m[col.key] as number)}
                        </td>
                      ))}
                      <td className="px-4 py-3 text-right">
                        <Link
                          href={`/dashboard/managers/${m.user_amo_id}`}
                          className="text-brand-600 text-xs font-medium hover:underline"
                        >
                          Открыть →
                        </Link>
                      </td>
                    </tr>
                  );
                })}
          </tbody>
        </table>
        {!isLoading && managers.length === 0 && (
          <p className="text-center text-gray-400 text-sm py-10">Нет данных</p>
        )}
      </div>
    </div>
  );
}
