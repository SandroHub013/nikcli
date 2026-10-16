/**
 * Pixel art sprite definitions and color palette for the ADE splash screen.
 *
 * All sprites are pure data matrices (no external image files) using strict brand tokens
 * from `index.css` and `@ragu/ui/ragu-pot`.
 */

/** Brand color palette tokens used across all splash sprites. */
export const SPLASH_PALETTE: Record<string, string> = {
  ".": "transparent",
  a: "#120d0b", // inchiostro / dark outline (from --ade-glass-ground / --ade-bg dark)
  b: "#24501a", // basilico scuro (from --ade-done light / ragu-pot)
  c: "#7fb850", // basilico chiaro (from --ade-done dark)
  d: "#5a1712", // pomodoro scuro / terracotta (from ragu-pot)
  e: "#a3271b", // pomodoro medio (from --ade-accent-strong light)
  f: "#df4a2b", // pomodoro vivo (from --ade-accent-strong dark)
  g: "#e8dfcf", // vapore crema (from ragu-pot)
  h: "#f39a6b", // riflesso salsa / pelle cuoco (from ragu-pot)
  i: "#f4e7cd", // crema bordo / cappello cuoco (from --ade-text dark)
  j: "#fffaf0", // panna / riflessi bianchi (from --ade-surface light)
  k: "#845b00", // legno cucchiaio / pasta ocra (from --ade-working light)
  l: "#241e1b", // felpa developer (from --ade-raised dark)
  m: "#2d2722", // felpa ombra / tasca (from --ade-overlay dark)
} as const

export type PaletteKey = keyof typeof SPLASH_PALETTE

/** Dimensions of the canonical Ragu pot sprite. */
export const POT_SPRITE_SIZE = { width: 32, height: 32 } as const

/**
 * 8 sequential animation frames of the boiling pot (16x16 pixels).
 * Based on the canonical POT_16 grid from `@ragu/ui/ragu-pot`:
 * - Animated shifting steam curls;
 * - Bubbling ragù sauce with highlights;
 * - Bobbing lid that rattles from steam pressure on frames 2 and 6.
 */
