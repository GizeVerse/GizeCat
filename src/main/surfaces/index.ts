// Public entry of the v1.1 surface provider (main process only).
export { createSurfaceProvider, DEFAULT_SURFACE_OPTIONS } from './provider';
export type { CatPosition, ScreenEdgeGuard, SurfaceProviderDebug, SurfaceProviderDeps, SurfaceProviderExtras, SurfaceProviderHandle, SurfaceProviderOptions, SurfaceTracker } from './provider';
export { computeEdgeBands, edgeBandStats } from './edgeBands';
export type { EdgeBandStats } from './edgeBands';
export { coversWorkArea, defaultCornerRadiusDip, ledgeId, parseSurfaceId, stripId, wallId } from './windowSurfaces';
export { MAX_INJECTED_SURFACES, parseInjectedSurfaces } from './validate';
