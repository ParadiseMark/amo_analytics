"use client";
import { LineChart, Line, ResponsiveContainer, Tooltip } from "recharts";

type Props = {
  data: number[];
  color?: string;
  height?: number;
};

export function Sparkline({ data, color = "#3b82f6", height = 40 }: Props) {
  const chartData = data.map((v, i) => ({ i, v }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={chartData}>
        <Line
          type="monotone"
          dataKey="v"
          stroke={color}
          dot={false}
          strokeWidth={1.5}
        />
        <Tooltip
          contentStyle={{ fontSize: 11, padding: "2px 6px" }}
          formatter={(v: number) => [v.toLocaleString("ru-RU"), ""]}
          labelFormatter={() => ""}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