export const POT_FRAMES: readonly (readonly string[])[] = [
  // Frame 0: Calm simmer, steam rising gently
  [
    "................g...............",
    "...........g.....g..............",
    "............g...g...............",
    "...........g.....g..............",
    "..........g.......g.............",
    "...........g.....g..............",
    "................................",
    "..............aaaa..............",
    "..............aaaa..............",
    "............aaaaaaaa...ac.......",
    ".........aaaaafffffaaaacba......",
    ".....aaaaafffffffffffffffccaaaa.",
    "....aiiiijjjjjiiiiiiiiiiiia.....",
    "....aiiiiiiiiiiiiiiiiiiiiia.....",
    "....addddddddddddddddddddda.....",
    "..aaaddfffffhffffffffffffddaaa..",
    ".a..addffhfffffffffffffffdda..a.",
    "a...addfhhffffffffhffffffdda...a",
    "a...addfhhfffffffffffffffdda...a",
    ".a..addffhfffffffffffffffdda..a.",
    "..aaaddeehfeeeeeeeeeeeeeeddaaa..",
    "....addeeheeeeeeeeeeeeeeedda....",
    "....addeeheeeeeeeeeeeeeeedda....",
    "....addeeeeeeeeeeeeeeeeeedda....",
    "....addeeeeeeeeeeeeeeeeeedda....",
    "....adddddddddddddddddddddda....",
    "....adddddddddddddddddddddda....",
    ".....aaddddddddddddddddaa.......",
    "......aaddddddddddddddaa........",
    ".......aaddddddddddddaa.........",
    ".........aaaaaaaaaaaa...........",
    "................................",
  ],
  // Frame 1: Steam curling upward, bubble growing in sauce
  [
    "............g.....g.............",
    ".............g...g..............",
    "............g.....g.............",
    "...........g.......g............",
    "..........g.........g...........",
    "...........g.......g............",
    "................................",
    "..............aaaa..............",
    "..............aaaa..............",
    "............aaaaaaaa...ac.......",
    ".........aaaaafffffaaaacba......",
    ".....aaaaafffffffffffffffccaaaa.",
    "....aiiiijjjjjiiiiiiiiiiiia.....",
    "....aiiiiiiiiiiiiiiiiiiiiia.....",
    "....addddddddddddddddddddda.....",
    "..aaaddfffffffhffffffffffddaaa..",
    ".a..addffhffffffffffjffffdda..a.",
    "a...addfhhfffffffffffffffdda...a",
    "a...addfhhfffffffffffffffdda...a",
    ".a..addffhfffffffffffffffdda..a.",
    "..aaaddeehfeeeeeeeeeeeeeeddaaa..",
    "....addeeheeeeeeeeeeeeeeedda....",
    "....addeeheeeeeeeeeeeeeeedda....",
    "....addeeeeeeeeeeeeeeeeeedda....",
    "....addeeeeeeeeeeeeeeeeeedda....",
    "....adddddddddddddddddddddda....",
    "....adddddddddddddddddddddda....",
    ".....aaddddddddddddddddaa.......",
    "......aaddddddddddddddaa........",
    ".......aaddddddddddddaa.........",
    ".........aaaaaaaaaaaa...........",
    "................................",
  ],
  // Frame 2: Lid bobs up 1px! Steam puffs out from boiling sauce!
  [
    ".......g.......g.......g........",
    "........g.....g.g.....g.........",
    ".........g...g...g...g..........",
    ".......g..g.g.....g.g..g........",
    "......g....g.......g....g.......",
    ".....g...................g......",
    "..............aaaa..............",
    "..............aaaa..............",
    "............aaaaaaaa...ac.......",
    ".........aaaaafffffaaaacba......",
    ".....aaaaafffffffffffffffccaaaa.",
    "....g.afffffhhffjfffffga.g......",
    "....aiiiijjjjjiiiiiiiiiiiia.....",
    "....aiiiiiiiiiiiiiiiiiiiiia.....",
    "....addddddddddddddddddddda.....",
    "..aaaddfffjffffffffffffffddaaa..",
    ".a..addffhfffffffhfffffffdda..a.",
    "a...addfhhfffffffffffffffdda...a",
    "a...addfhhffffffffffffhffdda...a",
    ".a..addffhfffffffffffffffdda..a.",
    "..aaaddeehfeeeeeeeeeeeeeeddaaa..",
    "....addeeheeeeeeeeeeeeeeedda....",
    "....addeeheeeeeeeeeeeeeeedda....",
    "....addeeeeeeeeeeeeeeeeeedda....",
    "....addeeeeeeeeeeeeeeeeeedda....",
    "....adddddddddddddddddddddda....",
    "....adddddddddddddddddddddda....",
    ".....aaddddddddddddddddaa.......",
    "......aaddddddddddddddaa........",
    ".......aaddddddddddddaa.........",
    ".........aaaaaaaaaaaa...........",
    "................................",
  ],
  // Frame 3: Lid settles back, pop of crema bubble
  [
    "....g........g.......g.....g....",
    ".....g......g.g.....g.....g.....",
    "......g....g...g...g.....g......",
    ".......g..g.....g.g.....g.......",
    "........g.........g....g........",
    ".........g.......g....g.........",
    "................................",
    "..............aaaa..............",
    "..............aaaa..............",
    "............aaaaaaaa...ac.......",
    ".........aaaaafffffaaaacba......",
    ".....aaaaafffffffffffffffccaaaa.",
    "....aiiiijjjjjiiiiiiiiiiiia.....",
    "....aiiiiiiiiiiiiiiiiiiiiia.....",
    "....addddddddddddddddddddda.....",
    "..aaaddffffffjfffffffffffddaaa..",
    ".a..addffhfffffffffffffffdda..a.",
    "a...addfhhfffffhfffffffffdda...a",
    "a...addfhhfffffffffffffffdda...a",
    ".a..addffhfffffffffffffffdda..a.",
    "..aaaddeehfeeeeeeeeeeeeeeddaaa..",
    "....addeeheeeeeeeeeeeeeeedda....",
    "....addeeheeeeeeeeeeeeeeedda....",
    "....addeeeeeeeeeeeeeeeeeedda....",
    "....addeeeeeeeeeeeeeeeeeedda....",
    "....adddddddddddddddddddddda....",
    "....adddddddddddddddddddddda....",
    ".....aaddddddddddddddddaa.......",
    "......aaddddddddddddddaa........",
    ".......aaddddddddddddaa.........",
    ".........aaaaaaaaaaaa...........",
    "................................",
  ],
  // Frame 4: Steam shifts right, bubbles form on body
  [
    "................g...............",
    "...........g...g................",
    "..........g.....g...............",
    "...........g...g................",
    "............g.g.................",
    ".............g..................",
    "................................",
    "..............aaaa..............",
    "..............aaaa..............",
    "............aaaaaaaa...ac.......",
    ".........aaaaafffffaaaacba......",
    ".....aaaaafffffffffffffffccaaaa.",
    "....aiiiijjjjjiiiiiiiiiiiia.....",
    "....aiiiiiiiiiiiiiiiiiiiiia.....",
    "....addddddddddddddddddddda.....",
    "..aaaddffffffffffffhfffffddaaa..",
    ".a..addffhfhfffffffffffffdda..a.",
    "a...addfhhfffffffffffffffdda...a",
    "a...addfhhfffffffffffffffdda...a",
    ".a..addffhfffffffffffffffdda..a.",
    "..aaaddeehfeeeeeeeeeeeeeeddaaa..",
    "....addeeheeeeeeeeeeeeeeedda....",
    "....addeeheeeeeeeeeeeeeeedda....",
    "....addeeeeeeeeeeeeeeeeeedda....",
    "....addeeeeeeeeeeeeeeeeeedda....",
    "....adddddddddddddddddddddda....",
    "....adddddddddddddddddddddda....",
    ".....aaddddddddddddddddaa.......",
    "......aaddddddddddddddaa........",
    ".......aaddddddddddddaa.........",
    ".........aaaaaaaaaaaa...........",
    "................................",
  ],
  // Frame 5: Double bubble in sauce, steam rising
  [
    ".........g...........g..........",
    "..........g.........g...........",
    ".........g...........g..........",
    "..........g.........g...........",
    "...........g.......g............",
    "............g.....g.............",
    "................................",
    "..............aaaa..............",
    "..............aaaa..............",
    "............aaaaaaaa...ac.......",
    ".........aaaaafffffaaaacba......",
    ".....aaaaafffffffffffffffccaaaa.",
    "....aiiiijjjjjiiiiiiiiiiiia.....",
    "....aiiiiiiiiiiiiiiiiiiiiia.....",
    "....addddddddddddddddddddda.....",
    "..aaaddffffffffjfffffffffddaaa..",
    ".a..addffhfffhfffffffffffdda..a.",
    "a...addfhhfffffffffffhfffdda...a",
    "a...addfhhfffffffffffffffdda...a",
    ".a..addffhfffffffffffffffdda..a.",
    "..aaaddeehfeeeeeeeeeeeeeeddaaa..",
    "....addeeheeeeeeeeeeeeeeedda....",
    "....addeeheeeeeeeeeeeeeeedda....",
    "....addeeeeeeeeeeeeeeeeeedda....",
    "....addeeeeeeeeeeeeeeeeeedda....",
    "....adddddddddddddddddddddda....",
    "....adddddddddddddddddddddda....",
    ".....aaddddddddddddddddaa.......",
    "......aaddddddddddddddaa........",
    ".......aaddddddddddddaa.........",
    ".........aaaaaaaaaaaa...........",
    "................................",
  ],
  // Frame 6: Second lid bob & rattle, steam escaping
  [
    "......g.........g.........g.....",
    ".......g.......g.g.......g......",
    "........g.....g...g.....g.......",
    "......g..g...g.....g...g..g.....",
    ".....g....g.g.......g.g....g....",
    "....g.......................g...",
    "..............aaaa..............",
    "..............aaaa..............",
    "............aaaaaaaa...ac.......",
    ".........aaaaafffffaaaacba......",
    ".....aaaaafffffffffffffffccaaaa.",
    "....g.afffffhhffjfffffga.g......",
    "....aiiiijjjjjiiiiiiiiiiiia.....",
    "....aiiiiiiiiiiiiiiiiiiiiia.....",
    "....addddddddddddddddddddda.....",
    "..aaaddffffhfffffffffffffddaaa..",
    ".a..addffhffffffjffffffffdda..a.",
    "a...addfhhfffffffffffffffdda...a",
    "a...addfhhffffffffffhffffdda...a",
    ".a..addffhfffffffffffffffdda..a.",
    "..aaaddeehfeeeeeeeeeeeeeeddaaa..",
    "....addeeheeeeeeeeeeeeeeedda....",
    "....addeeheeeeeeeeeeeeeeedda....",
    "....addeeeeeeeeeeeeeeeeeedda....",
    "....addeeeeeeeeeeeeeeeeeedda....",
    "....adddddddddddddddddddddda....",
    "....adddddddddddddddddddddda....",
    ".....aaddddddddddddddddaa.......",
    "......aaddddddddddddddaa........",
    ".......aaddddddddddddaa.........",
    ".........aaaaaaaaaaaa...........",
    "................................",
  ],
  // Frame 7: Settle and loop back smoothly
  [
    "................g...............",
    "...........g.....g..............",
    "..........g.......g.............",
    "...........g.....g..............",
    "............g...g...............",
    "...........g.....g..............",
    "................................",
    "..............aaaa..............",
    "..............aaaa..............",
    "............aaaaaaaa...ac.......",
    ".........aaaaafffffaaaacba......",
    ".....aaaaafffffffffffffffccaaaa.",
    "....aiiiijjjjjiiiiiiiiiiiia.....",
    "....aiiiiiiiiiiiiiiiiiiiiia.....",
    "....addddddddddddddddddddda.....",
    "..aaaddfffffffffhffffffffddaaa..",
    ".a..addffhfffffffffhfffffdda..a.",
    "a...addfhhfffffffffffffffdda...a",
    "a...addfhhfffffffffffffffdda...a",
    ".a..addffhfffffffffffffffdda..a.",
    "..aaaddeehfeeeeeeeeeeeeeeddaaa..",
    "....addeeheeeeeeeeeeeeeeedda....",
    "....addeeheeeeeeeeeeeeeeedda....",
    "....addeeeeeeeeeeeeeeeeeedda....",
    "....addeeeeeeeeeeeeeeeeeedda....",
    "....adddddddddddddddddddddda....",
    "....adddddddddddddddddddddda....",
    ".....aaddddddddddddddddaa.......",
    "......aaddddddddddddddaa........",
    ".......aaddddddddddddaa.........",
    ".........aaaaaaaaaaaa...........",
    "................................",
  ],
]

