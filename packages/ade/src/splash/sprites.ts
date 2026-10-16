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
export const POT_SPRITE_SIZE = { width: 16, height: 16 } as const

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
    ".........g......",
    "......g...g.....",
    ".......g.g......",
    "......g..aa.....",
    ".....aaaacba....",
    "..aaafhffcfaaa..",
    ".aiiiiiiiiiiiia.",
    ".adddddddddddda.",
    "addffffffffffdda",
    ".aafhffffffffaa.",
    "..aeheeeeeeeea..",
    "..aefeeeeeeeea..",
    "..adddddddddda..",
    "...adddddddda...",
    "....aaaaaaaa....",
    "................",
  ],
  // Frame 1: Steam curling upward, bubble growing in sauce
  [
    "......g...g.....",
    ".......g...g....",
    "......g...g.....",
    ".....g...aa.....",
    ".....aaaacba....",
    "..aaaffhfecaaa..",
    ".aiiiiiiiiiiiia.",
    ".adddddddddddda.",
    "addffffffffffdda",
    ".aaffhfffffffaa.",
    "..aeheeeeeeeea..",
    "..aefeeeeeeeea..",
    "..adddddddddda..",
    "...adddddddda...",
    "....aaaaaaaa....",
    "................",
  ],
  // Frame 2: Lid bobs up 1px! Steam puffs out from boiling sauce!
  [
    "......g...g.....",
    ".....g...g..g...",
    "......g..aa..g..",
    ".....aaaacba....",
    "..aaafhjhfcfaaa.",
    ".afffhfffffffha.",
    ".aiiiiiiiiiiiia.",
    ".adddddddddddda.",
    "addffffffffffdda",
    ".aaffffffffhfaa.",
    "..aeheeeeeeeea..",
    "..aefeeeeeeeea..",
    "..adddddddddda..",
    "...adddddddda...",
    "....aaaaaaaa....",
    "................",
  ],
  // Frame 3: Lid settles back, pop of crema bubble
  [
    "....g.....g.....",
    ".....g...g......",
    "......g...g.....",
    "......g..aa.....",
    ".....aaaacba....",
    "..aaaffjfcfaaa..",
    ".aiiiiiiiiiiiia.",
    ".adddddddddddda.",
    "addffffffffffdda",
    ".aafhffffffffaa.",
    "..aeheeeeeeeea..",
    "..aefeeeeeeeea..",
    "..adddddddddda..",
    "...adddddddda...",
    "....aaaaaaaa....",
    "................",
  ],
  // Frame 4: Steam shifts right, bubbles form on body
  [
    ".........g......",
    "........g...g...",
    ".......g...g....",
    "......g..aa.....",
    ".....aaaacba....",
    "..aaafffhcfaaa..",
    ".aiiiiiiiiiiiia.",
    ".adddddddddddda.",
    "addffffffffffdda",
    ".aaffffhfffffaa.",
    "..aeheeeeeeeea..",
    "..aefeeeeeeeea..",
    "..adddddddddda..",
    "...adddddddda...",
    "....aaaaaaaa....",
    "................",
  ],
  // Frame 5: Double bubble in sauce, steam rising
  [
    ".......g..g.....",
    "......g....g....",
    ".....g....g.....",
    "......g..aa.....",
    ".....aaaacba....",
    "..aaafhfhfcaaa..",
    ".aiiiiiiiiiiiia.",
    ".adddddddddddda.",
    "addffffffffffdda",
    ".aafhffffhfffaa.",
    "..aeheeeeeeeea..",
    "..aefeeeeeeeea..",
    "..adddddddddda..",
    "...adddddddda...",
    "....aaaaaaaa....",
    "................",
  ],
  // Frame 6: Second lid bob & rattle, steam escaping
  [
    "......g...g.....",
    ".......g...g....",
    "......g..aa.g...",
    ".....aaaacba.g..",
    "..aaaffhfjcfaaa.",
    ".afffhffffffhfa.",
    ".aiiiiiiiiiiiia.",
    ".adddddddddddda.",
    "addffffffffffdda",
    ".aafffhffffhfaa.",
    "..aeheeeeeeeea..",
    "..aefeeeeeeeea..",
    "..adddddddddda..",
    "...adddddddda...",
    "....aaaaaaaa....",
    "................",
  ],
  // Frame 7: Settle and loop back smoothly
  [
    "........g.......",
    ".......g..g.....",
    "......g....g....",
    "......g..aa.....",
    ".....aaaacba....",
    "..aaaffhfcfaaa..",
    ".aiiiiiiiiiiiia.",
    ".adddddddddddda.",
    "addffffffffffdda",
    ".aafhffffffffaa.",
    "..aeheeeeeeeea..",
    "..aefeeeeeeeea..",
    "..adddddddddda..",
    "...adddddddda...",
    "....aaaaaaaa....",
    "................",
  ],
] as const

