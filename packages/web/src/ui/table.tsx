import * as React from "react"
import { cn } from "cn"

/** Table parts in the shadcn shape; each page styles them through `data-slot` and its own class. */
function Table({ className, ...props }: React.ComponentProps<"table">) {
  return <div data-slot="table-container" className="ui-table-container"><table data-slot="table" className={cn("ui-table", className)} {...props} /></div>
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