/** Dimensions of the human-scale developer sprite. */
export const DEVELOPER_SPRITE_SIZE = { width: 28, height: 34 } as const

/** Names of the 8 sequential developer poses. */
export const DEVELOPER_POSE_NAMES = [
  "pronto",
  "mescola_sinistra",
  "mescola_destra",
  "alza_cucchiaio",
  "assaggia",
  "contento",
  "pollice_su",
  "sorriso",
] as const

export type DeveloperPoseName = (typeof DEVELOPER_POSE_NAMES)[number]

/**
 * 8 human-scale developer poses in chef hat and hoodie with drawstrings (28x34 pixels):
 * Features:
 * - Puffy white/crema chef toque with folds;
 * - Hair peeking out under the hat;
 * - Expressive face: eyes, blush cheeks, smile/tasting mouth;
 * - Dark hoodie with hood, kangaroo pocket, and hanging cream drawstring laces;
 * - Visible arms and wooden ladle/spoon;
 * - Pants and shoes grounded on the kitchen floor.
 */
export const DEVELOPER_POSES: readonly (readonly string[])[] = [
  // 0: Pronto - Standing ready beside pot, holding wooden ladle upright
  [
    "........jjjjjjjj............",
    "......iijjjjjjjjii..........",
    ".....iiiijjjjjjiiii.........",
    ".....iiiijjjjjjiiii.........",
    "......iiiiiiiiiiii..........",
    ".......iiiiiiiiii...........",
    ".......bbbbbbbbbb...........",
    "........bbbbbbbb............",
    "......hhhhhhhh..............",
    "......hhhhhhhhh.............",
    ".....hhhbhbhhhh.............",
    ".....hhfhhhhfhh.............",
    "......hhhhhhhh..............",
    "......hhheehhh..............",
    ".......hhhhhh...............",
    "....cccciiiicccc....k.......",
    "...cccciiiiiicccccc..k......",
    "...cccciiiiiicccc.ch..k.....",
    "....cciiiggiiiccc......k....",
    "....cciiiiiiiicc........kk..",
    "....cciiiiiiiicc............",
    "....cciiggggiicc............",
    "....cciiggggiicc............",
    "....cciiiiiiiicc............",
    "....cciiiiiiiicc............",
    "....bbbbbbbbbbbb............",
    ".....bbbbbbbbbb.............",
    ".....ccc..ccc...............",
    ".....ccc..ccc...............",
    ".....ccc..ccc...............",
    ".....ccc..ccc...............",
    ".....ccc..ccc...............",
    "....kkkk..kkkk..............",
    "............................",
  ],
  // 1: Mescola sinistra - Leaning into pot, wooden ladle entering inside left rim
  [
    ".........jjjjjjjj...........",
    ".......iijjjjjjjjii.........",
    "......iiiijjjjjjiiii........",
    "......iiiijjjjjjiiii........",
    ".......iiiiiiiiiiii.........",
    "........iiiiiiiiii..........",
    "........bbbbbbbbbb..........",
    ".........bbbbbbbb...........",
    ".......hhhhhhhh.............",
    ".......hhhhhhhhh............",
    "......hhhbhbhhhh............",
    "......hhfhhhhfhh............",
    ".......hhhhhhhh.............",
    ".......hhheehhh.............",
    "........hhhhhh..............",
    ".....cccciiiiccccccc..k.....",
    "....cccciiiiiicccc.cch.k....",
    "....cccciiiiiicccc......k...",
    ".....cciiiggiiiccc......kf..",
    ".....cciiiiiiiicc...........",
    ".....cciiiiiiiicc...........",
    ".....cciiggggiicc...........",
    ".....cciiggggiicc...........",
    ".....cciiiiiiiicc...........",
    ".....cciiiiiiiicc...........",
    ".....bbbbbbbbbbbb...........",
    "......bbbbbbbbbb............",
    "......ccc..ccc..............",
    "......ccc..ccc..............",
    "......ccc..ccc..............",
    "......ccc..ccc..............",
    "......ccc..ccc..............",
    ".....kkkk..kkkk.............",
    "............................",
  ],
  // 2: Mescola destra - Stirring across pot, wooden ladle entering inside right rim
  [
    ".........jjjjjjjj...........",
    ".......iijjjjjjjjii.........",
    "......iiiijjjjjjiiii........",
    "......iiiijjjjjjiiii........",
    ".......iiiiiiiiiiii.........",
    "........iiiiiiiiii..........",
    "........bbbbbbbbbb..........",
    ".........bbbbbbbb...........",
    ".......hhhhhhhh.............",
    ".......hhhhhhhhh............",
    "......hhhbhbhhhh............",
    "......hhfhhhhfhh............",
    ".......hhhhhhhh.............",
    ".......hhheehhh.............",
    "........hhhhhh..............",
    ".....cccciiiiccccccccchk....",
    "....cccciiiiiicccc......k...",
    "....cccciiiiiicccc.......k..",
    ".....cciiiggiiiccc........kf",
    ".....cciiiiiiiicc...........",
    ".....cciiiiiiiicc...........",
    ".....cciiggggiicc...........",
    ".....cciiggggiicc...........",
    ".....cciiiiiiiicc...........",
    ".....cciiiiiiiicc...........",
    ".....bbbbbbbbbbbb...........",
    "......bbbbbbbbbb............",
    "......ccc..ccc..............",
    "......ccc..ccc..............",
    "......ccc..ccc..............",
    "......ccc..ccc..............",
    "......ccc..ccc..............",
    ".....kkkk..kkkk.............",
    "............................",
  ],
  // 3: Alza cucchiaio - Raising ladle out of pot with red ragù drip
  [
    "........jjjjjjjj............",
    "......iijjjjjjjjii..........",
    ".....iiiijjjjjjiiii.........",
    ".....iiiijjjjjjiiii.........",
    "......iiiiiiiiiiii..........",
    ".......iiiiiiiiii...........",
    ".......bbbbbbbbbb...........",
    "........bbbbbbbb............",
    "......hhhhhhhh..............",
    "......hhhhhhhhh......f......",
    ".....hhhbhbhhhh.....kk......",
    ".....hhfhhhhfhh.....k.f.....",
    "......hhhhhhhh.....k........",
    "......hhheehhh.....k........",
    ".......hhhhhh.....hh........",
    "....cccciiiicccc.c..........",
    "...cccciiiiiicccc...........",
    "...cccciiiiiicccc...........",
    "....cciiiggiiiccc...........",
    "....cciiiiiiiicc............",
    "....cciiiiiiiicc............",
    "....cciiggggiicc............",
    "....cciiggggiicc............",
    "....cciiiiiiiicc............",
    "....cciiiiiiiicc............",
    "....bbbbbbbbbbbb............",
    ".....bbbbbbbbbb.............",
    ".....ccc..ccc...............",
    ".....ccc..ccc...............",
    ".....ccc..ccc...............",
    ".....ccc..ccc...............",
    ".....ccc..ccc...............",
    "....kkkk..kkkk..............",
    "............................",
  ],
  // 4: Assaggia - Spoon brought right to mouth, eyes closed tasting
  [
    "........jjjjjjjj............",
    "......iijjjjjjjjii..........",
    ".....iiiijjjjjjiiii.........",
    ".....iiiijjjjjjiiii.........",
    "......iiiiiiiiiiii..........",
    ".......iiiiiiiiii...........",
    ".......bbbbbbbbbb...........",
    "........bbbbbbbb............",
    "......hhhhhhhh..............",
    "......hhhhhhhhh.............",
    ".....hhhbhbhhhh.............",
    ".....hhfhhhhfhh.............",
    "......hhhhhhhh..............",
    "......hhhffkkh..............",
    ".......hhhhhhkh.............",
    "....cccciiiicckc............",
    "...cccciiiiiicccc...........",
    "...cccciiiiiicccc...........",
    "....cciiiggiiiccc...........",
    "....cciiiiiiiicc............",
    "....cciiiiiiiicc............",
    "....cciiggggiicc............",
    "....cciiggggiicc............",
    "....cciiiiiiiicc............",
    "....cciiiiiiiicc............",
    "....bbbbbbbbbbbb............",
    ".....bbbbbbbbbb.............",
    ".....ccc..ccc...............",
    ".....ccc..ccc...............",
    ".....ccc..ccc...............",
    ".....ccc..ccc...............",
    ".....ccc..ccc...............",
    "....kkkk..kkkk..............",
    "............................",
  ],
  // 5: Contento - Broad smile of satisfaction, spoon lowered
  [
    "........jjjjjjjj............",
    "......iijjjjjjjjii..........",
    ".....iiiijjjjjjiiii.........",
    ".....iiiijjjjjjiiii.........",
    "......iiiiiiiiiiii..........",
    ".......iiiiiiiiii...........",
    ".......bbbbbbbbbb...........",
    "........bbbbbbbb............",
    "......hhhhhhhh..............",
    "......hhhhhhhhh.............",
    ".....hhhbhbhhhh.............",
    ".....hhfhhhhfhh.............",
    "......hhhhhhhh..............",
    "......hhheehhh..............",
    ".......hhhhhh...............",
    "....cccciiiicccc..kk........",
    "...cccciiiiiicccc.k.........",
    "...cccciiiiiicccck..........",
    "....cciiiggiiicck...........",
    "....cciiiiiiiicc............",
    "....cciiiiiiiicc............",
    "....cciiggggiicc............",
    "....cciiggggiicc............",
    "....cciiiiiiiicc............",
    "....cciiiiiiiicc............",
    "....bbbbbbbbbbbb............",
    ".....bbbbbbbbbb.............",
    ".....ccc..ccc...............",
    ".....ccc..ccc...............",
    ".....ccc..ccc...............",
    ".....ccc..ccc...............",
    ".....ccc..ccc...............",
    "....kkkk..kkkk..............",
    "............................",
  ],
  // 6: Pollice su - Enthusiastic thumbs up to the viewer
  [
    "........jjjjjjjj............",
    "......iijjjjjjjjii..........",
    ".....iiiijjjjjjiiii.........",
    ".....iiiijjjjjjiiii.........",
    "......iiiiiiiiiiii..........",
    ".......iiiiiiiiii...........",
    ".......bbbbbbbbbb...........",
    "........bbbbbbbb............",
    "......hhhhhhhh..............",
    "......hhhhhhhhh.............",
    ".....hhhbhbhhhh.............",
    ".....hhfhhhhfhh.............",
    "......hhhhhhhh..............",
    "......hhheehhh..............",
    "..h....hhhhhh...............",
    "..hhcccciiiicccc............",
    "...cccciiiiiicccc...........",
    "...cccciiiiiicccc..k........",
    "....cciiiggiiicccchk........",
    "....cciiiiiiiicc...kk.......",
    "....cciiiiiiiicc............",
    "....cciiggggiicc............",
    "....cciiggggiicc............",
    "....cciiiiiiiicc............",
    "....cciiiiiiiicc............",
    "....bbbbbbbbbbbb............",
    ".....bbbbbbbbbb.............",
    ".....ccc..ccc...............",
    ".....ccc..ccc...............",
    ".....ccc..ccc...............",
    ".....ccc..ccc...............",
    ".....ccc..ccc...............",
    "....kkkk..kkkk..............",
    "............................",
  ],
  // 7: Sorriso - Warm beaming smile, ladle ready for next stir
  [
    "........jjjjjjjj............",
    "......iijjjjjjjjii..........",
    ".....iiiijjjjjjiiii.........",
    ".....iiiijjjjjjiiii.........",
    "......iiiiiiiiiiii..........",
    ".......iiiiiiiiii...........",
    ".......bbbbbbbbbb...........",
    "........bbbbbbbb............",
    "......hhhhhhhh..............",
    "......hhhhhhhhh.............",
    ".....hhhbhbhhhh.............",
    ".....hhfhhhhfhh.............",
    "......hhhhhhhh..............",
    "......hhheehhh..............",
    ".......hhhhhh...............",
    "....cccciiiicccc............",
    "...cccciiiiiicccc..k........",
    "...cccciiiiiiccccchk........",
    "....cciiiggiiiccc...kk......",
    "....cciiiiiiiicc............",
    "....cciiiiiiiicc............",
    "....cciiggggiicc............",
    "....cciiggggiicc............",
    "....cciiiiiiiicc............",
    "....cciiiiiiiicc............",
    "....bbbbbbbbbbbb............",
    ".....bbbbbbbbbb.............",
    ".....ccc..ccc...............",
    ".....ccc..ccc...............",
    ".....ccc..ccc...............",
    ".....ccc..ccc...............",
    ".....ccc..ccc...............",
    "....kkkk..kkkk..............",
    "............................",
  ],
]

