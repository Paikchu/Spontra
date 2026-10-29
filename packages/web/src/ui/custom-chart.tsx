"use client"

import * as React from "react"
import { Slot } from "radix-ui"
import { ChartContext, useChart, type ChartConfig } from "./chart-context"

export { useChart }
export type { ChartConfig }

type ComposedChartProps = React.ComponentProps<"div"> & {
  asChild: true
  children: React.ReactElement
}

/** Custom plots own their DOM and sizing; this path never loads a chart renderer. */
export function ChartContainer({
  id,
  config,
  asChild: _asChild,
  ...props
}: ComposedChartProps & { config: ChartConfig }) {
  const uniqueId = React.useId()
  const chartId = `chart-${id ?? uniqueId.replace(/:/g, "")}`

  return (
    <ChartContext.Provider value={{ config }}>
      <Slot.Root data-slot="chart" data-chart={chartId} {...props} />
    </ChartContext.Provider>
  )
}

export function ChartTooltipContent({ asChild: _asChild, ...props }: ComposedChartProps) {
  useChart()
  return <Slot.Root data-slot="chart-tooltip" {...props} />
}

export function ChartLegendContent({ asChild: _asChild, ...props }: ComposedChartProps) {
  useChart()
  return <Slot.Root data-slot="chart-legend" {...props} />
}
