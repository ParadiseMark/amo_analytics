import { cn } from "@/lib/utils";
import { AlertTriangle, AlertCircle } from "lucide-react";

type Props = {
  severity: "warning" | "critical";
  label: string;
};

export function AlertBadge({ severity, label }: Props) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full",
        severity === "critical"
          ? "bg-red-50 text-red-700"
          : "bg-yellow-50 text-yellow-700"
      )}
    >
      {severity === "critical" ? (
        <AlertCircle className="w-3 h-3" />
      ) : (
        <AlertTriangle className="w-3 h-3" />
      )}
      {label}
    </span>
  );
}