/** Laptop on desk with glowing colorful code editor lines (24x14 px). */
export const LAPTOP_SPRITE: readonly string[] = [
  ".....aaaaaaaaaaaaaaaaaa.",
  "....aiiiiiiiiiiiiiiiiiia",
  "...aiifffffffiiiiiiiiiaa",
  "...aiifff...cccc.kkk..ia",
  "...aii..ccccccc.ff....ia",
  "...aiiffff..kkk..cccc.ia",
  "...aii..cccc..ffff....ia",
  "...aiifff..iiii..cccc.ia",
  "...aiiiiiiiiiiiiiiiiiiaa",
  "...aaaaaaaaaaaaaaaaaaaaa",
  "..adddddddddddddddddddda",
  ".addddiiiiiiiiddddddddda",
  "adddddddddddddddddddddda",
  "aaaaaaaaaaaaaaaaaaaaaaaa",
] as const

export const LAPTOP_SIZE = {
  width: LAPTOP_SPRITE[0]!.length,
  height: LAPTOP_SPRITE.length,
} as const

/** Counter tomato (5x5 px). */
export const TOMATO_SPRITE: readonly string[] = [
  "..c..",
  ".affa",
  "affffa",
  "affeea",
  ".aaaa.",
] as const

export const TOMATO_SIZE = {
  width: TOMATO_SPRITE[0]!.length,
  height: TOMATO_SPRITE.length,
} as const

