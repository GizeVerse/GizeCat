import { DEFAULT_EXCLUDED_PROCESSES } from '../../shared/settings';
import type { AppCategory } from '../../shared/world';

/** Lower-case basename of an executable path ("C:\\X\\Code.exe" -> "code.exe"). */
export function exeBasename(path: string): string {
  const trimmed = path.trim();
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  return trimmed.slice(cut + 1).toLowerCase();
}

const stripExe = (name: string): string => (name.endsWith('.exe') ? name.slice(0, -4) : name);

const CATEGORY_TABLE: ReadonlyArray<readonly [AppCategory, readonly string[]]> = [
  ['sensitive', DEFAULT_EXCLUDED_PROCESSES],
  [
    'code',
    [
      'code.exe', 'code - insiders.exe', 'vscodium.exe', 'cursor.exe', 'windsurf.exe', 'zed.exe', 'devenv.exe',
      'idea64.exe', 'idea.exe', 'pycharm64.exe', 'webstorm64.exe', 'rider64.exe', 'clion64.exe', 'goland64.exe',
      'phpstorm64.exe', 'rubymine64.exe', 'datagrip64.exe', 'studio64.exe', 'fleet.exe', 'sublime_text.exe',
      'notepad++.exe', 'eclipse.exe', 'gvim.exe', 'nvim-qt.exe', 'neovide.exe', 'emacs.exe', 'runemacs.exe',
      'atom.exe', 'brackets.exe', 'unity.exe', 'unrealeditor.exe', 'godot.exe', 'qtcreator.exe', 'lapce.exe',
      'kate.exe', 'github desktop.exe', 'githubdesktop.exe', 'sourcetree.exe', 'gitkraken.exe', 'postman.exe',
      'insomnia.exe', 'dbeaver.exe', 'ssms.exe',
    ],
  ],
  [
    'terminal',
    [
      'windowsterminal.exe', 'wt.exe', 'openconsole.exe', 'conhost.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe',
      'wezterm-gui.exe', 'alacritty.exe', 'mintty.exe', 'putty.exe', 'kitty.exe', 'hyper.exe', 'tabby.exe',
      'warp.exe', 'mobaxterm.exe', 'conemu64.exe', 'conemu.exe', 'cmder.exe', 'fluent terminal.exe',
    ],
  ],
  [
    'browser',
    [
      'chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'vivaldi.exe', 'arc.exe', 'iexplore.exe',
      'librewolf.exe', 'waterfox.exe', 'zen.exe', 'floorp.exe', 'chromium.exe', 'thorium.exe', 'palemoon.exe',
      'tor.exe', 'yandex.exe', 'whale.exe', 'maxthon.exe',
    ],
  ],
  [
    'video',
    [
      'vlc.exe', 'mpc-hc64.exe', 'mpc-hc.exe', 'mpc-be64.exe', 'mpc-be.exe', 'potplayermini64.exe',
      'potplayermini.exe', 'potplayer.exe', 'mpv.exe', 'wmplayer.exe', 'video.ui.exe', 'microsoft.media.player.exe',
      'kmplayer.exe', 'plex.exe', 'plex htpc.exe', 'stremio.exe', 'kodi.exe', 'jellyfin media player.exe',
      'smplayer.exe', 'gom.exe', 'netflix.exe', 'disneyplus.exe', 'primevideo.exe',
    ],
  ],
  [
    'game',
    [
      'steam.exe', 'steamwebhelper.exe', 'epicgameslauncher.exe', 'battle.net.exe', 'riotclientservices.exe',
      'riotclientux.exe', 'leagueclient.exe', 'leagueclientux.exe', 'league of legends.exe', 'minecraft.exe',
      'minecraftlauncher.exe', 'robloxplayerbeta.exe', 'cs2.exe', 'csgo.exe', 'dota2.exe', 'gta5.exe', 'gta5_enhanced.exe',
      'overwatch.exe', 'eldenring.exe', 'rocketleague.exe', 'r5apex.exe', 'r5apex_dx12.exe', 'valorant.exe',
      'eaapp.exe', 'eadesktop.exe', 'origin.exe', 'upc.exe', 'ubisoftconnect.exe', 'galaxyclient.exe',
      'xboxpcapp.exe', 'gamebar.exe', 'playnite.desktopapp.exe', 'heroic.exe', 'osu!.exe', 'terraria.exe',
      'stardew valley.exe', 'hollow_knight.exe', 'factorio.exe', 'rimworldwin64.exe', 'witcher3.exe', 'cyberpunk2077.exe',
      'bg3.exe', 'bg3_dx11.exe', 'helldivers2.exe', 'destiny2.exe', 'wow.exe', 'genshinimpact.exe', 'starrail.exe',
    ],
  ],
  [
    'document',
    [
      'winword.exe', 'excel.exe', 'powerpnt.exe', 'onenote.exe', 'onenoteim.exe', 'msaccess.exe', 'mspub.exe',
      'visio.exe', 'acrobat.exe', 'acrord32.exe', 'sumatrapdf.exe', 'foxitpdfreader.exe', 'foxitphantompdf.exe',
      'notepad.exe', 'wordpad.exe', 'write.exe', 'soffice.exe', 'soffice.bin', 'swriter.exe', 'scalc.exe', 'simpress.exe',
      'obsidian.exe', 'notion.exe', 'typora.exe', 'logseq.exe', 'evernote.exe', 'joplin.exe', 'zotero.exe',
      'calibre.exe', 'ebook-viewer.exe', 'wps.exe', 'et.exe', 'wpp.exe', 'scrivener.exe', 'anytype.exe',
    ],
  ],
  [
    'chat',
    [
      'discord.exe', 'discordptb.exe', 'discordcanary.exe', 'slack.exe', 'teams.exe', 'ms-teams.exe', 'telegram.exe',
      'whatsapp.exe', 'whatsapp.root.exe', 'signal.exe', 'zoom.exe', 'skype.exe', 'element.exe', 'outlook.exe',
      'olk.exe', 'hxoutlook.exe', 'thunderbird.exe', 'messenger.exe', 'viber.exe', 'lync.exe', 'mattermost.exe',
      'rocket.chat.exe', 'webex.exe', 'ciscocollabhost.exe', 'line.exe', 'kakaotalk.exe', 'wechat.exe', 'weixin.exe',
      'mailspring.exe', 'em client.exe',
    ],
  ],
  [
    'design',
    [
      'figma.exe', 'photoshop.exe', 'illustrator.exe', 'indesign.exe', 'afterfx.exe', 'adobe premiere pro.exe',
      'lightroom.exe', 'xd.exe', 'blender.exe', 'inkscape.exe', 'krita.exe', 'paintdotnet.exe', 'mspaint.exe',
      'clipstudiopaint.exe', 'aseprite.exe', 'canva.exe', 'resolve.exe', 'designer.exe', 'photo.exe', 'publisher.exe',
      'affinity.exe', 'gimp.exe', 'gimp-2.10.exe', 'gimp-3.0.exe', 'darktable.exe', 'rawtherapee.exe', 'sketchup.exe',
      'acad.exe', 'fusion360.exe', 'freecad.exe', 'penpot.exe', 'lunacy.exe', 'paint.exe', 'davinci resolve.exe',
      'shotcut.exe', 'kdenlive.exe', 'vegas.exe', 'clipchamp.exe',
    ],
  ],
  [
    'media',
    [
      'spotify.exe', 'itunes.exe', 'applemusic.exe', 'musicbee.exe', 'foobar2000.exe', 'aimp.exe', 'winamp.exe',
      'tidal.exe', 'deezer.exe', 'music.ui.exe', 'audacity.exe', 'obs64.exe', 'obs32.exe', 'microsoft.photos.exe',
      'photos.exe', 'irfanview.exe', 'i_view64.exe', 'xnview.exe', 'nomacs.exe', 'imageglass.exe', 'honeyview.exe',
      'fl64.exe', 'ableton live 12 suite.exe', 'reaper.exe', 'soundcloud.exe', 'youtube music.exe', 'pocketcasts.exe',
    ],
  ],
  [
    'system',
    [
      'explorer.exe', 'taskmgr.exe', 'systemsettings.exe', 'mmc.exe', 'regedit.exe', 'control.exe', 'searchhost.exe',
      'searchapp.exe', 'startmenuexperiencehost.exe', 'shellexperiencehost.exe', 'textinputhost.exe', 'msiexec.exe',
      'rundll32.exe', 'dllhost.exe', 'perfmon.exe', 'resmon.exe', 'securityhealthhost.exe', 'smartscreen.exe',
      'msinfo32.exe', 'eventvwr.exe', 'services.exe', 'winver.exe', 'sndvol.exe', 'colorcpl.exe', 'snippingtool.exe',
      'screenclippinghost.exe', 'quickassist.exe', 'devicemanager.exe', 'cleanmgr.exe', 'dfrgui.exe', 'systempropertiesadvanced.exe',
    ],
  ],
];

