// 1.4.0 bundle rule for profile transfer: src/shared/profileTransfer.ts (and ipc.ts, settings.ts,
// catState.ts) build zod schemas at load, so the settings renderer and the settings preload may
// import them for types only. This walks the static import graph the way esbuild follows it
// (`import type` / `export type` are erased; any other import, even `import { type X }` under
// verbatimModuleSyntax, keeps the module) from both entry points (scripts/build.mjs) and checks that
// zod is never reached. REAL file reads, no bundler run. Written in the 1.4.0 mission, NOT executed there.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../..');

function resolveSpec(from: string, spec: string): string | null {
  const base = path.resolve(path.dirname(from), spec);
  for (const c of [`${base}.ts`, path.join(base, 'index.ts'), base]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
  return null;
}

/** Module specifiers a file imports at run time (type-only imports and re-exports left out). */
function valueImports(source: string): string[] {
  const src = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const out: string[] = [];
  const fromRe = /^\s*(?:import|export)\s+([^'";]*?)\s*from\s*['"]([^'"]+)['"]/gm;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(src))) if (!/^type\s/.test(m[1]!)) out.push(m[2]!);
  const bareRe = /^\s*import\s*['"]([^'"]+)['"]/gm;
  while ((m = bareRe.exec(src))) out.push(m[1]!);
  return out;
}

function walk(entry: string): { modules: Set<string>; external: Map<string, string[]>; unresolved: string[] } {
  const modules = new Set<string>();
  const external = new Map<string, string[]>();
  const unresolved: string[] = [];
  const queue = [path.resolve(ROOT, entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (modules.has(file)) continue;
    modules.add(file);
    for (const spec of valueImports(fs.readFileSync(file, 'utf8'))) {
      if (spec.startsWith('.')) {
        const r = resolveSpec(file, spec);
        if (r) queue.push(r);
        else unresolved.push(`${path.relative(ROOT, file)} -> ${spec}`);
      } else {
        external.set(spec, [...(external.get(spec) ?? []), path.relative(ROOT, file)]);
      }
    }
  }
  return { modules, external, unresolved };
}

const rel = (s: Set<string>): string[] => [...s].map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
const ZOD_MODULES = ['src/shared/profileTransfer.ts', 'src/shared/ipc.ts', 'src/shared/settings.ts', 'src/shared/catState.ts', 'src/shared/perception.ts'];

describe('settings window bundle stays free of zod (profile transfer is type-only there)', () => {
  it('the walker sees type-only imports as erased and the rest as kept', () => {
    expect(valueImports("import type { A } from './a';\nimport { b, type C } from './b';\nexport type { D } from './d';\nexport { e } from './e';\nimport './f';")).toEqual(['./b', './e', './f']);
  });

  it('src/renderer/settings/main.ts reaches the profile view but never zod or a zod-built module', () => {
    const g = walk('src/renderer/settings/main.ts');
    const mods = rel(g.modules);
    expect(g.unresolved).toEqual([]);
    expect(mods).toContain('src/renderer/settings/profileView.ts');
    expect(mods).toContain('src/renderer/settings/pages/personality.ts');
    for (const z of ZOD_MODULES) expect(mods, z).not.toContain(z);
    expect([...g.external.keys()].filter((k) => k === 'zod' || k.startsWith('zod/'))).toEqual([]);
  });

  it('src/preload/settings.ts imports nothing at run time but electron', () => {
    const g = walk('src/preload/settings.ts');
    expect(g.unresolved).toEqual([]);
    expect(rel(g.modules)).toEqual(['src/preload/settings.ts']);
    expect([...g.external.keys()]).toEqual(['electron']);
  });
});