/** Dimensions of the human-scale developer sprite poses (2x height of pot). */
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
  // 0: Pronto - Standing ready, holding wooden ladle upright
  [
    ".......ajjjjjjjja...........",
    ".....aiijjjjjjjjiia.........",
    "....aiiiijjjjjjiiiia........",
    "....aiiiijjjjjjiiiia........",
    ".....aiiiiiiiiiiiia.........",
    "......aiiiiiiiiiia..........",
    "......aaaaaaaaaaaa..........",
    ".......alllllllla...........",
    "......alllllllaa............",
    "......aahhhhhhhaha..........",
    ".....ahhahahahaha...........",
    ".....ahhhahhhhhha.....k.....",
    ".....ahhhahaaahha....kk.....",
    "......aahhhhhhha.....ka.....",
    ".......allllllla.....ka.....",
    "......alllijllla.....ka.....",
    ".....allllijlllla....ka.....",
    "....alllllijllllla..aka.....",
    "....alllllljllllla..aka.....",
    "...allllaaaaalllllaaka......",
    "...alllaammmmaallllaa.......",
    "...alllaammmmaalllla........",
    "...allllaaaaallllla.........",
    "....alllllllllllla..........",
    "....alllllllllllla..........",
    ".....aaaaaaaaaaaa...........",
    "......allla.allla...........",
    "......allla.allla...........",
    "......allla.allla...........",
    "......allla.allla...........",
    "......allla.allla...........",
    "......allla.allla...........",
    "......aaaaa.aaaaa...........",
    "............................",
  ],
  // 1: Mescola sinistra - Leaning into pot, wooden ladle entering pot tilted left
  [
    "........ajjjjjjjja..........",
    "......aiijjjjjjjjiia........",
    ".....aiiiijjjjjjiiiia.......",
    ".....aiiiijjjjjjiiiia.......",
    "......aiiiiiiiiiiiia........",
    ".......aiiiiiiiiiia.........",
    ".......aaaaaaaaaaaa.........",
    "........alllllllla..........",
    ".......alllllllaa...........",
    ".......aahhhhhhhaha.........",
    "......ahhahahahaha..........",
    "......ahhhahhhhhha..........",
    "......ahhhahaaahha..........",
    ".......aahhhhhhha...........",
    "........allllllla...........",
    ".......alllijlllaa..........",
    "......allllijllllaa...kk....",
    ".....alllllijlllllaa..ka....",
    ".....alllllljlllllaa..ka....",
    "....allllaaaaallllla.kka....",
    "....alllaammmmaallllakka....",
    "....alllaammmmaallllaka.....",
    "....allllaaaaallllla.ka.....",
    ".....alllllllllllla..ka.....",
    ".....alllllllllllla...kf....",
    "......aaaaaaaaaaaa....kfa...",
    ".......allla.allla.....ka...",
    ".......allla.allla..........",
    ".......allla.allla..........",
    ".......allla.allla..........",
    ".......allla.allla..........",
    ".......allla.allla..........",
    ".......aaaaa.aaaaa..........",
    "............................",
  ],
  // 2: Mescola destra - Stirring to the right into the pot with sauce swirl
  [
    "........ajjjjjjjja..........",
    "......aiijjjjjjjjiia........",
    ".....aiiiijjjjjjiiiia.......",
    ".....aiiiijjjjjjiiiia.......",
    "......aiiiiiiiiiiiia........",
    ".......aiiiiiiiiiia.........",
    ".......aaaaaaaaaaaa.........",
    "........alllllllla..........",
    ".......alllllllaa...........",
    ".......aahhhhhhhaha.........",
    "......ahhahahahaha..........",
    "......ahhhahhhhhha..........",
    "......ahhhahaaahha..........",
    ".......aahhhhhhha...........",
    "........allllllla...........",
    ".......alllijlllaa..........",
    "......allllijllllaa....kk...",
    ".....alllllijlllllaa...ka...",
    ".....alllllljlllllaa...ka...",
    "....allllaaaaallllla..kka...",
    "....alllaammmmaallll..kfa...",
    "....alllaammmmaallllakka....",
    "....allllaaaaallllla.ka.....",
    ".....alllllllllllla..ka.....",
    ".....alllllllllllla...kf....",
    "......aaaaaaaaaaaa....kfa...",
    ".......allla.allla.....ka...",
    ".......allla.allla..........",
    ".......allla.allla..........",
    ".......allla.allla..........",
    ".......allla.allla..........",
    ".......allla.allla..........",
    ".......aaaaa.aaaaa..........",
    "............................",
  ],
  // 3: Alza cucchiaio - Lifting spoon up toward face with glistening sauce drop
  [
    ".......ajjjjjjjja...........",
    ".....aiijjjjjjjjiia.........",
    "....aiiiijjjjjjiiiia........",
    "....aiiiijjjjjjiiiia........",
    ".....aiiiiiiiiiiiia.........",
    "......aiiiiiiiiiia..........",
    "......aaaaaaaaaaaa..........",
    ".......alllllllla.....kf....",
    "......alllllllaa.....kkfa...",
    "......aahhhhhhhaha...ka.....",
    ".....ahhahahahaha...ka......",
    ".....ahhhahhhhhha..ka.......",
    ".....ahhhahaaahha.aka.......",
    "......aahhhhhhha.aka........",
    ".......allllllla.aka........",
    "......alllijlllaa...........",
    ".....allllijlllla...........",
    "....alllllijllllla..........",
    "....alllllljllllla..........",
    "...allllaaaaallllla.........",
    "...alllaammmmaallla.........",
    "...alllaammmmaallla.........",
    "...allllaaaaallllla.........",
    "....alllllllllllla..........",
    "....alllllllllllla..........",
    ".....aaaaaaaaaaaa...........",
    "......allla.allla...........",
    "......allla.allla...........",
    "......allla.allla...........",
    "......allla.allla...........",
    "......allla.allla...........",
    "......allla.allla...........",
    "......aaaaa.aaaaa...........",
    "............................",
  ],
  // 4: Assaggia - Spoon at mouth, head tilted, eyes closed tasting contentedly (^ ^)
  [
    ".......ajjjjjjjja...........",
    ".....aiijjjjjjjjiia.........",
    "....aiiiijjjjjjiiiia........",
    "....aiiiijjjjjjiiiia........",
    ".....aiiiiiiiiiiiia.........",
    "......aiiiiiiiiiia..........",
    "......aaaaaaaaaaaa..........",
    ".......alllllllla...........",
    "......alllllllaa............",
    "......aahhhhhhhaha..kf......",
    ".....ahhajajahaha..kkfa.....",
    ".....ahhhahhhhhha..ka.......",
    ".....ahhhahaaahha.aka.......",
    "......aahhhhhhha.aka........",
    ".......allllllla.aka........",
    "......alllijlllaa...........",
    ".....allllijlllla...........",
    "....alllllijllllla..........",
    "....alllllljllllla..........",
    "...allllaaaaallllla.........",
    "...alllaammmmaallla.........",
    "...alllaammmmaallla.........",
    "...allllaaaaallllla.........",
    "....alllllllllllla..........",
    "....alllllllllllla..........",
    ".....aaaaaaaaaaaa...........",
    "......allla.allla...........",
    "......allla.allla...........",
    "......allla.allla...........",
    "......allla.allla...........",
    "......allla.allla...........",
    "......allla.allla...........",
    "......aaaaa.aaaaa...........",
    "............................",
  ],
  // 5: Contento - Delighted smile, sparkling eyes, proud chest
  [
    ".......ajjjjjjjja...........",
    ".....aiijjjjjjjjiia.........",
    "....aiiiijjjjjjiiiia........",
    "....aiiiijjjjjjiiiia........",
    ".....aiiiiiiiiiiiia.........",
    "......aiiiiiiiiiia..........",
    "......aaaaaaaaaaaa..........",
    ".......alllllllla...........",
    "......alllllllaa............",
    "......aahhhhhhhaha..........",
    ".....ahjajahajaha...........",
    ".....ahhhahhhhhha.....k.....",
    ".....ahhhajjaahha....kk.....",
    "......aahhhhhhha.....ka.....",
    ".......allllllla.....ka.....",
    "......alllijllla.....ka.....",
    ".....allllijlllla....ka.....",
    "....alllllijllllla..aka.....",
    "....alllllljllllla..aka.....",
    "...allllaaaaalllllaaka......",
    "...alllaammmmaallllaa.......",
    "...alllaammmmaalllla........",
    "...allllaaaaallllla.........",
    "....alllllllllllla..........",
    "....alllllllllllla..........",
    ".....aaaaaaaaaaaa...........",
    "......allla.allla...........",
    "......allla.allla...........",
    "......allla.allla...........",
    "......allla.allla...........",
    "......allla.allla...........",
    "......allla.allla...........",
    "......aaaaa.aaaaa...........",
    "............................",
  ],
  // 6: Pollice in su - Proud thumbs-up 👍 to user, friendly smile
  [
    ".......ajjjjjjjja...........",
    ".....aiijjjjjjjjiia.........",
    "....aiiiijjjjjjiiiia........",
    "....aiiiijjjjjjiiiia........",
    ".....aiiiiiiiiiiiia.........",
    "......aiiiiiiiiiia..........",
    "......aaaaaaaaaaaa..........",
    ".......alllllllla...........",
    "......alllllllaa............",
    "......aahhhhhhhaha..........",
    ".....ahhahahahaha...........",
    ".....ahhhahhhhhha...........",
    ".....ahhhahaaahha....h......",
    "......aahhhhhhha....hh......",
    ".......allllllla...hhhha....",
    "......alllijllla..ahhhha....",
    ".....allllijlllla.aaaaaa....",
    "....alllllijllllla..........",
    "....alllllljllllla.k........",
    "...allllaaaaalllllak........",
    "...alllaammmmaallllka.......",
    "...alllaammmmaalllla........",
    "...allllaaaaallllla.........",
    "....alllllllllllla..........",
    "....alllllllllllla..........",
    ".....aaaaaaaaaaaa...........",
    "......allla.allla...........",
    "......allla.allla...........",
    "......allla.allla...........",
    "......allla.allla...........",
    "......allla.allla...........",
    "......allla.allla...........",
    "......aaaaa.aaaaa...........",
    "............................",
  ],
  // 7: Sorriso - Relaxed, confident chef smile
  [
    ".......ajjjjjjjja...........",
    ".....aiijjjjjjjjiia.........",
    "....aiiiijjjjjjiiiia........",
    "....aiiiijjjjjjiiiia........",
    ".....aiiiiiiiiiiiia.........",
    "......aiiiiiiiiiia..........",
    "......aaaaaaaaaaaa..........",
    ".......alllllllla...........",
    "......alllllllaa............",
    "......aahhhhhhhaha..........",
    ".....ahhahahahaha...........",
    ".....ahhhahhhhhha.....k.....",
    ".....ahhhahaaahha....kk.....",
    "......aahhhhhhha.....ka.....",
    ".......allllllla.....ka.....",
    "......alllijllla.....ka.....",
    ".....allllijlllla....ka.....",
    "....alllllijllllla..aka.....",
    "....alllllljllllla..aka.....",
    "...allllaaaaalllllaaka......",
    "...alllaammmmaallllaa.......",
    "...alllaammmmaalllla........",
    "...allllaaaaallllla.........",
    "....alllllllllllla..........",
    "....alllllllllllla..........",
    ".....aaaaaaaaaaaa...........",
    "......allla.allla...........",
    "......allla.allla...........",
    "......allla.allla...........",
    "......allla.allla...........",
    "......allla.allla...........",
    "......allla.allla...........",
    "......aaaaa.aaaaa...........",
    "............................",
  ],
] as const

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
 * Large pixel art wordmark for "Ragù Code" (100 columns x 14 rows, ~60% of canvas):
 * - Uppercase R and C (height 7-8 px);
 * - Lowercase a, g, d, e (ascender on d, descender on g);
 * - Clearly detached grave accent '\' over ù;
 * - Dark outlines 'a', glossy highlights 'j' / 'i';
 * - "Ragù" in tomato red ('f', 'e') and "Code" in basil green ('c', 'b').
 */
