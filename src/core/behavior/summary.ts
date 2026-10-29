// Settings-window summary of the cat. Contains only coarse, non-sensitive data.
import type { CatSummary } from '../../shared/catState';
import type { CatSim } from '../../shared/sim';

export function summarizeCat(sim: CatSim, name: string): CatSummary {
  const p = sim.serialize();
  return {
    name,
    catId: p.catId,
    bornAt: p.bornAt,
    state: sim.state,
    traits: { ...p.traits },
    stats: { ...p.stats },
    drives: { ...p.drives },
    counters: { ...p.memory.counters },
    preferences: { ...p.memory.preferences },
    favoriteSpotCount: p.memory.favoriteSpots.length,
    recent: p.memory.recent.map((e) => ({ ...e })),
  };
}
