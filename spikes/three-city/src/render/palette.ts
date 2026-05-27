/**
 * 像素风调色板（A2 探针用）
 *
 * 故意不上美术资源——所有颜色程序化生成，便于快速调参。
 * 后期立项后会替换为真正的 tile atlas / 美术资源。
 *
 * 色彩思路：低饱和、暖底冷影，类似 "Tiny Glade" / "Mini Motorways" 的克制感。
 */

export const PALETTE = {
  // 地面（整体提亮一档，更接近日间草地）
  ground: 0x8aa56a,        // 草地（偏暖的明绿）
  groundAlt: 0x7a9560,     // 草地暗格（与主色差距收窄，避免棋盘感）
  road: 0x55555e,          // 沥青（提亮，避免一片死黑）
  roadStripe: 0xffd96a,    // 道路黄线（更鲜的暖黄）
  sidewalk: 0xb8b8a8,      // 人行道

  // 建筑：住宅（暖色系，整体提亮）
  residential: [
    0xe0825a,  // 砖红（提亮）
    0xefa97a,  // 杏色
    0xd06a5c,  // 深红
    0xf2c89a,  // 米黄
  ] as const,

  // 建筑：商业（中性偏冷，提亮）
  commercial: [
    0x8aabc6,  // 蓝灰
    0xa5bdd2,  // 浅蓝
    0x6a8aa6,  // 深蓝
  ] as const,

  // 建筑：工业（灰褐，提亮）
  industrial: [
    0x9a8870,  // 土黄
    0x8c7a64,  // 深土
    0xa89682,  // 浅褐
  ] as const,

  // 屋顶配色（与墙体反差，强化体积感）
  roofResidential: 0x4a3a36,  // 棕红屋顶
  roofCommercial: 0x3d4a58,   // 深蓝灰屋顶
  roofIndustrial: 0x554838,   // 深褐屋顶

  // 装饰
  treeLeaf: 0x6a8c4a,         // 树叶（提亮）
  treeTrunk: 0x6e5a3a,        // 树干
  window: 0xffe89a,           // 暖色窗光
} as const;

export type BuildingKind = 'residential' | 'commercial' | 'industrial';

export function pickWall(kind: BuildingKind, seed: number): number {
  const list = PALETTE[kind];
  return list[seed % list.length];
}

export function pickRoof(kind: BuildingKind): number {
  switch (kind) {
    case 'residential': return PALETTE.roofResidential;
    case 'commercial': return PALETTE.roofCommercial;
    case 'industrial': return PALETTE.roofIndustrial;
  }
}