/** Counter fresh basil sprig (4x4 px). */
export const BASIL_SPRITE: readonly string[] = [
  "..c.",
  ".cca",
  "accb",
  ".aa.",
] as const

export const BASIL_SIZE = {
  width: BASIL_SPRITE[0]!.length,
  height: BASIL_SPRITE.length,
} as const

/**
 * CLI Home wordmark letters from `packages/tui/src/component/logo.tsx`.
 * Each character in the string represents a 1-pixel wide by 2-pixel tall cell:
 *   █ = both upper and lower pixels filled
 *   ▀ = upper pixel filled, lower empty
 *   ▄ = upper empty, lower pixel filled
 *   _ = both upper and lower pixels in shadow tone
 *   ^ = upper pixel filled, lower in shadow tone
 *   ~ = upper pixel in shadow tone, lower empty
 *
 * Line 0: Ascender of 'd' in code, and grave accent '\' over 'ù' (2 diagonal pixels).
 * Line 4: Descender of 'g' in ragù.
 */
export const CLI_LOGO_RAGU = [
  "                ▀▄ ", // row 0: grave accent over ù (col 16 top, col 17 bottom)
  "█▀▀▀ ▀▀▀█ █▀▀█ █  █", // row 1
  "█    █^^█ █__█ █__█", // row 2
  "▀    ▀▀▀▀ ▀▀▀█ ▀▀▀▀", // row 3
  "          ▀▀▀▀     ", // row 4
] as const

