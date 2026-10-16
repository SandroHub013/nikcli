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
  m: "#2d2722", // felpa ombra (from --ade-overlay dark)
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

/** Dimensions of the developer sprite poses. */
export const DEVELOPER_SPRITE_SIZE = { width: 20, height: 24 } as const

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
 * 8 poses of the pixel-art developer in chef hat and hoodie (20x24 pixels):
 * 0: Pronto - Standing ready, holding wooden ladle upright.
 * 1: Mescola sinistra - Leaning into pot, spoon stirring to the left.
 * 2: Mescola destra - Stirring to the right with swirl.
 * 3: Alza cucchiaio - Lifting spoon up toward face with glistening sauce drop.
 * 4: Assaggia - Tasting from spoon, eyes closed contentedly.
 * 5: Contento - Reacting happily, eyes sparkling, broad smile.
 * 6: Pollice in su - Proud thumbs-up to the user!
 * 7: Sorriso - Relaxed, confident chef smile.
 */
export const DEVELOPER_POSES: readonly (readonly string[])[] = [
  // 0: Pronto
  [
    "......ajjjja........",
    ".....aiiiiia........",
    "....aiiiiiia........",
    "....ajjjiiia........",
    "....aiiiiiia........",
    ".....aaaaaa.........",
    "....allllaa.........",
    "....ahhhaha.........",
    "....ahhhaha...k.....",
    "....aahaaha..kk.....",
    ".....aaaaa...ka.....",
    "....alllllla.ka.....",
    "....alllllla.ka.....",
    "....allmmlla.ka.....",
    "....allllllaka......",
    "....allllllaka......",
    "....allllllaa.......",
    "....allllllla.......",
    ".....aaaaaaa........",
    ".....alllla.........",
    ".....alllla.........",
    ".....alllla.........",
    ".....aaaaaa.........",
    "....................",
  ],
  // 1: Mescola sinistra (leaning into pot, ladle dipping left)
  [
    ".......ajjjja.......",
    "......aiiiiia.......",
    ".....aiiiiiia.......",
    ".....ajjjiiia.......",
    ".....aiiiiiia.......",
    "......aaaaaa........",
    ".....allllaa........",
    ".....ahhhaha........",
    ".....ahhhaha........",
    ".....aahaaha........",
    "......aaaaa.........",
    ".....allllllaa......",
    ".....allllllaa.k....",
    ".....allmmllla.kk...",
    ".....allllllla..ka..",
    ".....allllllllaka...",
    ".....alllllllla.ka..",
    ".....alllllllla..k..",
    "......aaaaaaaa......",
    "......alllla........",
    "......alllla........",
    "......alllla........",
    "......aaaaaa........",
    "....................",
  ],
  // 2: Mescola destra (ladle dipping right into pot)
  [
    ".......ajjjja.......",
    "......aiiiiia.......",
    ".....aiiiiiia.......",
    ".....ajjjiiia.......",
    ".....aiiiiiia.......",
    "......aaaaaa........",
    ".....allllaa........",
    ".....ahhhaha........",
    ".....ahhhaha........",
    ".....aahaaha........",
    "......aaaaa.........",
    ".....allllllaa......",
    ".....allllllaa..k...",
    ".....allmmllla...ka.",
    ".....allllllla...ka.",
    ".....allllllllaka...",
    ".....allllllla.kk...",
    ".....allllllla.ka...",
    "......aaaaaaaa......",
    "......alllla........",
    "......alllla........",
    "......alllla........",
    "......aaaaaa........",
    "....................",
  ],
  // 3: Alza cucchiaio (spoon lifted up toward mouth with sauce droplet)
  [
    "......ajjjja........",
    ".....aiiiiia........",
    "....aiiiiiia........",
    "....ajjjiiia........",
    "....aiiiiiia........",
    ".....aaaaaa.........",
    "....allllaa...kf....",
    "....ahhhaha..kkf....",
    "....ahhhaha..ka.....",
    "....aahaaha..ka.....",
    ".....aaaaa..ka......",
    "....allllllaka......",
    "....alllllllaa......",
    "....allmmlla........",
    "....allllllla.......",
    "....allllllla.......",
    "....allllllla.......",
    "....allllllla.......",
    ".....aaaaaaa........",
    ".....alllla.........",
    ".....alllla.........",
    ".....alllla.........",
    ".....aaaaaa.........",
    "....................",
  ],
  // 4: Assaggia (tasting from spoon, eyes closed ^_^)
  [
    "......ajjjja........",
    ".....aiiiiia........",
    "....aiiiiiia........",
    "....ajjjiiia........",
    "....aiiiiiia........",
    ".....aaaaaa.........",
    "....allllaa.........",
    "....ahhhaha.kf......",
    "....ahajahakkf......",
    "....aahaahaaka......",
    ".....aaaaa.ka.......",
    "....allllllaka......",
    "....alllllllaa......",
    "....allmmlla........",
    "....allllllla.......",
    "....allllllla.......",
    "....allllllla.......",
    "....allllllla.......",
    ".....aaaaaaa........",
    ".....alllla.........",
    ".....alllla.........",
    ".....alllla.........",
    ".....aaaaaa.........",
    "....................",
  ],
  // 5: Contento (delighted smile, sparkle in eyes)
  [
    "......ajjjja........",
    ".....aiiiiia........",
    "....aiiiiiia........",
    "....ajjjiiia........",
    "....aiiiiiia........",
    ".....aaaaaa.........",
    "....allllaa.........",
    "....ahjjaha.........",
    "....ahhhaha...k.....",
    "....aahaaha..kk.....",
    ".....aaaaa...ka.....",
    "....alllllla.ka.....",
    "....alllllla.ka.....",
    "....allmmlla.ka.....",
    "....allllllaka......",
    "....allllllaka......",
    "....allllllaa.......",
    "....allllllla.......",
    ".....aaaaaaa........",
    ".....alllla.........",
    ".....alllla.........",
    ".....alllla.........",
    ".....aaaaaa.........",
    "....................",
  ],
  // 6: Pollice in su (thumbs up 👍 held out proudly)
  [
    "......ajjjja........",
    ".....aiiiiia........",
    "....aiiiiiia........",
    "....ajjjiiia........",
    "....aiiiiiia........",
    ".....aaaaaa.........",
    "....allllaa.........",
    "....ahhhaha...h.....",
    "....ahhhaha..hh.....",
    "....aahaaha.hhha....",
    ".....aaaaa..aaaa....",
    "....allllllaaa......",
    "....allllllla.......",
    "....allmmlla.k......",
    "....allllllakk......",
    "....allllllaka......",
    "....allllllaa.......",
    "....allllllla.......",
    ".....aaaaaaa........",
    ".....alllla.........",
    ".....alllla.........",
    ".....alllla.........",
    ".....aaaaaa.........",
    "....................",
  ],
  // 7: Sorriso (relaxed friendly smile)
  [
    "......ajjjja........",
    ".....aiiiiia........",
    "....aiiiiiia........",
    "....ajjjiiia........",
    "....aiiiiiia........",
    ".....aaaaaa.........",
    "....allllaa.........",
    "....ahhhaha.........",
    "....ahhhaha...k.....",
    "....aahaaha..kk.....",
    ".....aaaaa...ka.....",
    "....alllllla.ka.....",
    "....alllllla.ka.....",
    "....allmmlla.ka.....",
    "....allllllaka......",
    "....allllllaka......",
    "....allllllaa.......",
    "....allllllla.......",
    ".....aaaaaaa........",
    ".....alllla.........",
    ".....alllla.........",
    ".....alllla.........",
    ".....aaaaaa.........",
    "....................",
  ],
] as const

