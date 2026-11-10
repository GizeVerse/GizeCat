import type { AppStatus, SettingsAction, SettingsViewState } from '../../../shared/ipc';
import type { PerceptionMode, VisualFeatures } from '../../../shared/perception';
import type { Settings } from '../../../shared/settings';
import { MAX_EXCLUDED_PROCESSES, MAX_EXCLUDED_TITLE_PATTERNS } from '../catalog';
import type { PageContext, PageView } from '../context';
import {
  button,
  group,
  keyValues,
  listEditorRow,
  page,
  radioGroup,
  row,
  segmentedRow,
  setNote,
  statusLine,
  stopsSliderRow,
  toggleSwitch,
  withBusy,
  type RadioItem,
} from '../controls';
import { openDialog } from '../dialog';
import { glyphText, h, icon, type GlyphName } from '../dom';
import { NUMERIC_FIELDS, intervalStops } from '../fields';
import { formatPercent, formatRelativeTime } from '../format';
import { bannerModel, consentModel, pauseModel } from '../privacyView';
import { errorText } from '../store';
import { deviceWords, platformWording, S, type PlatformWording } from '../strings';
import { validateProcessName, validateTitlePattern } from '../validate';

const P = S.privacy;
type VisualMode = Settings['perception']['visualMode'];

const BANNER_ICON: Record<PerceptionMode, GlyphName> = { off: 'shield', 'local-stats': 'lock', 'ai-local': 'robot', 'ai-cloud': 'cloud' };
const HOW_ICONS: readonly GlyphName[] = ['view', 'history', 'monitor', 'delete', 'hide'];

/**
 * The "Apps" row's hint and placeholder (1.4.0). The list holds Windows program names, so where main
 * reports screen analysis unavailable it says that the list does nothing. Windows (and no platform
 * report) keeps its text, also when analysis is unavailable there.
 */
export function processRowText(status: Pick<AppStatus, 'platform'>): { hint: string; placeholder: string } {
  const platform = status.platform;
  const cap = platform?.capabilities.perception;
  if (!platform || platform.id === 'win32' || !cap || cap.available) return { hint: S.validation.processHint, placeholder: P.processesPlaceholder };
  return { hint: S.validation.processHintUnavailable, placeholder: P.processesPlaceholderUnavailable };
}

function banner(ctx: PageContext): HTMLElement {
  const glyph = icon('shield', 'banner-icon');
  const title = h('div', { class: 'banner-title' });
  const text = h('div', { class: 'banner-text' });
  const details = h('ul', { class: 'banner-details' });
  const el = h('div', { class: 'banner', role: 'status', 'aria-live': 'polite' }, [glyph, h('div', { class: 'banner-body' }, [title, text, details])]);
  ctx.store.subscribe((view) => {
    const m = bannerModel(view, ctx.now());
    el.className = `banner mode-${m.mode}${m.paused ? ' is-paused' : ''}`;
    glyph.textContent = glyphText(m.paused ? 'pause' : BANNER_ICON[m.mode]);
    title.textContent = m.title;
    text.textContent = m.text;
    details.replaceChildren(...m.details.map((d) => h('li', { text: d })));
  });
  return el;
}

/** A mode's description in this platform's words (1.4.0). Off Windows, "Off" cannot say the cat knows where windows are. */
export function visualModeDesc(mode: VisualMode, wording: PlatformWording): string {
  return deviceWords(mode === 'off' && wording !== 'windows' ? P.modeOffDescFloorOnly : P.modes[mode].desc, wording);
}

