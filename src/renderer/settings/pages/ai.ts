import type { AppStatus } from '../../../shared/ipc';
import type { AiProviderId } from '../../../shared/settings';
import { MAX_MODEL_LENGTH, MAX_URL_LENGTH, PROVIDER_IDS } from '../catalog';
import type { PageContext, PageView } from '../context';
import {
  button,
  group,
  keyValues,
  page,
  radioGroup,
  row,
  setNote,
  sliderRow,
  statusLine,
  stopsSliderRow,
  textRow,
  toggleRow,
  withBusy,
  type RadioItem,
  type RowParts,
} from '../controls';
import { confirmDanger } from '../dialog';
import { h, icon } from '../dom';
import { NUMERIC_FIELDS, intervalStops } from '../fields';
import { formatLatency } from '../format';
import { providerTarget } from '../privacyView';
import { fieldId } from '../patch';
import type { FieldBinding } from '../store';
import { errorText } from '../store';
import { deviceWords, platformWording, S, type PlatformWording } from '../strings';
import { validateApiKey, validateBaseUrl, validateModel } from '../validate';

const A = S.ai;

function providerChooser(ctx: PageContext, wording: PlatformWording): HTMLElement {
  const parts = row({ title: A.providerLabel, stacked: true, hideTitle: true });
  const container = h('div', { class: 'option-cards option-cards-2', 'aria-labelledby': parts.titleId });
  const items: Array<RadioItem<AiProviderId>> = PROVIDER_IDS.map((id) => {
    const p = A.providers[id];
    return {
      value: id,
      el: h('button', { type: 'button', class: `option-card provider-${id}` }, [
        h('span', { class: 'radio-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'option-text' }, [
          h('span', { class: 'option-title' }, [p.title, p.badge ? h('span', { class: `badge badge-${id}`, text: p.badge }) : null]),
          h('span', { class: 'option-desc', text: deviceWords(p.desc, wording) }),
        ]),
      ]),
    };
  });
  container.append(...items.map((i) => i.el));
  parts.control.append(container);
  const binding: FieldBinding = {
    field: fieldId('ai', 'provider'),
    isBusy: () => false,
    sync: (v) => handle.set(v as AiProviderId),
    showError: (msg) => setNote(parts.error, msg, 'error'),
  };
  const handle = radioGroup<AiProviderId>(
    container,
    items,
    (id) => {
      handle.set(id);
      ctx.store.set('ai', 'provider', id, { origin: binding });
    },
    false,
  );
  ctx.store.bind(binding);
  return parts.row;
}

function urlRow(ctx: PageContext, key: 'ollamaBaseUrl' | 'openaiBaseUrl', desc: string, wording: PlatformWording): { parts: RowParts; refresh(): void } {
  let loopback = true;
  let note: HTMLElement | null = null;
  const refresh = (): void => {
    if (!note) return;
    if (loopback) setNote(note, null);
    else setNote(note, deviceWords(S.validation.urlRemote, wording), ctx.store.intended('ai', 'allowCloud') ? 'info' : 'warn');
  };
  const r = textRow(ctx, 'ai', key, {
    title: A.baseUrlTitle,
    desc,
    icon: 'globe',
    validate: validateBaseUrl,
    toValue: (v) => v.url,
    maxLength: MAX_URL_LENGTH,
    placeholder: A.urlPlaceholder,
    wide: true,
    onValue: (value) => {
      const parsed = validateBaseUrl(value);
      loopback = !parsed.ok || parsed.value.loopback;
      refresh();
    },
  });
  note = r.parts.note;
  refresh();
  return { parts: r.parts, refresh };
}

