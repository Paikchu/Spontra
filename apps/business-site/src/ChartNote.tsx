import { Info } from "lucide-react";
import { Popover } from "radix-ui";

/** Keep chart caveats available by keyboard and touch without a permanent text badge. */
export function ChartNote({ label, children }: { label: string; children: string }) {
  return <Popover.Root>
    <Popover.Trigger className="chart-note" aria-label={label}><Info size={14} aria-hidden="true" /></Popover.Trigger>
    <Popover.Portal><Popover.Content className="chart-note-content" sideOffset={6} collisionPadding={12}>
      {children}
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
