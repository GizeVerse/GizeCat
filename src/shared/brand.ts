// Display names (ADR 0004 §9). Only what the user reads comes from here: UI strings, window
// titles, the tray tooltip, menus, dialogs and notices. Persistent identifiers (app id, userData
// folder, executable names, scheme, ...) are in identity.ts and never follow these names.

export const BRAND = Object.freeze({
  /** The platform the character belongs to. */
  platform: 'GizeVerse',
  /** The product and character name shown in the app. */
  product: 'GizeCat',
  /**
   * The name Windows shows for the installed app: the Start menu and desktop shortcuts, Settings ›
   * Apps › Installed apps and Task Manager › Startup apps. The installer names keep it until an
   * upgrade test on a disposable machine allows renaming them (ADR 0004 §9, Deferred), so any text
   * that tells the user what to find or click in Windows names this, not `product`.
   */
  installedName: 'Desktop Cat',
  /** The name the product had before GizeVerse ("formerly ..." on the About page). */
  formerName: 'Desktop Cat',
} as const);

export type Brand = typeof BRAND;
