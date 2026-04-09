"use client";
import { useStuckDeals, useManagerNames } from "@/lib/hooks";
import { useAccountId } from "@/lib/account-context";
import { formatCurrency } from "@/lib/utils";

export default function StuckDealsPage() {
  const accountId = useAccountId();
  const { data, isLoading } = useStuckDeals(accountId);
  const managerNames = useManagerNames(accountId);

  const deals = data?.deals ?? [];

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Зависшие сделки</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Открытые сделки без активности более 7 дней
          </p>
        </div>
        {!isLoading && (
          <span className="text-sm font-semibold text-orange-600 bg-orange-50 px-3 py-1.5 rounded-lg">
            {deals.length} сделок
          </span>
        )}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 text-xs text-gray-500 uppercase tracking-wide">
              <th className="text-left px-5 py-3 font-medium">Сделка</th>
              <th className="text-right px-4 py-3 font-medium">Сумма</th>
              <th className="text-right px-4 py-3 font-medium">Менеджер</th>
              <th className="text-right px-4 py-3 font-medium">Воронка</th>
              <th className="text-right px-5 py-3 font-medium">Без активности</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {isLoading
              ? Array.from({ length: 8 }).map((_, i) => (
                  <tr key={i}>
                    {Array.from({ length: 5 }).map((_, j) => (
                      <td key={j} className="px-4 py-3">
                        <div className="h-4 bg-gray-100 rounded animate-pulse" />
                      </td>
                    ))}
                  </tr>
                ))
              : deals.map((d) => {
                  const urgency =
                    d.days_inactive > 30
                      ? "bg-red-50 text-red-700"
                      : d.days_inactive > 14
                      ? "bg-orange-50 text-orange-700"
                      : "bg-yellow-50 text-yellow-700";

                  return (
                    <tr key={d.amo_id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-5 py-3">
                        <p className="font-medium text-gray-900">{d.name || `Сделка #${d.amo_id}`}</p>
                        <p className="text-xs text-gray-400">ID: {d.amo_id}</p>
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-gray-800">
                        {formatCurrency(d.price)}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-600">
                        {managerNames.get(d.responsible_user_amo_id) ?? `#${d.responsible_user_amo_id}`}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-600">
                        #{d.pipeline_amo_id}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <span className={`text-xs font-semibold px-2 py-1 rounded-full ${urgency}`}>
                          {Math.round(d.days_inactive)} дн
                        </span>
                      </td>
                    </tr>
                  );
                })}
          </tbody>
        </table>
        {!isLoading && deals.length === 0 && (
          <p className="text-center text-gray-400 text-sm py-12">Зависших сделок нет ✓</p>
        )}
      </div>
    </div>
  );
}