export const CLI_LOGO_CODE = [
  "             ▄     ", // row 0: ascender of 'd' (col 13 bottom)
  "█▀▀▀ █▀▀█ █▀▀█ █▀▀█", // row 1
  "█___ █__█ █__█ █^^^", // row 2
  "▀▀▀▀ ▀▀▀▀ ▀▀▀▀ ▀▀▀▀", // row 3
  "                   ", // row 4
] as const

/** Brand wordmark colors with 25% background-tinted shadow tones (from logo.tsx). */
export const WORDMARK_COLORS = {
  ragu: "#df4a2b",
  raguShadow: "#451c13", // 25% tint with ink #120d0b
  code: "#4f8a2e",
  codeShadow: "#212c14", // 25% tint with ink #120d0b
} as const

export const WORDMARK_NATIVE_WIDTH = 40 // 19 + 2 (gap) + 19
export const WORDMARK_NATIVE_HEIGHT = 10 // 5 lines * 2
export const WORDMARK_SCALE = 2
export const WORDMARK_WIDTH = WORDMARK_NATIVE_WIDTH * WORDMARK_SCALE // 80 px (50% of 160)
export const WORDMARK_HEIGHT = WORDMARK_NATIVE_HEIGHT * WORDMARK_SCALE // 20 px

function decodeCell(char: string, fg: string, shadow: string): [string, string] {
  switch (char) {
    case "█":
      return [fg, fg]
    case "▀":
      return [fg, ""]
    case "▄":
      return ["", fg]
    case "_":
      return [shadow, shadow]
    case "^":
      return [fg, shadow]
    case "~":
      return [shadow, ""]
    default:
      return ["", ""]
  }
}