function modelRow(ctx: PageContext, key: 'ollamaModel' | 'openaiModel' | 'anthropicModel', desc: string, max: number, listable: boolean, wording: PlatformWording): RowParts {
  const r = textRow(ctx, 'ai', key, {
    title: A.modelTitle,
    desc,
    icon: 'robot',
    validate: (t) => validateModel(t, max),
    toValue: (v) => v,
    maxLength: max,
    placeholder: A.modelPlaceholder,
  });
  if (!listable) return r.parts;
  const listBtn = button(A.listModels, { variant: 'standard' });
  r.parts.control.append(listBtn);
  const results = h('div', { class: 'model-results', hidden: true });
  r.parts.row.append(results);
  listBtn.addEventListener('click', () => {
    void withBusy(listBtn, async () => {
      results.hidden = true;
      try {
        await ctx.store.flush();
        const res = await ctx.api.listModels();
        if (!res.ok) {
          setNote(r.parts.error, deviceWords(A.modelsFailed(res.error ?? S.errors.unexpected), wording), 'error');
          return;
        }
        setNote(r.parts.error, null);
        if (res.models.length === 0) {
          results.replaceChildren(h('p', { class: 'muted', text: A.modelsNone }));
        } else {
          const picks = res.models.slice(0, 100).map((m) => {
            const b = h('button', { type: 'button', class: 'tag tag-button', text: m });
            b.addEventListener('click', () => {
              const v = validateModel(m, max);
              if (!v.ok) {
                setNote(r.parts.error, v.error, 'error');
                return;
              }
              ctx.store.set('ai', key, v.value);
              r.input.value = v.value;
              results.hidden = true;
              r.input.focus();
            });
            return b;
          });
          results.replaceChildren(h('p', { class: 'muted', text: A.modelsFound(res.models.length) }), h('div', { class: 'tag-list' }, picks));
        }
        results.hidden = false;
      } catch (e) {
        setNote(r.parts.error, A.modelsFailed(errorText(e)), 'error');
      }
    });
  });
  return r.parts;
}

/**
 * The API-key row's description (1.4.0): who encrypts the key on this platform. Windows (and no
 * platform report) keeps the pre-1.4.0 text; macOS names its Keychain; elsewhere the system's secure
 * storage, as src/main/store/secretStore.ts says it.
 */
export function apiKeyDesc(provider: 'anthropic' | 'openai-compatible', platform: AppStatus['platform']): string {
  const wording = platformWording(platform);
  if (provider === 'anthropic') return wording === 'mac' ? A.keyDescAnthropicMac : wording === 'elsewhere' ? A.keyDescAnthropicElsewhere : A.keyDescAnthropic;
  return wording === 'mac' ? A.keyDescOpenaiMac : wording === 'elsewhere' ? A.keyDescOpenaiElsewhere : A.keyDescOpenai;
}

