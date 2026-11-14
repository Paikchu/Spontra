import * as React from "react"
import { cn } from "cn"
import { messages, useLocale } from "../i18n"

const m = messages({ table: "Data table" }, { table: "数据表格" })

/** Table parts in the shadcn shape; each page styles them through `data-slot` and its own class. */
function Table({ className, ...props }: React.ComponentProps<"table">) {
  useLocale()
  const container = React.useRef<HTMLDivElement>(null)
  const [scrollable, setScrollable] = React.useState(false)
  React.useEffect(() => {
    const element = container.current
    if (!element) return
    const update = () => setScrollable(element.scrollWidth > element.clientWidth)
    const observer = new ResizeObserver(update)
    observer.observe(element)
    const table = element.querySelector("table")
    if (table) observer.observe(table)
    update()
    return () => observer.disconnect()
  }, [])
  return <div ref={container} data-slot="table-container" className="ui-table-container"
    tabIndex={scrollable ? 0 : undefined} role={scrollable ? "region" : undefined}
    aria-labelledby={scrollable ? props["aria-labelledby"] : undefined}
    aria-label={scrollable && !props["aria-labelledby"] ? props["aria-label"] ?? m.table : undefined}
  ><table data-slot="table" className={cn("ui-table", className)} {...props} /></div>
}

function TableHeader(props: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" {...props} />
}

function TableBody(props: React.ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" {...props} />
}

function TableRow(props: React.ComponentProps<"tr">) {
  return <tr data-slot="table-row" {...props} />
}

function TableHead({ scope = "col", ...props }: React.ComponentProps<"th">) {
  return <th data-slot="table-head" scope={scope} {...props} />
}

function TableCell(props: React.ComponentProps<"td">) {
  return <td data-slot="table-cell" {...props} />
}

function TableCaption(props: React.ComponentProps<"caption">) {
  return <caption data-slot="table-caption" {...props} />
}

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableCaption }
