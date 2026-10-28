import { AI_REACTIONS, SCENE_ENERGY, SCENE_TYPES } from '../../../shared/perception';
import { MAX_CAPTION_LENGTH } from '../../../core/perception/aiOutput';

/**
 * SceneReport as a JSON schema without numeric/length bounds, which several
 * structured-output implementations reject (Anthropic returns 400 for
 * minimum/maximum/maxLength). Bounds are enforced client-side by SceneReportSchema.
 */
export function portableSceneSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['scene', 'energy', 'interest', 'reaction', 'caption'],
    properties: {
      scene: { type: 'string', enum: [...SCENE_TYPES], description: 'Coarse kind of activity on screen.' },
      energy: { type: 'string', enum: [...SCENE_ENERGY] },
      interest: { type: 'number', description: 'From 0 to 1: how interesting this is for a curious cat.' },
      reaction: { type: 'string', enum: [...AI_REACTIONS] },
      caption: {
        type: 'string',
        description: `Generic description of the activity, at most ${MAX_CAPTION_LENGTH} characters, no names, numbers, URLs or quoted text.`,
      },
    },
  };
}