/**
 * Pixel art wordmark matrix for "Ragù Code":
 * - "Ragù" in tomato red (`f`, `e`) with cream/panna highlights (`i`, `j`);
 * - Grave accent `\` on the `ù` letter clearly visible on rows 0 and 1;
 * - "Code" in basil green (`c`, `b`) with panna highlights (`j`);
 * - 64 columns x 9 rows.
 */
export const WORDMARK_MATRIX: readonly string[] = [
  // Row 0: grave accent top on ù (\ slant: col 23 is j)
  ".......................j........................................",
  // Row 1: grave accent bottom on ù (\ slant: col 24 is i)
  "........................i.......................................",
  // Row 2: top highlights
  ".jjfff...iiii...iiii...ii..ii......jjccc...cccc......c...cccc...",
  // Row 3: upper bodies
  ".ffffff.ffffff.ffffff..ffffff.....cccccc..cccccc....cc..cccccc..",
  // Row 4: mid bodies
  ".ffff.....ff...ff..ff..ff..ff.....cc......cc..cc...ccc..cccccc..",
  // Row 5: crossbars / bowls
  ".ffffff.ff..ff.ffffff..ff..ff.....cc......cc..cc..cccc..cc......",
  // Row 6: lower bodies
  ".ff..ff.ff..ff.....ff..ff..ff.....cc......cc..cc.cc.cc..cc......",
  // Row 7: letter bases
  ".ff..ff..fffff.ffffff...fffff.....cccccc..cccccc.cccccc.cccccc..",
  // Row 8: shadow undersides
  ".ee..ee...eeee.eeeeee...eeeee......bbbb....bbbb...bbbb...bbbb...",
] as const

export const WORDMARK_SIZE = {
  width: WORDMARK_MATRIX[0]!.length,
  height: WORDMARK_MATRIX.length,
} as const
