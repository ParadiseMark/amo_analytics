import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatCurrency(amount: number): string {
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)} млн ₽`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(0)} тыс ₽`;
  return `${Math.round(amount)} ₽`;
}

export function formatPct(value: number, decimals = 0): string {
  return `${value.toFixed(decimals)}%`;
}

export function formatDelta(delta: number | null, unit = "%"): {
  label: string;
  positive: boolean;
} {
  if (delta == null) return { label: "—", positive: true };
  const sign = delta >= 0 ? "+" : "";
  return {
    label: `${sign}${delta.toFixed(1)}${unit}`,
    positive: delta >= 0,
  };
}

export function formatDays(days: number): string {
  const d = Math.round(days);
  return `${d} д`;
}

export function formatMinutes(minutes: number): string {
  const m = Math.round(minutes);
  if (m < 60) return `${m} мин`;
  return `${Math.floor(m / 60)}ч ${m % 60}м`;
}