function apiKeyRow(ctx: PageContext, provider: 'anthropic' | 'openai-compatible'): RowParts {
  let desc = apiKeyDesc(provider, ctx.store.view.status.platform);
  const parts = row({ title: A.keyTitle, desc, icon: 'lock' });
  const descEl = parts.row.querySelector<HTMLElement>('.row-desc');
  const state = h('span', { class: 'key-state' });
  const replace = button(A.keyReplace);
  const clear = button(A.keyClear, { variant: 'subtle' });
  parts.control.append(state, replace, clear);

  const inputId = `apikey-${provider}`;
  const input = h('input', {
    type: 'password',
    id: inputId,
    class: 'text-input text-wide',
    autocomplete: 'off',
    spellcheck: 'false',
    maxlength: 1000,
    'aria-label': A.keyInputLabel,
    'aria-describedby': parts.describedBy,
  });
  const save = button(S.common.save, { variant: 'accent' });
  const cancel = button(S.common.cancel);
  const editor = h('div', { class: 'key-editor', hidden: true }, [input, save, cancel]);
  parts.row.insertBefore(editor, parts.note);

  const stored = (): boolean => (provider === 'anthropic' ? ctx.store.view.apiKeys.anthropic : ctx.store.view.apiKeys.openaiCompatible);
  const close = (): void => {
    input.value = '';
    editor.hidden = true;
    replace.hidden = false;
  };
  replace.addEventListener('click', () => {
    editor.hidden = false;
    replace.hidden = true;
    setNote(parts.note, null);
    input.focus();
  });
  cancel.addEventListener('click', () => {
    close();
    setNote(parts.error, null);
    replace.focus();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save.click();
    else if (e.key === 'Escape') cancel.click();
  });
  save.addEventListener('click', () => {
    const v = validateApiKey(input.value);
    if (!v.ok) {
      setNote(parts.error, v.error, 'error');
      return;
    }
    void withBusy(save, async () => {
      try {
        const res = await ctx.api.setApiKey(provider, v.value);
        if (res.ok) {
          setNote(parts.error, null);
          setNote(parts.note, A.keySaved, 'ok');
          close();
        } else {
          setNote(parts.error, S.errors.actionFailed(res.message ?? S.errors.unexpected), 'error');
        }
      } catch (e) {
        setNote(parts.error, S.errors.actionFailed(errorText(e)), 'error');
      } finally {
        input.value = '';
      }
      await ctx.refresh().catch(() => undefined);
    });
  });
  clear.addEventListener('click', () => {
    void (async () => {
      const ok = await confirmDanger(A.keyClearTitle, A.keyClearText, A.keyClearConfirm);
      if (!ok) return;
      await withBusy(clear, async () => {
        try {
          const res = await ctx.api.setApiKey(provider, null);
          if (res.ok) setNote(parts.note, A.keyCleared, 'ok');
          else setNote(parts.error, S.errors.actionFailed(res.message ?? S.errors.unexpected), 'error');
        } catch (e) {
          setNote(parts.error, S.errors.actionFailed(errorText(e)), 'error');
        }
        await ctx.refresh().catch(() => undefined);
      });
    })();
  });
  ctx.store.subscribe((view) => {
    const nextDesc = apiKeyDesc(provider, view.status.platform);
    if (descEl && nextDesc !== desc) {
      desc = nextDesc;
      descEl.textContent = nextDesc;
    }
    const has = stored();
    state.textContent = has ? A.keyStored : A.keyNotSet;
    state.classList.toggle('is-set', has);
    clear.hidden = !has;
    const label = replace.querySelector('.btn-label');
    if (label) label.textContent = has ? A.keyReplace : A.keySet;
  });
  return parts;
}