export const WORDMARK_MATRIX: readonly string[] = [
  // Row 0: grave accent top on ù (\ slant at cols 38..39)
  "......................................jj............................................................",
  // Row 1: grave accent bottom on ù (\ slant at cols 39..40)
  ".......................................ii...........................................................",
  // Row 2: empty breathing space under accent
  "....................................................................................................",
  // Row 3: caps top line (R, C) & ascender top of d
  ".aaaaaaa.............................................aaaaaaa................aaaaaa..................",
  // Row 4: caps upper body & ascender stem of d
  "aajjffffa...........................................aajjcccca..............aajjccca.................",
  // Row 5: lowercase tops (a, g, ù, o, e)
  "aaff..ffa......aaaaa......aaaaa......aaaa.aaaa......aacc...ca....aaaaa.....aacc...a......aaaaa......",
  // Row 6: upper letter bodies
  "aaffffffa.....aajfffa....aajfffa.....aaff.fffa......aacc........aajccca....aacc..cca....aajccca.....",
  // Row 7: crossbars of R, bowls of a, g, ù, C, o, d, e
  "aajjffffa.....aaffffa....aaffffa.....aaff.fffa......aacc........aacc.cca...aacc..cca....aaccccca....",
  // Row 8: lower letter bodies
  "aaff.fffa.....aa..ffa....aa..ffa.....aaff.fffa......aacc........aacc.cca...aacc..cca....aacc........",
  // Row 9: baseline with shadow tones e (Ragù) and b (Code)
  "aafe..eea.....aafeeea....aafeeea.....aajfeeeea......aajcbbca....aajcbca....aajcbbcca....aajcbca.....",
  // Row 10: bottom letter outline & top of g descender
  ".aaaaaaa......aaaaaaa....aaaaaaa.....aaaaaaa........aaaaaaa......aaaaa......aaaaaaa......aaaaa......",
  // Row 11: g descender stem
  "...........................afffa....................................................................",
  // Row 12: g descender loop
  ".........................aajfffa....................................................................",
  // Row 13: g descender bottom outline
  "..........................aaaaa.....................................................................",
] as const

export const WORDMARK_SIZE = {
  width: WORDMARK_MATRIX[0]!.length,
  height: WORDMARK_MATRIX.length,
} as const
