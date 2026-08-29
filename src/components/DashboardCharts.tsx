import { Area, AreaChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { money } from "../lib/format";

export function VatChart({ data }: { data: Array<{ name: string; value: number; color: string }> }) {
  return (
    <ResponsiveContainer width="44%" height={210} minWidth={0}>
      <PieChart>
        <Pie data={data} innerRadius={58} outerRadius={86} paddingAngle={2} dataKey="value">
          {data.map((item) => <Cell key={item.name} fill={item.color} />)}
        </Pie>
        <Tooltip formatter={(value: unknown) => money(Number(value ?? 0))} />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function MetricSparkline({ data }: { data: Array<{ value: number }> }) {
  // 99% rather than 100%: a ResponsiveContainer at exactly 100% never shrinks
  // back when its parent narrows, which pushes the chart past the card at
  // fractional zoom factors.
  return (
    <ResponsiveContainer width="99%" height={48} minWidth={0}>
      <AreaChart data={data} margin={{ right: 2 }}>
        <Area type="monotone" dataKey="value" stroke="currentColor" fill="currentColor" fillOpacity={0.08} strokeWidth={2} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
