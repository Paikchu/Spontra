import { useEffect, useRef, useState } from "react";
import { Button } from "@/packages/web/src/ui/button";
import type { ProductOffering } from "@/shared/analysis-contract/business-explainer";
import { ProductBranches } from "./FlowChart";

/** A qualitative canvas when the accounting statement cannot safely use proportional bands. */
export function ProductRelationships({ name, amount, products, names, onClose, resetKey }: {
  name: string; amount: string | null; products: ProductOffering[]; names: string[]; onClose: () => void; resetKey: string;
}) {
  const offerings: ProductOffering[] = products.length ? products : names.slice(0, 8).map((name, i) => ({
    id: `legacy-${i}`, name, line: null, description: { text: "产品介绍待核实", sourceIds: [] }, charging: null, sourceIds: [],
  }));
  const height = Math.max(400, 85 + Math.max(1, offerings.length) * 94);
  const target = { x: 700, y: height / 2 - 25, h: 50, label: name };
  const [camera, setCamera] = useState({ x: 0, y: 0, zoom: 1 });
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; pointerId: number } | null>(null);
  useEffect(() => { drag.current = null; setCamera({ x: 0, y: 0, zoom: 1 }); }, [resetKey]);
  return <section className="product-map" aria-label={`${name} 产品归属图`}>
    <div className="fc-controls">
      <Button variant="outline" size="sm" aria-label="缩小产品画布" onClick={() => setCamera(c => ({ ...c, zoom: Math.max(.6, c.zoom / 1.2) }))}>−</Button>
      <Button variant="outline" size="sm" onClick={() => setCamera({ x: 0, y: 0, zoom: 1 })}>适应产品画布</Button>
      <Button variant="outline" size="sm" aria-label="放大产品画布" onClick={() => setCamera(c => ({ ...c, zoom: Math.min(3, c.zoom * 1.2) }))}>+</Button>
      <Button variant="outline" size="sm" onClick={onClose}>收起产品</Button>
    </div>
    <svg className="fc-svg" role="img" aria-label={`${name} 产品到业务关系，线宽不表示金额`} viewBox={`${camera.x} ${camera.y} ${1000 / camera.zoom} ${height / camera.zoom}`}
      onPointerDown={e => {
        if (e.button !== 0 || drag.current) return;
        drag.current = { x: e.clientX, y: e.clientY, cx: camera.x, cy: camera.y, pointerId: e.pointerId };
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={e => {
        const start = drag.current;
        if (!start || start.pointerId !== e.pointerId) return;
        const rect = e.currentTarget.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const x = start.cx - (e.clientX - start.x) * 1000 / camera.zoom / rect.width;
        const y = start.cy - (e.clientY - start.y) * height / camera.zoom / rect.height;
        // Capture coordinates now: React may run this updater after pointerup clears the ref.
        setCamera(c => ({ ...c, x, y }));
      }}
      onPointerUp={e => { if (drag.current?.pointerId === e.pointerId) drag.current = null; }} onPointerCancel={e => { if (drag.current?.pointerId === e.pointerId) drag.current = null; }} onLostPointerCapture={e => { if (drag.current?.pointerId === e.pointerId) drag.current = null; }}>
      <ProductBranches target={target} offerings={offerings} />
      <foreignObject x={700} y={target.y} width={270} height={110}><div className="fc-product-card"><strong>{name}</strong>{amount && <span>业务收入 {amount}</span>}<span>虚线表示产品归属</span></div></foreignObject>
    </svg>
  </section>;
}