const CATEGORY_BY_EXE: ReadonlyMap<string, AppCategory> = (() => {
  const m = new Map<string, AppCategory>();
  for (const [category, names] of CATEGORY_TABLE) for (const n of names) if (!m.has(n)) m.set(n, category);
  return m;
})();

/** Coarse category for an executable (basename or full path). Never inspects window content. */
export function categorizeProcess(exe: string): AppCategory {
  const name = exeBasename(exe);
  if (name === '') return 'unknown';
  const known = CATEGORY_BY_EXE.get(name) ?? CATEGORY_BY_EXE.get(`${stripExe(name)}.exe`);
  if (known) return known;
  // Unreal Engine shipping builds ("<Game>-Win64-Shipping.exe").
  if (/-win(64|32|gdk)-shipping(\.exe)?$/.test(name)) return 'game';
  return 'other';
}

/**
 * Privacy exclusion rules. Process entries are exe basenames (".exe" optional);
 * title patterns are case-insensitive substrings matched in memory only.
 */
export class ExclusionRules {
  private processes = new Set<string>();
  private titles: string[] = [];

  constructor(processes: readonly string[] = [], titlePatterns: readonly string[] = []) {
    this.set(processes, titlePatterns);
  }

  set(processes: readonly string[], titlePatterns: readonly string[]): void {
    this.processes = new Set(processes.map((p) => stripExe(exeBasename(p))).filter((p) => p.length > 0));
    this.titles = titlePatterns.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0);
  }

  get hasTitlePatterns(): boolean {
    return this.titles.length > 0;
  }

  matchesProcess(processName: string): boolean {
    const n = stripExe(exeBasename(processName));
    return n.length > 0 && this.processes.has(n);
  }

  /** The title is only inspected here and never stored. */
  matchesTitle(title: string): boolean {
    if (title.length === 0 || this.titles.length === 0) return false;
    const lower = title.toLowerCase();
    return this.titles.some((t) => lower.includes(t));
  }
}
