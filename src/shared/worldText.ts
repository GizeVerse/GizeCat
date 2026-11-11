// The words of the world events: display names and one-line descriptions for the status and settings
// UIs, and the journal sentence for every event + outcome. Plain English data (translation tables can
// mirror it), no logic beyond lookup, platform-agnostic. The journal tone is warm and quiet: no
// exclamation marks, no guilt, no streaks. The outcome tokens per event are listed here too, so a UI or
// a test can verify coverage; a core test checks that they equal the engine's catalogue.
import type { AnyEventId, OutcomeId } from './companion';

export interface EventText {
  /** Display name. */
  name: string;
  /** One line for the settings list and the status panel. */
  description: string;
  /** Used when an outcome has no sentence of its own (and for history written by an older or newer build). */
  fallback: string;
  /** Journal sentence per outcome token. */
  outcomes: Readonly<Record<string, string>>;
}

export const EVENT_TEXT: Readonly<Record<AnyEventId, EventText>> = {
  mouseEncounter: {
    name: 'Little Mouse',
    description: 'A tiny mouse scurries across the floor, and always gets away.',
    fallback: 'A little mouse ran across the floor and slipped away.',
    outcomes: {
      watched: 'A little mouse ran across the floor. The cat watched it go.',
      sneaked: 'A little mouse came out. The cat crept after it, slow and low, and it slipped away.',
      chased: 'A little mouse dashed across the floor. The cat gave a good chase, and the mouse made it to its hole.',
      approached: 'A little mouse appeared. The cat wandered over to say hello, and the mouse scampered off.',
    },
  },
  miniTsunami: {
    name: 'Mini Tsunami',
    description: 'A small, harmless wave rolls along the floor.',
    fallback: 'A small wave rolled along the floor and was gone.',
    outcomes: {
      hopped: 'A small wave rolled in. The cat hopped right over it.',
      moved: 'A small wave rolled in. The cat stepped out of its way and watched it pass.',
      climbed: 'A small wave rolled in. The cat climbed up to keep its paws dry.',
      wet: 'A small wave rolled in and the cat got a little wet. It shook itself dry and carried on.',
    },
  },
  butterflyEncounter: {
    name: 'Butterfly',
    description: 'A butterfly flutters by and flits away when approached.',
    fallback: 'A butterfly fluttered through and flew away.',
    outcomes: {
      watched: 'A butterfly fluttered by. The cat watched it for a while.',
      followed: 'A butterfly fluttered by. The cat followed it, slowly, until it flew away.',
      chased: 'A butterfly fluttered by. The cat chased it around, and it danced out of reach.',
    },
  },
  fallingLeaf: {
    name: 'Falling Leaf',
    description: 'A leaf drifts down from above.',
    fallback: 'A leaf drifted down and settled on the floor.',
    outcomes: {
      followed: 'A leaf drifted down. The cat followed it with its eyes all the way to the floor.',
      tapped: 'A leaf drifted down. Once it landed, the cat gave it a tap.',
      inspected: 'A leaf drifted down. The cat came over to sniff it.',
    },
  },
  yarnTrouble: {
    name: 'Yarn Trouble',
    description: 'A ball of yarn rolls in and invites a little play.',
    fallback: 'A ball of yarn rolled in and the cat played with it for a bit.',
    outcomes: {
      played: 'A ball of yarn rolled in. The cat played with it for a while.',
      tangled: 'A ball of yarn rolled in. The cat got briefly tangled up, then wriggled free and tidied its fur.',
      rolled: 'A ball of yarn rolled in. The cat batted it across the floor and ran after it.',
    },
  },
  littleGhost: {
    name: 'Little Ghost',
    description: 'A tiny, friendly ghost floats by and vanishes.',
    fallback: 'A tiny ghost floated by and vanished without a trace.',
    outcomes: {
      startled: 'A tiny ghost floated by. The cat jumped, hid for a moment, then peeked out.',
      hid: 'A tiny ghost floated by. The cat stayed hidden until it was gone.',
      investigated: 'A tiny ghost floated by. The cat crept over to investigate, and it faded away.',
      approached: 'A tiny ghost floated by. The cat walked up to it as if it were an old friend.',
    },
  },
  boxAppears: {
    name: 'Cardboard Box',
    description: 'A cardboard box appears. Nothing is more interesting.',
    fallback: 'A cardboard box appeared for a while.',
    outcomes: {
      investigated: 'A cardboard box appeared. The cat gave it a thorough sniff.',
      entered: 'A cardboard box appeared. The cat climbed in and sat there, perfectly content.',
      rested_beside: 'A cardboard box appeared. The cat settled down beside it for a rest.',
    },
  },
  mysteriousBall: {
    name: 'Mysterious Ball',
    description: 'A ball rolls in from nowhere.',
    fallback: 'A ball rolled in from nowhere and stopped.',
    outcomes: {
      watched: 'A ball rolled in from nowhere. The cat watched it settle.',
      tapped: 'A ball rolled in from nowhere. The cat gave it a tap and sent it rolling.',
      chased: 'A ball rolled in from nowhere. The cat ran after it across the floor.',
    },
  },
  thunderstorm: {
    name: 'Little Thunderstorm',
    description: 'A small cloud rains and rumbles near the cat.',
    fallback: 'A small storm cloud passed over, rained a little and rumbled away.',
    outcomes: {
      hid: 'A small storm cloud rumbled overhead. The cat hid until the rain passed.',
      calm: 'A small storm cloud rumbled overhead. The cat sat through it calmly.',
      startled: 'A small storm cloud rumbled overhead. The cat flinched at the thunder, then settled.',
    },
  },
  flyingFish: {
    name: 'Flying Fish',
    description: 'A small fish leaps in a long arc and splashes down.',
    fallback: 'A small fish leapt across the screen and splashed down.',
    outcomes: {
      startled: 'A small fish leapt right over the cat, which was quite startled.',
      watched: 'A small fish leapt in a long arc. The cat watched it splash down.',
      hopped: 'A small fish leapt over. The cat hopped up to meet it, but it was too quick.',
    },
  },
  tinyUfo: {
    name: 'Tiny UFO',
    description: 'A very small flying saucer crosses the sky.',
    fallback: 'A tiny flying saucer crossed the sky and zipped away.',
    outcomes: {
      watched: 'A tiny flying saucer crossed the sky. The cat watched it go.',
      followed: 'A tiny flying saucer crossed the sky. The cat followed it along the floor.',
      startled: 'A tiny flying saucer appeared overhead. The cat startled, then calmed down.',
    },
  },
  windGust: {
    name: 'Wind Gust',
    description: 'A gust of wind blows leaves and paper past.',
    fallback: 'A gust of wind swept through and blew a few light things past.',
    outcomes: {
      braced: 'A gust of wind swept through. The cat crouched low until it passed.',
      reacted: 'A gust of wind swept through. The cat startled, then smoothed its ruffled fur.',
      followed: 'A gust of wind swept through. The cat trotted after a leaf it carried along.',
    },
  },
  paperPlane: {
    name: 'Paper Plane',
    description: 'A paper plane glides across and lands softly.',
    fallback: 'A paper plane glided across and landed on the floor.',
    outcomes: {
      watched: 'A paper plane glided across. The cat watched it land.',
      chased: 'A paper plane glided across. The cat ran after it until it landed.',
      inspected: 'A paper plane glided across. Once it landed, the cat came over to inspect it.',
    },
  },
  magicSparkles: {
    name: 'Magic Sparkles',
    description: 'A few sparkles twinkle near the floor.',
    fallback: 'A few sparkles twinkled near the floor and faded.',
    outcomes: {
      reached: 'A few sparkles twinkled near the floor. The cat reached out to touch them.',
      watched: 'A few sparkles twinkled near the floor. The cat watched them fade.',
      sniffed: 'A few sparkles twinkled near the floor. The cat leaned in to sniff them.',
    },
  },
  shadowVisitor: {
    name: 'Shadow Visitor',
    description: 'A harmless dark shape slides by and fades.',
    fallback: 'A harmless shadow slid by and faded away.',
    outcomes: {
      investigated: 'A harmless shadow slid by. The cat crept closer to investigate, and it faded.',
      cautious: 'A harmless shadow slid by. The cat kept a careful distance until it was gone.',
      startled: 'A harmless shadow slid by. The cat startled and hid for a moment.',
    },
  },
  toySpring: {
    name: 'Toy Spring',
    description: 'A springy toy bounces around.',
    fallback: 'A springy toy bounced by for a while.',
    outcomes: {
      played: 'A springy toy bounced in. The cat batted it around for a while.',
      watched: 'A springy toy bounced in. The cat watched it boing.',
      hopped: 'A springy toy bounced in. The cat hopped along with it.',
    },
  },
  bubbleParty: {
    name: 'Bubble Party',
    description: 'Small bubbles drift up and pop.',
    fallback: 'A few small bubbles drifted up and popped.',
    outcomes: {
      watched: 'Small bubbles drifted up. The cat watched them float and pop.',
      popped: 'Small bubbles drifted up. The cat popped a few of them.',
      hopped: 'Small bubbles drifted up. The cat hopped and patted at them, one after another.',
    },
  },
  curiousBird: {
    name: 'Curious Bird',
    description: 'A small bird lands, hops about and flies off.',
    fallback: 'A small bird landed, hopped around and flew away.',
    outcomes: {
      watched: 'A small bird landed nearby. The cat watched it hop around until it flew off.',
      followed: 'A small bird landed nearby. The cat crept after it, and it flew off.',
      chattered: 'A small bird landed nearby. The cat chattered at it, and it flew away.',
    },
  },
  fallingStar: {
    name: 'Falling Star',
    description: 'A star crosses the upper sky.',
    fallback: 'A star streaked across the sky and was gone.',
    outcomes: {
      watched: 'A star streaked across the sky. The cat watched it go.',
      wished: 'A star streaked across the sky. The cat sat quietly, as if making a wish.',
      amazed: 'A star streaked across the sky. The cat gave a little meow of wonder.',
    },
  },
  tinyTreasure: {
    name: 'Tiny Treasure',
    description: 'A tiny treasure turns up on the floor.',
    fallback: 'The cat found a tiny treasure on the floor.',
    outcomes: {
      coin: 'The cat found a shiny little coin on the floor and gave it a long look.',
      gem: 'The cat found a small sparkling gem on the floor and sat with it for a while.',
      shell: 'The cat found a tiny shell on the floor and sniffed it carefully.',
      button: 'The cat found a round little button on the floor and inspected it closely.',
    },
  },
  goldenButterfly: {
    name: 'Golden Butterfly',
    description: 'A rare golden butterfly lingers and leaves a trail of sparkles.',
    fallback: 'A golden butterfly drifted by, leaving a trail of sparkles.',
    outcomes: {
      watched: 'A rare golden butterfly drifted by. The cat watched it, quite still, until it was gone.',
      followed: 'A rare golden butterfly drifted by. The cat followed it gently, trail of sparkles and all.',
      danced: 'A rare golden butterfly drifted by. The cat and the butterfly danced for a little while.',
    },
  },
  treasureDiscovery: {
    name: 'Treasure Discovery',
    description: 'A rare little chest appears and bursts into sparkles.',
    fallback: 'A little chest appeared and burst into sparkles.',
    outcomes: {
      opened: 'A little treasure chest appeared. The cat nosed it open and a burst of sparkles rose up.',
      sniffed: 'A little treasure chest appeared. The cat sniffed it, and sparkles drifted out.',
      pawed: 'A little treasure chest appeared. The cat tapped it with a paw and sparkles scattered.',
    },
  },
  friendlyGhost: {
    name: 'Friendly Ghost',
    description: 'A rare, softly glowing ghost keeps the cat company for a moment.',
    fallback: 'A softly glowing ghost kept the cat company for a moment.',
    outcomes: {
      befriended: 'A softly glowing ghost drifted over and kept the cat company. They sat together for a while.',
      watched: 'A softly glowing ghost drifted by. The cat watched it follow along, then fade.',
      played: 'A softly glowing ghost drifted over. The cat played with it until it faded away.',
    },
  },
  meteorShower: {
    name: 'Meteor Shower',
    description: 'A rare shower of small meteors crosses the upper sky.',
    fallback: 'A small meteor shower streaked across the sky.',
    outcomes: {
      watched: 'A small meteor shower streaked across the sky. The cat watched every one.',
      wished: 'A small meteor shower streaked across the sky. The cat sat beneath it, quietly wishing.',
      amazed: 'A small meteor shower streaked across the sky. The cat meowed softly at the lights.',
    },
  },
  tinyDragon: {
    name: 'Tiny Dragon',
    description: 'A rare tiny dragon hovers and puffs little sparkles.',
    fallback: 'A tiny dragon hovered nearby, puffing little sparkles.',
    outcomes: {
      watched: 'A tiny friendly dragon hovered nearby, puffing sparkles. The cat watched, wide-eyed.',
      played: 'A tiny friendly dragon hovered nearby, puffing sparkles. The cat played along.',
      startled: 'A tiny friendly dragon swooped in. The cat startled at first, then relaxed.',
    },
  },
  midnightVisitor: {
    name: 'Midnight Visitor',
    description: 'A rare, quiet silhouette visits late at night.',
    fallback: 'A quiet silhouette visited in the middle of the night and left again.',
    outcomes: {
      watched: 'A quiet silhouette visited in the dark. The cat watched it come and go.',
      greeted: 'A quiet silhouette visited in the dark. The cat went to greet it with a soft meow.',
      hid: 'A quiet silhouette visited in the dark. The cat kept out of sight until it left.',
    },
  },
};