/** Decodes the CLI logo into a 40x10 matrix of color hexes (or empty string for transparent). */
export function decodeCliWordmark(): string[][] {
  const grid: string[][] = Array.from({ length: WORDMARK_NATIVE_HEIGHT }, () =>
    Array.from({ length: WORDMARK_NATIVE_WIDTH }, () => ""),
  )

  for (let r = 0; r < 5; r++) {
    const yTop = r * 2
    const yBottom = r * 2 + 1
    const raguLine = CLI_LOGO_RAGU[r]!
    const codeLine = CLI_LOGO_CODE[r]!

    // Ragù (cols 0..18)
    for (let c = 0; c < 19; c++) {
      const [top, bottom] = decodeCell(raguLine[c]!, WORDMARK_COLORS.ragu, WORDMARK_COLORS.raguShadow)
      grid[yTop]![c] = top
      grid[yBottom]![c] = bottom
    }

    // Gap (cols 19..20) stays empty ""

    // Code (cols 21..39)
    for (let c = 0; c < 19; c++) {
      const [top, bottom] = decodeCell(codeLine[c]!, WORDMARK_COLORS.code, WORDMARK_COLORS.codeShadow)
      grid[yTop]![21 + c] = top
      grid[yBottom]![21 + c] = bottom
    }
  }

  return grid
}

export const WORDMARK_GRID = decodeCliWordmark()

export const WORDMARK_SIZE = {
  width: WORDMARK_WIDTH,
  height: WORDMARK_HEIGHT,
} as const
