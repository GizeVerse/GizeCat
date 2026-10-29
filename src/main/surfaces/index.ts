// Public entry of the v1.1 surface provider (main process only).
export { createSurfaceProvider, DEFAULT_SURFACE_OPTIONS } from './provider';
export type { CatPosition, SurfaceProviderDebug, SurfaceProviderDeps, SurfaceProviderExtras, SurfaceProviderHandle, SurfaceProviderOptions, SurfaceTracker } from './provider';
export { coversWorkArea, defaultCornerRadiusDip, ledgeId, parseSurfaceId, stripId, wallId } from './windowSurfaces';
export { MAX_INJECTED_SURFACES, parseInjectedSurfaces } from './validate';