/** The outcome tokens per event that have a sentence of their own (engine-level 'cut' and 'unnoticed' use the fallback). */
export const EVENT_OUTCOME_TOKENS: Readonly<Record<AnyEventId, readonly string[]>> = Object.fromEntries(
  (Object.keys(EVENT_TEXT) as AnyEventId[]).map((id) => [id, Object.keys(EVENT_TEXT[id].outcomes)]),
) as unknown as Record<AnyEventId, readonly string[]>;

const GENERIC = 'Something small and unexpected happened.';

export function eventName(id: AnyEventId): string {
  return EVENT_TEXT[id]?.name ?? String(id);
}

export function eventDescription(id: AnyEventId): string {
  return EVENT_TEXT[id]?.description ?? '';
}

/** The journal sentence for an event and its outcome; the event's fallback for an unknown outcome, a generic line for an unknown event. */
export function journalText(id: AnyEventId, outcome: OutcomeId): string {
  const t = EVENT_TEXT[id];
  if (!t) return GENERIC;
  // Own properties only: an outcome token that happens to name an Object.prototype member (a hand-edited
  // file can carry 'constructor') must fall back to the event's sentence, never return a non-string.
  return Object.prototype.hasOwnProperty.call(t.outcomes, outcome) ? (t.outcomes[outcome] ?? t.fallback) : t.fallback;
}

/**
 * A locale-independent date for a journal line: 'YYYY-MM-DD' in the viewer's local time. Plain getters,
 * no Intl, so Electron, the Android WebView and the tests all print the same thing. Empty for a bad time.
 */
export function formatJournalDate(at: number): string {
  if (!Number.isFinite(at)) return '';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