function modeChooser(ctx: PageContext, wording: PlatformWording): HTMLElement[] {
  const parts = row({ title: P.modeLabel, stacked: true, hideTitle: true });
  const container = h('div', { class: 'option-cards', 'aria-labelledby': parts.titleId });
  const modes: readonly VisualMode[] = ['off', 'local-stats', 'ai'];
  const items: Array<RadioItem<VisualMode>> = modes.map((mode) => ({
    value: mode,
    el: h('button', { type: 'button', class: `option-card option-${mode}` }, [
      h('span', { class: 'radio-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'option-text' }, [h('span', { class: 'option-title', text: P.modes[mode].title }), h('span', { class: 'option-desc', text: visualModeDesc(mode, wording) })]),
    ]),
  }));
  container.append(...items.map((i) => i.el));
  parts.control.append(container);

  const consentLine = h('div', { class: 'consent-line' });
  const consentText = h('span');
  const revoke = button(P.revoke, { icon: 'close' });
  consentLine.append(icon('completed', 'consent-icon'), consentText, revoke);
  parts.control.append(consentLine);
  const status = statusLine();
  parts.control.append(status);

  let busy = false;
  const act = async (action: SettingsAction, success?: string): Promise<void> => {
    busy = true;
    container.setAttribute('aria-busy', 'true');
    try {
      const res = await ctx.api.action(action);
      if (res.ok) setNote(status, res.message ?? success ?? null, 'ok');
      else setNote(status, S.errors.actionFailed(res.message ?? S.errors.unexpected), 'error');
    } catch (e) {
      setNote(status, S.errors.actionFailed(errorText(e)), 'error');
    } finally {
      busy = false;
      container.removeAttribute('aria-busy');
    }
    try {
      await ctx.refresh();
    } catch {
      handle.set(ctx.store.settings.perception.visualMode);
    }
  };

  const choose = async (mode: VisualMode): Promise<void> => {
    if (busy) return;
    const settings = ctx.store.settings;
    const current = settings.perception.visualMode;
    if (mode === current && (mode === 'off' || settings.perception.consentAt !== null)) return;
    if (mode === 'off') {
      handle.set('off');
      await act('revokeConsent', P.revoked);
      return;
    }
    const model = consentModel(mode, settings, wording);
    const body = [
      h('p', { text: model.intro }),
      h('ul', { class: 'bullets' }, model.points.map((p) => h('li', { text: p }))),
      model.destination
        ? h('div', { class: `dest dest-${model.tone}` }, [h('div', { class: 'dest-title', text: model.destinationTitle ?? '' }), h('div', { text: model.destination })])
        : null,
      model.warning ? h('p', { class: 'dialog-warning' }, [icon('warning'), h('span', { text: model.warning })]) : null,
    ];
    const confirmed = await openDialog({ title: model.title, body, confirmLabel: model.confirmLabel, tone: model.tone });
    if (!confirmed) {
      handle.set(current);
      handle.focusSelected();
      return;
    }
    handle.set(mode);
    await act(mode === 'local-stats' ? 'grantLocalStatsConsent' : 'grantAiConsent');
  };
  const handle = radioGroup<VisualMode>(container, items, (mode) => void choose(mode), false);
  revoke.addEventListener('click', () => {
    if (busy) return;
    void withBusy(revoke, () => act('revokeConsent', P.revoked));
  });

  // Privacy pause goes through actions so main can update the tray at the same time.
  const pause = row({ title: P.pauseTitle, desc: wording === 'mac' ? P.pauseDescMac : P.pauseDesc, icon: 'pause' });
  const sw = toggleSwitch(pause.titleId, pause.describedBy);
  pause.control.append(sw.root);
  let pauseBusy = false;
  sw.input.addEventListener('change', () => {
    const wanted = sw.input.checked;
    pauseBusy = true;
    sw.input.disabled = true;
    void (async () => {
      try {
        const res = await ctx.api.action(wanted ? 'privacyPause' : 'privacyResume');
        setNote(pause.error, res.ok ? null : S.errors.actionFailed(res.message ?? S.errors.unexpected), 'error');
      } catch (e) {
        setNote(pause.error, S.errors.actionFailed(errorText(e)), 'error');
      }
      pauseBusy = false;
      sw.input.disabled = false;
      try {
        await ctx.refresh();
      } catch {
        syncPause(ctx.store.view);
      }
    })();
  });
  const syncPause = (view: SettingsViewState): void => {
    // The switch is the user's privacy pause only; a hidden cat or a locked PC is reported beside it.
    const m = pauseModel(view);
    setNote(pause.note, m.suspended ? deviceWords(P.suspended[m.suspended], wording) : null, 'info');
    if (pauseBusy) return;
    sw.input.checked = m.userPaused;
    sw.refresh();
  };

  ctx.store.subscribe((view) => {
    const p = view.settings.perception;
    if (!busy) handle.set(p.visualMode);
    const hasConsent = p.consentAt !== null;
    consentLine.hidden = !hasConsent && p.visualMode === 'off';
    const at = p.consentAt === null ? Number.NaN : Date.parse(p.consentAt);
    consentText.textContent = hasConsent && Number.isFinite(at) ? P.consentGiven(formatRelativeTime(at, ctx.now())) : '';
    syncPause(view);
  });
  return [parts.row, pause.row];
}

function featureRows(f: VisualFeatures): Array<readonly [string, string]> {
  return [
    [P.features.brightness, formatPercent(f.brightness)],
    [P.features.contrast, formatPercent(f.contrast)],
    [P.features.colorfulness, formatPercent(f.colorfulness)],
    [P.features.edgeDensity, formatPercent(f.edgeDensity)],
    [P.features.changeFraction, f.changeFraction === null ? S.format.missing : formatPercent(f.changeFraction)],
    [P.features.motion, formatPercent(f.motion)],
  ];
}

function previewRow(ctx: PageContext, wording: PlatformWording): HTMLElement {
  const parts = row({ title: P.previewTitle, desc: P.previewDesc, icon: 'view' });
  const btn = button(P.previewButton, { variant: 'accent' });
  parts.control.append(btn);
  const result = h('div', { class: 'preview', hidden: true });
  parts.row.append(result);
  const discard = button(S.common.close, { variant: 'subtle', icon: 'close' });
  discard.addEventListener('click', () => {
    result.hidden = true;
    result.replaceChildren();
    btn.focus();
  });
  btn.addEventListener('click', () => {
    void withBusy(btn, async () => {
      setNote(parts.error, null);
      try {
        const res = await ctx.api.previewPerception();
        if (!res.ok) {
          result.hidden = true;
          result.replaceChildren();
          setNote(parts.error, res.blockedReason ? deviceWords(P.previewBlocked(res.blockedReason), wording) : P.previewFailed, 'warn');
          return;
        }
        const img =
          typeof res.imageDataUrl === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(res.imageDataUrl)
            ? h('img', { class: 'preview-image', src: res.imageDataUrl, alt: res.imageDataUrl.startsWith('data:image/jpeg') ? P.previewImageAltAi : P.previewImageAlt })
            : null;
        const events = res.events ?? [];
        result.replaceChildren(
          h('div', { class: 'preview-grid' }, [
            img ?? h('div', { class: 'preview-image preview-empty', text: P.previewFailed }),
            h('div', { class: 'preview-data' }, [
              res.features ? keyValues(featureRows(res.features)) : null,
              h('div', { class: 'preview-events' }, [
                h('span', { class: 'kv-label', text: P.eventsLabel }),
                events.length === 0 ? h('span', { class: 'muted', text: P.noEvents }) : null,
                ...events.map((e) => h('span', { class: 'tag', text: P.events[e] })),
              ]),
            ]),
          ]),
          h('div', { class: 'preview-foot' }, [h('p', { class: 'preview-note' }, [icon('lock'), h('span', { text: img && res.imageDataUrl?.startsWith('data:image/jpeg') ? P.previewAiNote : P.previewNote })]), discard]),
        );
        result.hidden = false;
      } catch (e) {
        setNote(parts.error, S.errors.actionFailed(errorText(e)), 'error');
      }
    });
  });
  return parts.row;
}

export function privacyPage(ctx: PageContext): PageView {
  const wording = platformWording(ctx.store.view.status.platform);
  const how = h(
    'ul',
    { class: 'tips tips-compact' },
    P.how.map((item, i) =>
      h('li', { class: 'tip' }, [icon(HOW_ICONS[i] ?? 'info', 'tip-icon'), h('div', {}, [h('div', { class: 'tip-title', text: item.title }), h('div', { class: 'tip-text', text: deviceWords(item.text, wording) })])]),
    ),
  );
  const region = segmentedRow(
    ctx,
    'perception',
    'region',
    (['around-cat', 'active-window', 'display'] as const).map((v) => ({ value: v, label: P.regions[v] })),
    { title: P.regionTitle, desc: P.regionDesc, icon: 'monitor' },
  );
  const field = NUMERIC_FIELDS.perceptionInterval;
  const interval = stopsSliderRow(ctx, field, intervalStops(field.min, field.max), { title: P.intervalTitle, desc: P.intervalDesc, icon: 'history' });
  const processText = processRowText(ctx.store.view.status);
  const processes = listEditorRow(ctx, 'perception', 'excludedProcesses', {
    title: P.processesTitle,
    desc: P.processesDesc,
    icon: 'lock',
    placeholder: processText.placeholder,
    hint: processText.hint,
    validate: (text, existing) => validateProcessName(text, existing, MAX_EXCLUDED_PROCESSES),
    countLabel: P.entries,
  });
  const patterns = listEditorRow(ctx, 'perception', 'excludedTitlePatterns', {
    title: P.patternsTitle,
    desc: P.patternsDesc,
    icon: 'hide',
    placeholder: P.patternsPlaceholder,
    hint: S.validation.patternHint,
    validate: (text, existing) => validateTitlePattern(text, existing, MAX_EXCLUDED_TITLE_PATTERNS),
    countLabel: P.entries,
  });

  const element = page(P.title, [
    banner(ctx),
    group(P.groupMode, modeChooser(ctx, wording), P.groupModeDesc),
    group(P.groupHow, [how]),
    group(P.groupCapture, [region.parts.row, interval.parts.row]),
    group(P.groupExclusions, [processes.parts.row, patterns.parts.row], P.groupExclusionsDesc),
    group(P.groupPreview, [previewRow(ctx, wording)]),
  ]);
  return { id: 'privacy', title: P.title, element };
}
