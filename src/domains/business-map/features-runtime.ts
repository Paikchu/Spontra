import { FEATURES, LAYERS, type Feature, type Layer } from "./features-contract.ts";

/** Whether a request names one of the switchable features. */
export const isFeature = (value: unknown): value is Feature => typeof value === "string" && (FEATURES as readonly string[]).includes(value);

/** The layers above `layer`, nearest first: the ones a switch-off closes with it. */
export const layersAbove = (layer: Layer): Layer[] => LAYERS.slice(LAYERS.indexOf(layer) + 1);