export function aiPage(ctx: PageContext): PageView {
  const wording = platformWording(ctx.store.view.status.platform);
  const visionStatus = h('span');
  const toPrivacy = button(A.openPrivacy, { variant: 'subtle', icon: 'chevronRight' });
  toPrivacy.addEventListener('click', () => ctx.navigate('privacy'));
  const intro = h('div', { class: 'callout' }, [
    icon('lightbulb', 'callout-icon'),
    h('div', {}, [h('p', { class: 'callout-text', text: A.optionalNote }), h('p', { class: 'callout-text callout-status' }, [visionStatus, toPrivacy])]),
  ]);

  const providerRow = providerChooser(ctx, wording);
  const providerNote = providerRow.querySelector<HTMLElement>('.row-note') ?? h('div', { class: 'row-note' });
  const ollamaUrl = urlRow(ctx, 'ollamaBaseUrl', A.ollamaUrlDesc, wording);
  const openaiUrl = urlRow(ctx, 'openaiBaseUrl', A.openaiUrlDesc, wording);
  const connection = {
    ollama: [ollamaUrl.parts.row, modelRow(ctx, 'ollamaModel', deviceWords(A.ollamaModelDesc, wording), MAX_MODEL_LENGTH.ollama, true, wording).row],
    'openai-compatible': [
      openaiUrl.parts.row,
      modelRow(ctx, 'openaiModel', A.openaiModelDesc, MAX_MODEL_LENGTH.openai, true, wording).row,
      apiKeyRow(ctx, 'openai-compatible').row,
    ],
    anthropic: [modelRow(ctx, 'anthropicModel', A.anthropicModelDesc, MAX_MODEL_LENGTH.anthropic, false, wording).row, apiKeyRow(ctx, 'anthropic').row],
  } as const;
  const noConnection = h('div', { class: 'row row-empty' }, [h('p', { class: 'muted', text: A.noConnection })]);
  const connectionGroup = group(A.groupConnection, [noConnection, ...connection.ollama, ...connection['openai-compatible'], ...connection.anthropic]);

  const allowCloud = toggleRow(ctx, 'ai', 'allowCloud', { title: A.allowCloudTitle, desc: deviceWords(A.allowCloudDesc, wording), icon: 'cloud' });

  const F = NUMERIC_FIELDS;
  const limits = [
    stopsSliderRow(ctx, F.aiInterval, intervalStops(F.aiInterval.min, F.aiInterval.max), { title: A.aiIntervalTitle, desc: A.aiIntervalDesc, icon: 'history' }),
    sliderRow(ctx, F.aiMaxPerHour, { title: A.maxPerHourTitle, desc: A.maxPerHourDesc, icon: 'clock' }),
    sliderRow(ctx, F.aiTimeout, { title: A.timeoutTitle, desc: A.timeoutDesc, icon: 'stopwatch' }),
  ];

  const test = row({ title: A.testTitle, desc: A.testDesc, icon: 'refresh' });
  const testBtn = button(A.testButton, { variant: 'accent' });
  test.control.append(testBtn);
  const testResult = statusLine();
  const testDetails = h('div', { class: 'test-details', hidden: true });
  test.row.append(testResult, testDetails);
  testBtn.addEventListener('click', () => {
    void withBusy(testBtn, async () => {
      setNote(testResult, S.common.working, 'info');
      testDetails.hidden = true;
      try {
        await ctx.store.flush();
        const res = await ctx.api.testAi();
        setNote(testResult, deviceWords([res.ok ? A.testOk : A.testFailed, res.message].filter((l) => l.length > 0).join(' '), wording), res.ok ? 'ok' : 'error');
        const entries: Array<readonly [string, string]> = [];
        if (res.latencyMs !== undefined) entries.push([A.testLatencyLabel, formatLatency(res.latencyMs)]);
        if (res.report) {
          entries.push([A.testSceneLabel, S.format.list(res.report.scene, res.report.energy)], [A.testReactionLabel, res.report.reaction]);
          if (res.report.caption) entries.push([A.testCaption, res.report.caption]);
        }
        testDetails.replaceChildren(keyValues(entries));
        testDetails.hidden = entries.length === 0;
      } catch (e) {
        setNote(testResult, S.errors.actionFailed(errorText(e)), 'error');
      }
    });
  });

  const element = page(A.title, [
    intro,
    group(A.groupProvider, [providerRow]),
    connectionGroup,
    group(A.groupCloud, [allowCloud.parts.row]),
    group(A.groupLimits, limits.map((l) => l.parts.row)),
    group(A.groupTest, [test.row]),
  ]);

  ctx.store.subscribe((view) => {
    const provider = ctx.store.intended('ai', 'provider');
    noConnection.hidden = provider !== 'none';
    for (const [id, rows] of Object.entries(connection)) for (const r of rows) r.hidden = id !== provider;
    testBtn.disabled = provider === 'none';
    const cloud = ctx.store.intended('ai', 'allowCloud');
    const target = providerTarget({ ...view.settings, ai: { ...view.settings.ai, provider } });
    if (target.leavesDevice) {
      setNote(providerNote, deviceWords(cloud ? A.sendsOffDevice(target.label) : A.needsAllowCloud(target.label), wording), cloud ? 'warn' : 'info');
    } else if (target.destination === 'local') {
      // A server on this PC can still forward to cloud models main cannot recognise.
      setNote(providerNote, deviceWords(A.localServer(target.host), wording), 'info');
    } else {
      setNote(providerNote, null);
    }
    setNote(allowCloud.parts.note, cloud ? A.allowCloudWarning : null, 'warn');
    ollamaUrl.refresh();
    openaiUrl.refresh();
    const visionOn = view.settings.perception.visualMode === 'ai';
    visionStatus.textContent = visionOn ? A.visionOn : A.visionOff;
  });

  return { id: 'ai', title: A.title, element };
}
