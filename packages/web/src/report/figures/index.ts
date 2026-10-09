/**
 * Report figure library. Every chart a report can show lives here; data comes from the stored,
 * application-built report (trends and figures), never from model output.
 */
export { readableTrend, SecTrendFigure, SecTrendSource } from "./SecTrendFigure.tsx";
export { findSecFigure, SecFigureSource, SecFigureView } from "./SecFigure.tsx";
