import type { PerceptionService } from '../contracts';
import { createElectronFrameCapturer } from './capture';
import { createPerceptionServiceWith, type PerceptionServiceDeps } from './service';

export type { FrameCapturer, CaptureRequest, CapturedFrame, CaptureDisplay } from './capture';
export { createElectronFrameCapturer, CaptureError } from './capture';
export type { PerceptionServiceDeps, PerceptionHostWithExclusions, PerceptionRequestReason } from './service';
export { createPerceptionServiceWith, PERCEPTION_LIMITS } from './service';
export type { VisionAdapter, AdapterFactory, AdapterFactoryInput, AdapterFactoryResult } from './adapters';
export { createVisionAdapter } from './adapters';

/**
 * Creates the perception service. Without `capture`, the Electron desktopCapturer
 * backend is used (call after app 'ready').
 */
export function createPerceptionService(deps: PerceptionServiceDeps): PerceptionService {
  return createPerceptionServiceWith({ ...deps, capture: deps.capture ?? createElectronFrameCapturer(deps.logger) });
}
