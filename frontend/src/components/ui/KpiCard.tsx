import { cn, formatDelta } from "@/lib/utils";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { Sparkline } from "./Sparkline";

type Props = {
  label: string;
  value: string | number;
  delta?: number | null;
  deltaUnit?: string;
  subtitle?: string;
  sparkline?: number[];
  sparklineColor?: string;
  className?: string;
};

export function KpiCard({
  label,
  value,
  delta,
  deltaUnit = "%",
  subtitle,
  sparkline,
  sparklineColor,
  className,
}: Props) {
  const { label: deltaLabel, positive } = formatDelta(delta ?? null, deltaUnit);
  const hasDelta = delta != null;

  return (
    <div className={cn("bg-white rounded-xl border border-gray-200 p-5", className)}>
      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-bold text-gray-900 mt-1.5">{value}</p>

      {hasDelta && (
        <div
          className={cn(
            "flex items-center gap-1 mt-2 text-xs font-medium",
            positive ? "text-green-600" : "text-red-500"
          )}
        >
          {positive ? (
            <TrendingUp className="w-3.5 h-3.5" />
          ) : delta === 0 ? (
            <Minus className="w-3.5 h-3.5" />
          ) : (
            <TrendingDown className="w-3.5 h-3.5" />
          )}
          <span>{deltaLabel} vs предыдущий период</span>
        </div>
      )}

      {subtitle && <p className="text-xs text-gray-400 mt-1">{subtitle}</p>}

      {sparkline && sparkline.length > 1 && (
        <div className="mt-3 -mx-1">
          <Sparkline data={sparkline} color={sparklineColor} height={36} />
        </div>
      )}
    </div>
  );
}
