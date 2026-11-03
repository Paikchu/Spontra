"use client"

import * as React from "react"
import { Slot } from "radix-ui"
import { omit } from "@/shared/analysis-runtime/omit"
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
  ...props
}: ComposedChartProps & { config: ChartConfig }) {
  const uniqueId = React.useId()
  const chartId = `chart-${id ?? uniqueId.replace(/:/g, "")}`

  return (
    <ChartContext.Provider value={{ config }}>
      <Slot.Root data-slot="chart" data-chart={chartId} {...omit(props, "asChild")} />
    </ChartContext.Provider>
  )
}

export function ChartTooltipContent(props: ComposedChartProps) {
  useChart()
  return <Slot.Root data-slot="chart-tooltip" {...omit(props, "asChild")} />
}

export function ChartLegendContent(props: ComposedChartProps) {
  useChart()
  return <Slot.Root data-slot="chart-legend" {...omit(props, "asChild")} />
}
